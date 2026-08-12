create or replace function public.list_agora_groups(
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
    select
      target.id,
      target.created_at,
      target.name,
      target.owner_principal_id,
      greatest(
        target.last_message_sequence - coalesce(watermarks.sequence, 0),
        0
      ) as unread_count
    from public.groups as target
    join public.memberships
      on memberships.group_id = target.id
      and memberships.principal_id = caller_principal_id
    left join public.membership_read_watermarks as watermarks
      on watermarks.membership_id = memberships.id
    where cursor_created_at is null
      or (target.created_at, target.id) < (cursor_created_at, cursor_group_id)
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
    page_candidates.unread_count,
    page_state.has_more
  from page_candidates
  cross join page_state
  order by page_candidates.created_at desc, page_candidates.id desc
  limit page_size;
end;
$$;
