create type public.membership_role as enum ('owner', 'member');

create table public.groups (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  owner_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint groups_name_normalized check (name = trim(name)),
  constraint groups_name_length check (char_length(name) between 1 and 120)
);

create index groups_owner_principal_id_idx
  on public.groups (owner_principal_id);

create index groups_created_at_id_idx
  on public.groups (created_at desc, id desc);

create table public.memberships (
  id uuid primary key default extensions.gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  principal_id uuid not null references public.principals(id) on delete cascade,
  role public.membership_role not null default 'member',
  created_at timestamptz not null default now(),
  constraint memberships_group_principal_key unique (group_id, principal_id)
);

create unique index memberships_one_owner_per_group_idx
  on public.memberships (group_id)
  where role = 'owner'::public.membership_role;

create index memberships_principal_group_idx
  on public.memberships (principal_id, group_id);

create table public.invitations (
  id uuid primary key default extensions.gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  email text not null,
  group_name text not null,
  invited_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint invitations_email_length check (char_length(email) between 3 and 320),
  constraint invitations_email_normalized check (email = lower(trim(email))),
  constraint invitations_group_name_not_blank check (char_length(trim(group_name)) > 0),
  constraint invitations_group_email_key unique (group_id, email)
);

create index invitations_email_created_at_id_idx
  on public.invitations (email, created_at desc, id desc);

create index invitations_invited_by_principal_id_idx
  on public.invitations (invited_by_principal_id);

create function public.protect_human_group_owner_principal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.kind <> 'human'::public.principal_kind
    or new.auth_user_id is distinct from old.auth_user_id
  ) and exists (
    select 1
    from public.groups
    where owner_principal_id = old.id
  ) then
    raise exception 'A group owner must remain a human principal.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger protect_human_group_owner_principal_before_identity_update
before update of kind, auth_user_id on public.principals
for each row execute function public.protect_human_group_owner_principal();

create function public.enforce_human_group_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_kind public.principal_kind;
begin
  if tg_op = 'UPDATE' and new.owner_principal_id is distinct from old.owner_principal_id then
    raise exception 'Group ownership cannot be transferred in v1.'
      using errcode = 'check_violation';
  end if;

  -- Principal identity updates already hold a conflicting row lock.
  select kind
  into owner_kind
  from public.principals
  where id = new.owner_principal_id
  for share;

  if owner_kind is distinct from 'human'::public.principal_kind then
    raise exception 'A group owner must be a human principal.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger enforce_human_group_owner_before_write
before insert or update on public.groups
for each row execute function public.enforce_human_group_owner();

create function public.create_group_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.memberships (group_id, principal_id, role)
  values (new.id, new.owner_principal_id, 'owner'::public.membership_role);

  return new;
end;
$$;

create trigger create_group_owner_membership_after_insert
after insert on public.groups
for each row execute function public.create_group_owner_membership();

create function public.prepare_group_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  group_owner_principal_id uuid;
  member_email text;
begin
  -- Memberships take the same group lock before consuming an invitation.
  select owner_principal_id
  into group_owner_principal_id
  from public.groups
  where id = new.group_id
  for update;

  if group_owner_principal_id is null then
    raise exception 'A membership must reference an existing group.'
      using errcode = 'foreign_key_violation';
  end if;

  if (
    new.role = 'owner'::public.membership_role
  ) is distinct from (
    new.principal_id = group_owner_principal_id
  ) then
    raise exception 'The owner membership must match the group owner.'
      using errcode = 'check_violation';
  end if;

  if new.role = 'member'::public.membership_role then
    select lower(trim(users.email))
    into member_email
    from public.principals
    join auth.users
      on users.id = principals.auth_user_id
    where principals.id = new.principal_id
      and principals.kind = 'human'::public.principal_kind;

    if member_email is not null then
      delete from public.invitations
      where group_id = new.group_id
        and email = member_email;
    end if;
  end if;

  return new;
end;
$$;

create trigger prepare_group_membership_before_write
before insert or update on public.memberships
for each row execute function public.prepare_group_membership();

