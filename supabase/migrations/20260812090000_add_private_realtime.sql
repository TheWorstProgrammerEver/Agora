do $role$
begin
  if not exists (
    select 1
    from pg_roles
    where rolname = 'agora_realtime_agent'
  ) then
    create role agora_realtime_agent;
  end if;
end;
$role$;

alter role agora_realtime_agent
  nologin
  inherit
  nocreatedb
  nocreaterole;

do $role_safety$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'agora_realtime_agent'
      and (rolsuper or rolreplication or rolbypassrls)
  ) then
    raise exception 'The Agora Realtime role has unsafe database attributes.';
  end if;
end;
$role_safety$;

grant agora_realtime_agent to authenticator;
grant authenticated to agora_realtime_agent;

do $membership_safety$
begin
  if exists (
    select 1
    from pg_auth_members
    join pg_roles as member on member.oid = pg_auth_members.member
    join pg_roles as granted on granted.oid = pg_auth_members.roleid
    where member.rolname = 'agora_realtime_agent'
      and granted.rolname <> 'authenticated'
  ) then
    raise exception 'The Agora Realtime role has an unsafe inherited role.';
  end if;
end;
$membership_safety$;

create schema agora_realtime;
revoke all on schema agora_realtime from public;

create function agora_realtime.topic_group_id(topic_to_parse text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if topic_to_parse is null or topic_to_parse !~ (
    '^agora:group:'
    || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    return null;
  end if;

  return substring(topic_to_parse from 13)::uuid;
end;
$$;

create function agora_realtime.current_claims()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb;
$$;

create or replace function public.current_principal_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when agora_realtime.current_claims() ->> 'agora_token_kind' = 'realtime'
      or agora_realtime.current_claims() ->> 'role' = 'agora_realtime_agent'
      then null
    when auth.uid() is not null then public.current_human_principal_id()
    else public.current_agent_principal_id()
  end;
$$;

create function agora_realtime.human_can_receive_topic(topic_to_authorize text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  group_id_to_authorize uuid := agora_realtime.topic_group_id(topic_to_authorize);
begin
  if group_id_to_authorize is null or auth.uid() is null then
    return false;
  end if;

  return exists (
    select 1
    from public.memberships
    join public.principals
      on principals.id = memberships.principal_id
    where memberships.group_id = group_id_to_authorize
      and principals.kind = 'human'::public.principal_kind
      and principals.auth_user_id = auth.uid()
  );
end;
$$;

create function agora_realtime.agent_can_receive_topic(topic_to_authorize text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb := agora_realtime.current_claims();
  group_id_to_authorize uuid := agora_realtime.topic_group_id(topic_to_authorize);
  principal_id_text text := claims ->> 'agora_principal_id';
  principal_id_to_authorize uuid;
begin
  if group_id_to_authorize is null
    or claims ->> 'agora_token_kind' is distinct from 'realtime'
    or claims ->> 'role' is distinct from 'agora_realtime_agent'
    or claims ->> 'sub' is distinct from principal_id_text
    or principal_id_text is null
    or principal_id_text !~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    or jsonb_typeof(claims -> 'agora_realtime_topics') is distinct from 'array'
    or not ((claims -> 'agora_realtime_topics') ? group_id_to_authorize::text) then
    return false;
  end if;

  principal_id_to_authorize := principal_id_text::uuid;

  return exists (
    select 1
    from public.memberships
    join public.principals
      on principals.id = memberships.principal_id
    join public.provisioned_agents
      on provisioned_agents.principal_id = principals.id
    where memberships.group_id = group_id_to_authorize
      and memberships.principal_id = principal_id_to_authorize
      and principals.kind = 'agent'::public.principal_kind
      and principals.auth_user_id is null
      and provisioned_agents.deactivated_at is null
  );
end;
$$;

create policy "Human members can receive Agora availability"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and agora_realtime.human_can_receive_topic(realtime.topic())
);

create policy "Agent members can receive Agora availability"
on realtime.messages
for select
to agora_realtime_agent
using (
  realtime.messages.extension = 'broadcast'
  and agora_realtime.agent_can_receive_topic(realtime.topic())
);

grant usage on schema agora_realtime to authenticated, agora_realtime_agent;
grant execute on function agora_realtime.human_can_receive_topic(text) to authenticated;
grant execute on function agora_realtime.agent_can_receive_topic(text)
  to agora_realtime_agent;

revoke execute on function agora_realtime.topic_group_id(text)
  from public, anon, authenticated, agora_realtime_agent;
revoke execute on function agora_realtime.current_claims()
  from public, anon, authenticated, agora_realtime_agent;
revoke execute on function agora_realtime.human_can_receive_topic(text)
  from public, anon, agora_realtime_agent;
revoke execute on function agora_realtime.agent_can_receive_topic(text)
  from public, anon, authenticated;

create function public.authorize_agora_realtime_topics(
  group_ids_to_authorize uuid[]
)
returns table (
  topic_group_id uuid,
  high_watermark_sequence text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
  locked_group_count integer := 0;
  requested_group_count integer := cardinality(group_ids_to_authorize);
begin
  if caller_principal_id is null
    or requested_group_count is null
    or requested_group_count < 1
    or requested_group_count > 32
    or exists (
      select 1
      from unnest(group_ids_to_authorize) as requested(group_id)
      where requested.group_id is null
    )
    or requested_group_count <> (
      select count(distinct requested.group_id)
      from unnest(group_ids_to_authorize) as requested(group_id)
    ) then
    raise exception 'Realtime session parameters are invalid.'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*)
  into locked_group_count
  from (
    select groups.id
    from public.groups
    where groups.id = any(group_ids_to_authorize)
    order by groups.id
    for share
  ) as locked_groups;

  if locked_group_count <> requested_group_count or exists (
    select 1
    from unnest(group_ids_to_authorize) as requested(group_id)
    where not exists (
      select 1
      from public.memberships
      where memberships.group_id = requested.group_id
        and memberships.principal_id = caller_principal_id
    )
  ) then
    raise exception 'Only active group members can create Realtime sessions.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    groups.id,
    groups.last_message_sequence::text
  from public.groups
  where groups.id = any(group_ids_to_authorize)
  order by groups.id;
end;
$$;

revoke execute on function public.authorize_agora_realtime_topics(uuid[])
  from public, anon, authenticated;
grant execute on function public.authorize_agora_realtime_topics(uuid[])
  to anon, authenticated;

create function public.broadcast_agora_message_availability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'groupId', new.group_id::text,
      'highWatermarkSequence', new.sequence::text
    ),
    'message_available',
    'agora:group:' || new.group_id::text,
    true
  );

  return null;
end;
$$;

create trigger broadcast_agora_message_availability_after_insert
after insert on public.messages
for each row execute function public.broadcast_agora_message_availability();

revoke execute on function public.broadcast_agora_message_availability()
  from public, anon, authenticated;
