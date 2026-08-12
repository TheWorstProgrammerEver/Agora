create table public.membership_read_watermarks (
  membership_id uuid primary key
    references public.memberships(id) on delete cascade,
  sequence bigint not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint membership_read_watermarks_sequence_nonnegative check (sequence >= 0)
);

create function public.advance_message_sender_watermark()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sender_membership_id uuid;
begin
  select memberships.id
  into sender_membership_id
  from public.memberships
  where memberships.group_id = new.group_id
    and memberships.principal_id = new.sender_principal_id;

  if sender_membership_id is null then
    raise exception 'A message sender must remain an active group member.'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.membership_read_watermarks (membership_id, sequence)
  values (sender_membership_id, new.sequence)
  on conflict (membership_id) do update
  set sequence = greatest(
    membership_read_watermarks.sequence,
    excluded.sequence
  ),
  updated_at = case
    when excluded.sequence > membership_read_watermarks.sequence
      then clock_timestamp()
    else membership_read_watermarks.updated_at
  end;

  return new;
end;
$$;

create trigger advance_message_sender_watermark_after_insert
after insert on public.messages
for each row execute function public.advance_message_sender_watermark();

create function public.get_agora_group_messages(
  group_id_to_get uuid,
  after_sequence_to_use bigint default null,
  before_sequence_to_use bigint default null,
  around_sequence_to_use bigint default null,
  page_size integer default 50
)
returns table (
  message_id uuid,
  message_created_at timestamptz,
  message_group_id uuid,
  sender_principal_id uuid,
  sender_display_name text,
  sender_kind public.principal_kind,
  message_sequence text,
  message_text text,
  has_more boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
  requested_window_count integer;
  target_high_watermark bigint;
begin
  if caller_principal_id is null then
    raise exception 'An authenticated Agora principal is required.'
      using errcode = 'insufficient_privilege';
  end if;

  requested_window_count := num_nonnulls(
    after_sequence_to_use,
    before_sequence_to_use,
    around_sequence_to_use
  );

  if requested_window_count > 1
    or page_size is null
    or page_size < 1
    or page_size > 100
    or after_sequence_to_use < 0
    or before_sequence_to_use <= 0
    or around_sequence_to_use <= 0 then
    raise exception 'Message window parameters are invalid.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Message writes and membership transitions take this row FOR UPDATE. A
  -- read that queued behind either transition authorizes from the fresh state.
  select groups.last_message_sequence
  into target_high_watermark
  from public.groups
  where groups.id = group_id_to_get
  for share;

  if not found or not exists (
    select 1
    from public.memberships
    where memberships.group_id = group_id_to_get
      and memberships.principal_id = caller_principal_id
  ) then
    raise exception 'Only an active group member can read messages.'
      using errcode = 'insufficient_privilege';
  end if;

  if after_sequence_to_use > target_high_watermark
    or before_sequence_to_use > target_high_watermark
    or around_sequence_to_use > target_high_watermark then
    raise exception 'Message window sequence is outside this group.'
      using errcode = 'invalid_parameter_value';
  end if;

  if around_sequence_to_use is not null then
    if not exists (
      select 1
      from public.messages
      where messages.group_id = group_id_to_get
        and messages.sequence = around_sequence_to_use
    ) then
      raise exception 'The context message does not exist.'
        using errcode = 'invalid_parameter_value';
    end if;

    return query
    with earlier as materialized (
      select target.*
      from public.messages as target
      where target.group_id = group_id_to_get
        and target.sequence < around_sequence_to_use
      order by target.sequence desc
      limit page_size
    ),
    center as materialized (
      select target.*
      from public.messages as target
      where target.group_id = group_id_to_get
        and target.sequence = around_sequence_to_use
    ),
    later as materialized (
      select target.*
      from public.messages as target
      where target.group_id = group_id_to_get
        and target.sequence > around_sequence_to_use
      order by target.sequence
      limit page_size
    ),
    context_messages as (
      select * from earlier
      union all
      select * from center
      union all
      select * from later
    )
    select
      context_messages.id,
      context_messages.created_at,
      context_messages.group_id,
      context_messages.sender_principal_id,
      sender.display_name,
      sender.kind,
      context_messages.sequence::text,
      context_messages.text,
      false
    from context_messages
    join public.principals as sender
      on sender.id = context_messages.sender_principal_id
    order by context_messages.sequence;

    return;
  end if;

  if after_sequence_to_use is not null then
    return query
    with page_candidates as materialized (
      select target.*
      from public.messages as target
      where target.group_id = group_id_to_get
        and target.sequence > after_sequence_to_use
      order by target.sequence
      limit page_size + 1
    ),
    page_state as (
      select count(*) > page_size as has_more
      from page_candidates
    )
    select
      page_candidates.id,
      page_candidates.created_at,
      page_candidates.group_id,
      page_candidates.sender_principal_id,
      sender.display_name,
      sender.kind,
      page_candidates.sequence::text,
      page_candidates.text,
      page_state.has_more
    from page_candidates
    join public.principals as sender
      on sender.id = page_candidates.sender_principal_id
    cross join page_state
    order by page_candidates.sequence
    limit page_size;

    return;
  end if;

  return query
  with page_candidates as materialized (
    select target.*
    from public.messages as target
    where target.group_id = group_id_to_get
      and (
        before_sequence_to_use is null
        or target.sequence < before_sequence_to_use
      )
    order by target.sequence desc
    limit page_size + 1
  ),
  page_state as (
    select count(*) > page_size as has_more
    from page_candidates
  ),
  selected as (
    select *
    from page_candidates
    order by page_candidates.sequence desc
    limit page_size
  )
  select
    selected.id,
    selected.created_at,
    selected.group_id,
    selected.sender_principal_id,
    sender.display_name,
    sender.kind,
    selected.sequence::text,
    selected.text,
    page_state.has_more
  from selected
  join public.principals as sender
    on sender.id = selected.sender_principal_id
  cross join page_state
  order by selected.sequence;
end;
$$;

create function public.get_agora_unread_messages(
  group_id_to_get uuid,
  after_sequence_to_use bigint default null,
  page_size integer default 50
)
returns table (
  message_id uuid,
  message_created_at timestamptz,
  message_group_id uuid,
  sender_principal_id uuid,
  sender_display_name text,
  sender_kind public.principal_kind,
  message_sequence text,
  message_text text,
  has_more boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_membership_id uuid;
  caller_principal_id uuid := public.current_principal_id();
  effective_sequence bigint;
  target_high_watermark bigint;
begin
  if caller_principal_id is null then
    raise exception 'An authenticated Agora principal is required.'
      using errcode = 'insufficient_privilege';
  end if;

  if page_size is null
    or page_size < 1
    or page_size > 100
    or after_sequence_to_use < 0 then
    raise exception 'Unread message parameters are invalid.'
      using errcode = 'invalid_parameter_value';
  end if;

  select groups.last_message_sequence
  into target_high_watermark
  from public.groups
  where groups.id = group_id_to_get
  for share;

  if not found then
    raise exception 'Only an active group member can read unread messages.'
      using errcode = 'insufficient_privilege';
  end if;

  select memberships.id
  into caller_membership_id
  from public.memberships
  where memberships.group_id = group_id_to_get
    and memberships.principal_id = caller_principal_id;

  if caller_membership_id is null then
    raise exception 'Only an active group member can read unread messages.'
      using errcode = 'insufficient_privilege';
  end if;

  if after_sequence_to_use > target_high_watermark then
    raise exception 'Unread cursor is outside this group.'
      using errcode = 'invalid_parameter_value';
  end if;

  select greatest(
    coalesce(watermarks.sequence, 0),
    coalesce(after_sequence_to_use, 0)
  )
  into effective_sequence
  from (values (caller_membership_id)) as caller_membership(id)
  left join public.membership_read_watermarks as watermarks
    on watermarks.membership_id = caller_membership.id;

  return query
  with page_candidates as materialized (
    select target.*
    from public.messages as target
    where target.group_id = group_id_to_get
      and target.sequence > effective_sequence
    order by target.sequence
    limit page_size + 1
  ),
  page_state as (
    select count(*) > page_size as has_more
    from page_candidates
  )
  select
    page_candidates.id,
    page_candidates.created_at,
    page_candidates.group_id,
    page_candidates.sender_principal_id,
    sender.display_name,
    sender.kind,
    page_candidates.sequence::text,
    page_candidates.text,
    page_state.has_more
  from page_candidates
  join public.principals as sender
    on sender.id = page_candidates.sender_principal_id
  cross join page_state
  order by page_candidates.sequence
  limit page_size;
end;
$$;

create function public.mark_agora_group_read(
  group_id_to_mark uuid,
  through_sequence_to_use bigint
)
returns table (
  watermark_group_id uuid,
  watermark_sequence text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_membership_id uuid;
  caller_principal_id uuid := public.current_principal_id();
  stored_sequence bigint;
  target_high_watermark bigint;
begin
  if caller_principal_id is null then
    raise exception 'An authenticated Agora principal is required.'
      using errcode = 'insufficient_privilege';
  end if;

  if through_sequence_to_use is null or through_sequence_to_use <= 0 then
    raise exception 'Read watermark sequence is invalid.'
      using errcode = 'invalid_parameter_value';
  end if;

  select groups.last_message_sequence
  into target_high_watermark
  from public.groups
  where groups.id = group_id_to_mark
  for share;

  if not found then
    raise exception 'Only an active group member can mark this group read.'
      using errcode = 'insufficient_privilege';
  end if;

  select memberships.id
  into caller_membership_id
  from public.memberships
  where memberships.group_id = group_id_to_mark
    and memberships.principal_id = caller_principal_id;

  if caller_membership_id is null then
    raise exception 'Only an active group member can mark this group read.'
      using errcode = 'insufficient_privilege';
  end if;

  if through_sequence_to_use > target_high_watermark or not exists (
    select 1
    from public.messages
    where messages.group_id = group_id_to_mark
      and messages.sequence = through_sequence_to_use
  ) then
    raise exception 'Read watermark sequence is outside this group.'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.membership_read_watermarks (membership_id, sequence)
  values (caller_membership_id, through_sequence_to_use)
  on conflict (membership_id) do update
  set sequence = greatest(
    membership_read_watermarks.sequence,
    excluded.sequence
  ),
  updated_at = case
    when excluded.sequence > membership_read_watermarks.sequence
      then clock_timestamp()
    else membership_read_watermarks.updated_at
  end
  returning membership_read_watermarks.sequence into stored_sequence;

  return query
  select group_id_to_mark, stored_sequence::text;
end;
$$;

alter table public.membership_read_watermarks enable row level security;

create policy "Members can read their own watermark"
on public.membership_read_watermarks
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.memberships
    where memberships.id = membership_read_watermarks.membership_id
      and memberships.principal_id = public.current_principal_id()
  )
);

revoke all on table public.membership_read_watermarks from public, anon, authenticated;
revoke execute on function public.advance_message_sender_watermark()
  from public, anon, authenticated;
revoke execute on function public.get_agora_group_messages(uuid, bigint, bigint, bigint, integer)
  from public, anon, authenticated;
revoke execute on function public.get_agora_unread_messages(uuid, bigint, integer)
  from public, anon, authenticated;
revoke execute on function public.mark_agora_group_read(uuid, bigint)
  from public, anon, authenticated;

grant select on table public.membership_read_watermarks to anon, authenticated;
grant select, insert, update, delete on table public.membership_read_watermarks to service_role;
grant execute on function public.get_agora_group_messages(uuid, bigint, bigint, bigint, integer)
  to anon, authenticated;
grant execute on function public.get_agora_unread_messages(uuid, bigint, integer)
  to anon, authenticated;
grant execute on function public.mark_agora_group_read(uuid, bigint)
  to anon, authenticated;
