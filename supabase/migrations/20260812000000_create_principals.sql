create extension if not exists pgcrypto with schema extensions;

create type public.principal_kind as enum ('human', 'agent');

create table public.principals (
  id uuid primary key default extensions.gen_random_uuid(),
  kind public.principal_kind not null,
  auth_user_id uuid references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint principals_display_name_not_blank check (length(trim(display_name)) > 0),
  constraint principals_kind_linkage check (
    (kind = 'human'::public.principal_kind and auth_user_id is not null)
    or (kind = 'agent'::public.principal_kind and auth_user_id is null)
  )
);

create unique index principals_auth_user_id_key
  on public.principals (auth_user_id)
  where auth_user_id is not null;

create or replace function public.create_human_principal_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  display_name text;
begin
  display_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Agora user'
  );

  insert into public.principals (kind, auth_user_id, display_name)
  values ('human'::public.principal_kind, new.id, display_name);

  return new;
end;
$$;

create trigger create_human_principal_after_auth_user_insert
after insert on auth.users
for each row execute function public.create_human_principal_for_auth_user();

alter table public.principals enable row level security;

create policy "Humans can read their own principal"
on public.principals
for select
to authenticated
using (
  kind = 'human'::public.principal_kind
  and auth_user_id = (select auth.uid())
);

revoke all on table public.principals from anon, authenticated;
revoke execute on function public.create_human_principal_for_auth_user() from public, anon, authenticated;

grant usage on schema public to authenticated, service_role;
grant usage on type public.principal_kind to authenticated, service_role;
grant select on table public.principals to authenticated;
grant select, insert, update, delete on table public.principals to service_role;
