create table public.agent_host_readiness_capabilities (
  id uuid primary key default extensions.gen_random_uuid(),
  agent_principal_id uuid not null references public.provisioned_agents(principal_id) on delete cascade,
  artifact_digest text not null,
  service_name text not null,
  operation text not null,
  host_checked_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint agent_host_readiness_artifact_digest check (
    artifact_digest collate "C" ~ '^[a-f0-9]{64}$'
  ),
  constraint agent_host_readiness_service_name check (
    service_name collate "C" ~ '^agora-agent-runner@[a-z_][a-z0-9_-]{0,30}\.service$'
  ),
  constraint agent_host_readiness_operation check (operation in ('install', 'recover', 'rotate')),
  constraint agent_host_readiness_lifecycle check (
    host_checked_at <= recorded_at
    and expires_at = host_checked_at + interval '15 minutes'
    and (consumed_at is null or consumed_at >= recorded_at)
  )
);

create index agent_host_readiness_principal_expiry_idx
  on public.agent_host_readiness_capabilities (agent_principal_id, expires_at desc);

create function public.prepare_agent_principal(display_name_to_use text)
returns table (
  agent_principal_id uuid,
  display_name text,
  prepared_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  generated_principal_id uuid;
  normalized_display_name text := trim(display_name_to_use);
  provisioned_at_to_return timestamptz;
begin
  if normalized_display_name is null
    or char_length(normalized_display_name) not between 1 and 120 then
    raise exception 'Agent display name must contain between 1 and 120 characters.'
      using errcode = 'check_violation';
  end if;

  insert into public.principals (kind, auth_user_id, display_name)
  values ('agent'::public.principal_kind, null, normalized_display_name)
  returning id into generated_principal_id;

  insert into public.provisioned_agents (principal_id)
  values (generated_principal_id)
  returning provisioned_at into provisioned_at_to_return;

  return query
  select generated_principal_id, normalized_display_name, provisioned_at_to_return;
end;
$$;

create function public.get_agent_provisioning_readiness(agent_principal_id_to_check uuid)
returns table (
  agent_principal_id uuid,
  display_name text,
  is_active boolean,
  authorized_group_count bigint,
  live_key_count bigint,
  active_key_count bigint,
  pending_rotation_count bigint,
  ready_for_initial_key boolean,
  ready_for_rotation boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    target.principal_id,
    principal.display_name,
    target.deactivated_at is null,
    count(distinct membership.group_id),
    count(distinct application_key.id) filter (
      where application_key.state <> 'revoked'::public.agent_application_key_state
    ),
    count(distinct application_key.id) filter (
      where application_key.state = 'active'::public.agent_application_key_state
    ),
    count(distinct application_key.id) filter (
      where application_key.state = 'pending_rotation'::public.agent_application_key_state
    ),
    target.deactivated_at is null
      and count(distinct membership.group_id) > 0
      and count(distinct application_key.id) filter (
        where application_key.state <> 'revoked'::public.agent_application_key_state
      ) = 0,
    target.deactivated_at is null
      and count(distinct membership.group_id) > 0
      and count(distinct application_key.id) filter (
        where application_key.state = 'active'::public.agent_application_key_state
      ) = 1
      and count(distinct application_key.id) filter (
        where application_key.state = 'pending_rotation'::public.agent_application_key_state
      ) = 0
  from public.provisioned_agents as target
  join public.principals as principal
    on principal.id = target.principal_id
  left join public.memberships as membership
    on membership.principal_id = target.principal_id
  left join public.agent_application_keys as application_key
    on application_key.agent_principal_id = target.principal_id
  where target.principal_id = agent_principal_id_to_check
    and principal.kind = 'agent'::public.principal_kind
    and principal.auth_user_id is null
  group by target.principal_id, principal.display_name, target.deactivated_at;
$$;

create function public.record_agent_host_readiness(
  agent_principal_id_to_check uuid,
  artifact_digest_to_check text,
  service_name_to_check text,
  operation_to_check text,
  host_checked_at timestamptz
)
returns table (
  readiness_capability_id uuid,
  agent_principal_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_key_count bigint;
  authorized_group_count bigint;
  capability_id uuid;
  checked_at timestamptz := host_checked_at;
  now_to_use timestamptz := clock_timestamp();
  pending_key_count bigint;
  target_agent public.provisioned_agents%rowtype;
begin
  if artifact_digest_to_check collate "C" !~ '^[a-f0-9]{64}$'
    or service_name_to_check collate "C" !~ '^agora-agent-runner@[a-z_][a-z0-9_-]{0,30}\.service$'
    or operation_to_check not in ('install', 'recover', 'rotate')
    or checked_at is null
    or checked_at > now_to_use
    or now_to_use - checked_at > interval '15 minutes' then
    raise exception 'Host readiness evidence is invalid or expired.'
      using errcode = 'check_violation';
  end if;

  select *
  into target_agent
  from public.provisioned_agents
  where principal_id = agent_principal_id_to_check
  for update;

  if not found or target_agent.deactivated_at is not null then
    raise exception 'Provisioned agent principal is unavailable.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select count(*)
  into authorized_group_count
  from public.memberships as membership
  where membership.principal_id = agent_principal_id_to_check;

  if authorized_group_count < 1 then
    raise exception 'Provisioned agent requires an authorized group before readiness.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select
    count(*) filter (where state = 'active'::public.agent_application_key_state),
    count(*) filter (where state = 'pending_rotation'::public.agent_application_key_state)
  into active_key_count, pending_key_count
  from public.agent_application_keys as application_key
  where application_key.agent_principal_id = agent_principal_id_to_check;

  if (
    operation_to_check = 'install'
    and exists (
      select 1
      from public.agent_application_keys as application_key
      where application_key.agent_principal_id = agent_principal_id_to_check
    )
  ) or (
    operation_to_check in ('recover', 'rotate')
    and (active_key_count <> 1 or pending_key_count <> 0)
  ) then
    raise exception 'Provisioned agent key state is not ready for the requested operation.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  insert into public.agent_host_readiness_capabilities (
    agent_principal_id,
    artifact_digest,
    service_name,
    operation,
    host_checked_at,
    recorded_at,
    expires_at
  )
  values (
    agent_principal_id_to_check,
    artifact_digest_to_check,
    service_name_to_check,
    operation_to_check,
    checked_at,
    now_to_use,
    checked_at + interval '15 minutes'
  )
  returning id into capability_id;

  return query
  select capability_id, agent_principal_id_to_check, checked_at + interval '15 minutes';
end;
$$;

create function public.issue_initial_agent_application_key(
  agent_principal_id_to_issue uuid,
  host_readiness_capability_id uuid
)
returns table (
  agent_principal_id uuid,
  application_key_id uuid,
  key_fingerprint text,
  issued_at timestamptz,
  application_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  generated_key text;
  generated_key_id uuid;
  readiness_capability public.agent_host_readiness_capabilities%rowtype;
  target_agent public.provisioned_agents%rowtype;
begin
  select *
  into target_agent
  from public.provisioned_agents
  where principal_id = agent_principal_id_to_issue
  for update;

  if not found then
    raise exception 'Provisioned agent principal does not exist.'
      using errcode = 'no_data_found';
  end if;

  if target_agent.deactivated_at is not null then
    raise exception 'Provisioned agent principal is inactive.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select *
  into readiness_capability
  from public.agent_host_readiness_capabilities as capability
  where capability.id = host_readiness_capability_id
    and capability.agent_principal_id = agent_principal_id_to_issue
    and capability.operation = 'install'
  for update;

  if not found
    or readiness_capability.consumed_at is not null
    or readiness_capability.expires_at < clock_timestamp() then
    raise exception 'Fresh principal-bound host readiness is required for key issuance.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  perform 1
  from public.memberships
  where principal_id = agent_principal_id_to_issue
  order by group_id
  for share;

  if not found then
    raise exception 'Provisioned agent requires an authorized group before key issuance.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if exists (
    select 1
    from public.agent_application_keys
    where agent_application_keys.agent_principal_id = agent_principal_id_to_issue
  ) then
    raise exception 'Provisioned agent already has application-key history.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.agent_host_readiness_capabilities
  set consumed_at = clock_timestamp()
  where id = readiness_capability.id;

  generated_key := public.generate_agent_application_key();

  insert into public.agent_application_keys (
    agent_principal_id,
    key_digest,
    state,
    activated_at
  )
  values (
    agent_principal_id_to_issue,
    public.agent_application_key_digest(generated_key),
    'active'::public.agent_application_key_state,
    now()
  )
  returning id into generated_key_id;

  return query
  select
    keys.agent_principal_id,
    keys.id,
    keys.fingerprint,
    keys.issued_at,
    generated_key
  from public.agent_application_keys as keys
  where keys.id = generated_key_id;
end;
$$;

alter function public.begin_agent_application_key_rotation(uuid)
  rename to begin_agent_application_key_rotation_unguarded;

revoke execute on function public.begin_agent_application_key_rotation_unguarded(uuid)
  from public, anon, authenticated, service_role;

create function public.begin_agent_application_key_rotation(
  agent_principal_id_to_rotate uuid,
  host_readiness_capability_id uuid
)
returns table (
  agent_principal_id uuid,
  application_key_id uuid,
  replaces_key_id uuid,
  key_fingerprint text,
  issued_at timestamptz,
  application_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  readiness_capability public.agent_host_readiness_capabilities%rowtype;
begin
  perform 1
  from public.provisioned_agents
  where principal_id = agent_principal_id_to_rotate
  for update;

  if not found then
    raise exception 'Provisioned agent principal does not exist.'
      using errcode = 'no_data_found';
  end if;

  select *
  into readiness_capability
  from public.agent_host_readiness_capabilities as capability
  where capability.id = host_readiness_capability_id
    and capability.agent_principal_id = agent_principal_id_to_rotate
    and capability.operation in ('recover', 'rotate')
  for update;

  if not found
    or readiness_capability.consumed_at is not null
    or readiness_capability.expires_at < clock_timestamp() then
    raise exception 'Fresh principal-bound host readiness is required for key rotation.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  perform 1
  from public.memberships
  where principal_id = agent_principal_id_to_rotate
  order by group_id
  for share;

  if not found then
    raise exception 'Provisioned agent requires an authorized group before key rotation.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.agent_host_readiness_capabilities
  set consumed_at = clock_timestamp()
  where id = readiness_capability.id;

  return query
  select *
  from public.begin_agent_application_key_rotation_unguarded(agent_principal_id_to_rotate);
end;
$$;

alter table public.agent_host_readiness_capabilities enable row level security;

revoke all on table public.agent_host_readiness_capabilities
  from public, anon, authenticated, service_role;
revoke execute on function public.provision_agent_principal(text) from service_role;
revoke execute on function public.prepare_agent_principal(text) from public, anon, authenticated;
revoke execute on function public.get_agent_provisioning_readiness(uuid) from public, anon, authenticated;
revoke execute on function public.record_agent_host_readiness(uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.issue_initial_agent_application_key(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.begin_agent_application_key_rotation(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.prepare_agent_principal(text) to service_role;
grant execute on function public.get_agent_provisioning_readiness(uuid) to service_role;
grant execute on function public.record_agent_host_readiness(uuid, text, text, text, timestamptz)
  to service_role;
grant execute on function public.issue_initial_agent_application_key(uuid, uuid) to service_role;
grant execute on function public.begin_agent_application_key_rotation(uuid, uuid) to service_role;
