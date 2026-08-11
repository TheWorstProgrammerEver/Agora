create function public.create_agora_group(name_to_use text)
returns table (
  id uuid,
  created_at timestamptz,
  name text,
  owner_principal_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
  normalized_name text := trim(coalesce(name_to_use, ''));
begin
  if not exists (
    select 1
    from public.principals
    where principals.id = caller_principal_id
      and principals.kind = 'human'::public.principal_kind
      and principals.auth_user_id = auth.uid()
  ) then
    raise exception 'Only a human principal can create a group.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  insert into public.groups (name, owner_principal_id)
  values (normalized_name, caller_principal_id)
  returning groups.id, groups.created_at, groups.name, groups.owner_principal_id;
end;
$$;

create function public.list_agora_groups(
  cursor_created_at timestamptz default null,
  cursor_group_id uuid default null,
  page_size integer default 50
)
returns table (
  id uuid,
  created_at timestamptz,
  name text,
  owner_principal_id uuid,
  unread_count bigint,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
begin
  if caller_principal_id is null then
    raise exception 'An authenticated Agora principal is required.'
      using errcode = 'insufficient_privilege';
  end if;

  if (cursor_created_at is null) is distinct from (cursor_group_id is null) then
    raise exception 'A complete group cursor is required.'
      using errcode = 'invalid_parameter_value';
  end if;

  if page_size is null or page_size < 1 or page_size > 100 then
    raise exception 'Group page size must be between 1 and 100.'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with page_candidates as materialized (
    select target.id, target.created_at, target.name, target.owner_principal_id
    from public.groups as target
    join public.memberships
      on memberships.group_id = target.id
    where memberships.principal_id = caller_principal_id
      and (
        cursor_created_at is null
        or (target.created_at, target.id) < (cursor_created_at, cursor_group_id)
      )
    order by target.created_at desc, target.id desc
    limit page_size + 1
  ),
  page_state as (
    select count(*) > page_size as has_more
    from page_candidates
  )
  select
    page_candidates.id,
    page_candidates.created_at,
    page_candidates.name,
    page_candidates.owner_principal_id,
    -- Read-state tables land later; the pre-message state is explicitly zero.
    0::bigint as unread_count,
    page_state.has_more
  from page_candidates
  cross join page_state
  order by page_candidates.created_at desc, page_candidates.id desc
  limit page_size;
end;
$$;

create function public.get_agora_group(group_id_to_get uuid)
returns table (
  group_id uuid,
  group_created_at timestamptz,
  group_name text,
  owner_principal_id uuid,
  membership_created_at timestamptz,
  membership_role public.membership_role,
  principal_id uuid,
  principal_display_name text,
  principal_kind public.principal_kind
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
begin
  if caller_principal_id is null then
    raise exception 'An authenticated Agora principal is required.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    groups.id,
    groups.created_at,
    groups.name,
    groups.owner_principal_id,
    memberships.created_at,
    memberships.role,
    principals.id,
    principals.display_name,
    principals.kind
  from public.groups
  join public.memberships
    on memberships.group_id = groups.id
    and memberships.principal_id = caller_principal_id
  join public.principals
    on principals.id = memberships.principal_id
  where groups.id = group_id_to_get;
end;
$$;

create function public.delete_agora_group(group_id_to_delete uuid)
returns table (group_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
begin
  if not exists (
    select 1
    from public.principals
    where principals.id = caller_principal_id
      and principals.kind = 'human'::public.principal_kind
      and principals.auth_user_id = auth.uid()
  ) then
    raise exception 'Only a human group owner can delete a group.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  delete from public.groups
  where groups.id = group_id_to_delete
    and groups.owner_principal_id = caller_principal_id
  returning groups.id;

  if not found then
    raise exception 'Only the group owner can delete this group.'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke execute on function public.create_agora_group(text) from public, anon, authenticated;
revoke execute on function public.list_agora_groups(timestamptz, uuid, integer) from public, anon, authenticated;
revoke execute on function public.get_agora_group(uuid) from public, anon, authenticated;
revoke execute on function public.delete_agora_group(uuid) from public, anon, authenticated;

grant execute on function public.create_agora_group(text) to authenticated;
grant execute on function public.list_agora_groups(timestamptz, uuid, integer) to anon, authenticated;
grant execute on function public.get_agora_group(uuid) to anon, authenticated;
grant execute on function public.delete_agora_group(uuid) to authenticated;