create function public.protect_group_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner'::public.membership_role and exists (
    select 1
    from public.groups
    where id = old.group_id
  ) then
    raise exception 'The group owner membership cannot be removed.'
      using errcode = 'check_violation';
  end if;

  return old;
end;
$$;

create trigger protect_group_owner_membership_before_delete
before delete on public.memberships
for each row execute function public.protect_group_owner_membership();

create function public.prepare_group_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_group_name text;
  target_owner_principal_id uuid;
begin
  -- Invitations take the same group lock before checking active membership.
  select name, owner_principal_id
  into target_group_name, target_owner_principal_id
  from public.groups
  where id = new.group_id
  for update;

  if target_owner_principal_id is null then
    raise exception 'An invitation must reference an existing group.'
      using errcode = 'foreign_key_violation';
  end if;

  if new.invited_by_principal_id <> target_owner_principal_id then
    raise exception 'Only the group owner can issue an invitation.'
      using errcode = 'check_violation';
  end if;

  new.email := lower(trim(new.email));
  new.group_name := target_group_name;

  if exists (
    select 1
    from public.memberships
    join public.principals
      on principals.id = memberships.principal_id
    join auth.users
      on users.id = principals.auth_user_id
    where memberships.group_id = new.group_id
      and principals.kind = 'human'::public.principal_kind
      and lower(trim(users.email)) = new.email
  ) then
    raise exception 'An active human member cannot also have a pending invitation.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger prepare_group_invitation_before_write
before insert or update on public.invitations
for each row execute function public.prepare_group_invitation();

create function public.current_human_principal_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id
  from public.principals
  where kind = 'human'::public.principal_kind
    and auth_user_id = auth.uid();
$$;

create function public.current_auth_email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(trim(coalesce(auth.jwt() ->> 'email', '')));
$$;

create function public.current_principal_is_group_member(group_id_to_check uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships
    where group_id = group_id_to_check
      and principal_id = public.current_human_principal_id()
  );
$$;

create function public.current_principal_owns_group(group_id_to_check uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.groups
    where id = group_id_to_check
      and owner_principal_id = public.current_human_principal_id()
  );
$$;

alter table public.groups enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;

create policy "Active members can read groups"
on public.groups
for select
to authenticated
using (public.current_principal_is_group_member(id));

create policy "Active members can read memberships"
on public.memberships
for select
to authenticated
using (public.current_principal_is_group_member(group_id));

create policy "Owners and invitees can read invitations"
on public.invitations
for select
to authenticated
using (
  email = public.current_auth_email()
  or public.current_principal_owns_group(group_id)
);

revoke all on table public.groups from anon, authenticated;
revoke all on table public.memberships from anon, authenticated;
revoke all on table public.invitations from anon, authenticated;

revoke execute on function public.enforce_human_group_owner() from public, anon, authenticated;
revoke execute on function public.protect_human_group_owner_principal() from public, anon, authenticated;
revoke execute on function public.create_group_owner_membership() from public, anon, authenticated;
revoke execute on function public.prepare_group_membership() from public, anon, authenticated;
revoke execute on function public.protect_group_owner_membership() from public, anon, authenticated;
revoke execute on function public.prepare_group_invitation() from public, anon, authenticated;
revoke execute on function public.current_human_principal_id() from public, anon, authenticated;
revoke execute on function public.current_auth_email() from public, anon, authenticated;
revoke execute on function public.current_principal_is_group_member(uuid) from public, anon, authenticated;
revoke execute on function public.current_principal_owns_group(uuid) from public, anon, authenticated;

grant usage on type public.membership_role to authenticated, service_role;
grant select on table public.groups to authenticated;
grant select on table public.memberships to authenticated;
grant select on table public.invitations to authenticated;
grant select, insert, update, delete on table public.groups to service_role;
grant select, insert, update, delete on table public.memberships to service_role;
grant select, insert, update, delete on table public.invitations to service_role;
grant execute on function public.current_auth_email() to authenticated;
grant execute on function public.current_principal_is_group_member(uuid) to authenticated;
grant execute on function public.current_principal_owns_group(uuid) to authenticated;
