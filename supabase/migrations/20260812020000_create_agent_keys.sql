create type public.agent_application_key_state as enum (
  'active',
  'pending_rotation',
  'revoked'
);

create table public.provisioned_agents (
  principal_id uuid primary key references public.principals(id) on delete cascade,
  provisioned_at timestamptz not null default now(),
  deactivated_at timestamptz,
  deactivation_reason text,
  constraint provisioned_agents_deactivation_metadata check (
    (deactivated_at is null and deactivation_reason is null)
    or (
      deactivated_at is not null
      and char_length(trim(deactivation_reason)) between 1 and 200
    )
  )
);

create table public.agent_application_keys (
  id uuid primary key default extensions.gen_random_uuid(),
  agent_principal_id uuid not null references public.provisioned_agents(principal_id) on delete cascade,
  key_digest bytea not null unique,
  fingerprint text generated always as (
    'sha256:' || left(encode(key_digest, 'hex'), 16)
  ) stored,
  state public.agent_application_key_state not null,
  issued_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  replaces_key_id uuid,
  rotation_completed_at timestamptz,
  constraint agent_application_keys_id_principal_key unique (id, agent_principal_id),
  constraint agent_application_keys_replacement_principal_fkey foreign key (
    replaces_key_id,
    agent_principal_id
  ) references public.agent_application_keys (id, agent_principal_id) on delete restrict,
  constraint agent_application_keys_digest_length check (octet_length(key_digest) = 32),
  constraint agent_application_keys_not_self_replacing check (replaces_key_id is distinct from id),
  constraint agent_application_keys_lifecycle check (
    (
      state = 'active'::public.agent_application_key_state
      and activated_at is not null
      and revoked_at is null
      and revoked_reason is null
    )
    or (
      state = 'pending_rotation'::public.agent_application_key_state
      and replaces_key_id is not null
      and activated_at is null
      and revoked_at is null
      and revoked_reason is null
      and rotation_completed_at is null
    )
    or (
      state = 'revoked'::public.agent_application_key_state
      and revoked_at is not null
      and char_length(trim(revoked_reason)) between 1 and 200
    )
  ),
  constraint agent_application_keys_rotation_metadata check (
    rotation_completed_at is null
    or (
      replaces_key_id is not null
      and activated_at is not null
      and rotation_completed_at = activated_at
    )
  )
);

create unique index agent_application_keys_one_active_per_principal_idx
  on public.agent_application_keys (agent_principal_id)
  where state = 'active'::public.agent_application_key_state;

create unique index agent_application_keys_one_pending_rotation_per_principal_idx
  on public.agent_application_keys (agent_principal_id)
  where state = 'pending_rotation'::public.agent_application_key_state;

create unique index agent_application_keys_one_completed_replacement_idx
  on public.agent_application_keys (replaces_key_id)
  where rotation_completed_at is not null;

create index agent_application_keys_agent_issued_idx
  on public.agent_application_keys (agent_principal_id, issued_at desc, id desc);

create function public.enforce_provisioned_agent_principal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  principal_kind public.principal_kind;
  principal_auth_user_id uuid;
begin
  select kind, auth_user_id
  into principal_kind, principal_auth_user_id
  from public.principals
  where id = new.principal_id
  for share;

  if principal_kind is distinct from 'agent'::public.principal_kind
    or principal_auth_user_id is not null then
    raise exception 'A provisioned agent must reference an unlinked agent principal.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger enforce_provisioned_agent_principal_before_write
before insert or update on public.provisioned_agents
for each row execute function public.enforce_provisioned_agent_principal();

create function public.protect_provisioned_agent_principal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.kind <> 'agent'::public.principal_kind
    or new.auth_user_id is not null
  ) and exists (
    select 1
    from public.provisioned_agents
    where principal_id = old.id
  ) then
    raise exception 'A provisioned agent must remain an unlinked agent principal.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger protect_provisioned_agent_principal_before_identity_update
before update of kind, auth_user_id on public.principals
for each row execute function public.protect_provisioned_agent_principal();

