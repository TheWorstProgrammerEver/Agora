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
  ready_for_initial_key boolean
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
    target.deactivated_at is null
      and count(distinct membership.group_id) > 0
      and count(distinct application_key.id) filter (
        where application_key.state <> 'revoked'::public.agent_application_key_state
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

create function public.issue_initial_agent_application_key(
  agent_principal_id_to_issue uuid
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

revoke execute on function public.provision_agent_principal(text) from service_role;
revoke execute on function public.prepare_agent_principal(text) from public, anon, authenticated;
revoke execute on function public.get_agent_provisioning_readiness(uuid) from public, anon, authenticated;
revoke execute on function public.issue_initial_agent_application_key(uuid) from public, anon, authenticated;

grant execute on function public.prepare_agent_principal(text) to service_role;
grant execute on function public.get_agent_provisioning_readiness(uuid) to service_role;
grant execute on function public.issue_initial_agent_application_key(uuid) to service_role;