create function public.agent_application_key_is_well_formed(application_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select application_key collate "C" ~ '^agora_agent_v1_[A-Za-z0-9_-]{43}$';
$$;

create function public.agent_application_key_digest(application_key text)
returns bytea
language sql
immutable
strict
set search_path = ''
as $$
  select extensions.digest(convert_to(application_key, 'UTF8'), 'sha256');
$$;

create function public.generate_agent_application_key()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'agora_agent_v1_' || translate(
    rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='),
    '+/',
    '-_'
  );
$$;

create function public.provision_agent_principal(display_name_to_use text)
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
  generated_principal_id uuid;
  normalized_display_name text := trim(display_name_to_use);
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
  values (generated_principal_id);

  generated_key := public.generate_agent_application_key();

  insert into public.agent_application_keys (
    agent_principal_id,
    key_digest,
    state,
    activated_at
  )
  values (
    generated_principal_id,
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

create function public.begin_agent_application_key_rotation(agent_principal_id_to_rotate uuid)
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
  active_key_id uuid;
  generated_key text;
  generated_key_id uuid;
  provisioned_agent public.provisioned_agents%rowtype;
begin
  select *
  into provisioned_agent
  from public.provisioned_agents
  where principal_id = agent_principal_id_to_rotate
  for update;

  if not found or provisioned_agent.deactivated_at is not null then
    raise exception 'Agent principal is not active.'
      using errcode = 'invalid_authorization_specification';
  end if;

  select id
  into active_key_id
  from public.agent_application_keys as keys
  where keys.agent_principal_id = agent_principal_id_to_rotate
    and keys.state = 'active'::public.agent_application_key_state
  for update;

  if active_key_id is null then
    raise exception 'Agent principal has no active key to rotate.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if exists (
    select 1
    from public.agent_application_keys as keys
    where keys.agent_principal_id = agent_principal_id_to_rotate
      and keys.state = 'pending_rotation'::public.agent_application_key_state
  ) then
    raise exception 'Agent principal already has a pending key rotation.'
      using errcode = 'object_in_use';
  end if;

  generated_key := public.generate_agent_application_key();

  insert into public.agent_application_keys (
    agent_principal_id,
    key_digest,
    state,
    replaces_key_id
  )
  values (
    agent_principal_id_to_rotate,
    public.agent_application_key_digest(generated_key),
    'pending_rotation'::public.agent_application_key_state,
    active_key_id
  )
  returning id into generated_key_id;

  return query
  select
    keys.agent_principal_id,
    keys.id,
    keys.replaces_key_id,
    keys.fingerprint,
    keys.issued_at,
    generated_key
  from public.agent_application_keys as keys
  where keys.id = generated_key_id;
end;
$$;

create function public.complete_agent_application_key_rotation(
  replacement_key_id uuid,
  validated_fingerprint text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  completed_at timestamptz := clock_timestamp();
  previous_key public.agent_application_keys%rowtype;
  replacement_key public.agent_application_keys%rowtype;
begin
  select *
  into replacement_key
  from public.agent_application_keys
  where id = replacement_key_id
  for update;

  if not found
    or replacement_key.state <> 'pending_rotation'::public.agent_application_key_state
    or replacement_key.replaces_key_id is null
    or replacement_key.fingerprint is distinct from validated_fingerprint then
    raise exception 'Replacement key is not a validated pending rotation.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select *
  into previous_key
  from public.agent_application_keys
  where id = replacement_key.replaces_key_id
  for update;

  if not found
    or previous_key.agent_principal_id <> replacement_key.agent_principal_id
    or previous_key.state <> 'active'::public.agent_application_key_state then
    raise exception 'The key being replaced is not active for this agent.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.agent_application_keys
  set
    state = 'revoked'::public.agent_application_key_state,
    revoked_at = completed_at,
    revoked_reason = 'rotated'
  where id = previous_key.id;

  update public.agent_application_keys
  set
    state = 'active'::public.agent_application_key_state,
    activated_at = completed_at,
    rotation_completed_at = completed_at
  where id = replacement_key.id;
end;
$$;

create function public.rollback_agent_application_key_rotation(replacement_key_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.agent_application_keys
  set
    state = 'revoked'::public.agent_application_key_state,
    revoked_at = clock_timestamp(),
    revoked_reason = 'rotation_rolled_back'
  where id = replacement_key_id
    and state = 'pending_rotation'::public.agent_application_key_state;

  if not found then
    raise exception 'Replacement key is not a pending rotation.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end;
$$;

create function public.revoke_agent_application_key(
  application_key_id_to_revoke uuid,
  revocation_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_reason text := trim(revocation_reason);
begin
  if normalized_reason is null
    or char_length(normalized_reason) not between 1 and 200 then
    raise exception 'Revocation reason must contain between 1 and 200 characters.'
      using errcode = 'check_violation';
  end if;

  update public.agent_application_keys
  set
    state = 'revoked'::public.agent_application_key_state,
    revoked_at = clock_timestamp(),
    revoked_reason = normalized_reason
  where id = application_key_id_to_revoke
    and state <> 'revoked'::public.agent_application_key_state;

  if not found and not exists (
    select 1
    from public.agent_application_keys
    where id = application_key_id_to_revoke
      and state = 'revoked'::public.agent_application_key_state
  ) then
    raise exception 'Agent application key does not exist.'
      using errcode = 'no_data_found';
  end if;
end;
$$;

create function public.deactivate_agent_principal(
  agent_principal_id_to_deactivate uuid,
  deactivation_reason_to_use text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  deactivated_at_to_use timestamptz := clock_timestamp();
  normalized_reason text := trim(deactivation_reason_to_use);
begin
  if normalized_reason is null
    or char_length(normalized_reason) not between 1 and 200 then
    raise exception 'Deactivation reason must contain between 1 and 200 characters.'
      using errcode = 'check_violation';
  end if;

  update public.provisioned_agents
  set
    deactivated_at = coalesce(deactivated_at, deactivated_at_to_use),
    deactivation_reason = coalesce(deactivation_reason, normalized_reason)
  where principal_id = agent_principal_id_to_deactivate;

  if not found then
    raise exception 'Provisioned agent principal does not exist.'
      using errcode = 'no_data_found';
  end if;

  update public.agent_application_keys
  set
    state = 'revoked'::public.agent_application_key_state,
    revoked_at = deactivated_at_to_use,
    revoked_reason = 'agent_deactivated'
  where agent_application_keys.agent_principal_id = agent_principal_id_to_deactivate
    and agent_application_keys.state <> 'revoked'::public.agent_application_key_state;
end;
$$;

alter table public.provisioned_agents enable row level security;
alter table public.agent_application_keys enable row level security;

revoke all on table public.provisioned_agents from public, anon, authenticated, service_role;
revoke all on table public.agent_application_keys from public, anon, authenticated, service_role;

revoke execute on function public.enforce_provisioned_agent_principal() from public, anon, authenticated;
revoke execute on function public.protect_provisioned_agent_principal() from public, anon, authenticated;
revoke execute on function public.agent_application_key_is_well_formed(text) from public, anon, authenticated;
revoke execute on function public.agent_application_key_digest(text) from public, anon, authenticated;
revoke execute on function public.generate_agent_application_key() from public, anon, authenticated;
revoke execute on function public.provision_agent_principal(text) from public, anon, authenticated;
revoke execute on function public.begin_agent_application_key_rotation(uuid) from public, anon, authenticated;
revoke execute on function public.complete_agent_application_key_rotation(uuid, text) from public, anon, authenticated;
revoke execute on function public.rollback_agent_application_key_rotation(uuid) from public, anon, authenticated;
revoke execute on function public.revoke_agent_application_key(uuid, text) from public, anon, authenticated;
revoke execute on function public.deactivate_agent_principal(uuid, text) from public, anon, authenticated;

grant usage on type public.agent_application_key_state to service_role;
grant execute on function public.provision_agent_principal(text) to service_role;
grant execute on function public.begin_agent_application_key_rotation(uuid) to service_role;
grant execute on function public.complete_agent_application_key_rotation(uuid, text) to service_role;
grant execute on function public.rollback_agent_application_key_rotation(uuid) to service_role;
grant execute on function public.revoke_agent_application_key(uuid, text) to service_role;
grant execute on function public.deactivate_agent_principal(uuid, text) to service_role;
