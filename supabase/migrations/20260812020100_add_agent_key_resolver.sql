create function public.current_agent_application_key()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.headers', true), ''),
    '{}'
  )::jsonb ->> 'x-agora-agent-key';
$$;

create function public.current_agent_principal_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select keys.agent_principal_id
  from public.agent_application_keys as keys
  join public.provisioned_agents as agents
    on agents.principal_id = keys.agent_principal_id
  join public.principals
    on principals.id = keys.agent_principal_id
  where public.agent_application_key_is_well_formed(public.current_agent_application_key())
    and keys.key_digest = public.agent_application_key_digest(
      public.current_agent_application_key()
    )
    and keys.state in (
      'active'::public.agent_application_key_state,
      'pending_rotation'::public.agent_application_key_state
    )
    and agents.deactivated_at is null
    and principals.kind = 'agent'::public.principal_kind
    and principals.auth_user_id is null;
$$;

create function public.current_principal_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is not null then public.current_human_principal_id()
    else public.current_agent_principal_id()
  end;
$$;

create or replace function public.current_principal_is_group_member(group_id_to_check uuid)
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
      and principal_id = public.current_principal_id()
  );
$$;

create or replace function public.current_principal_owns_group(group_id_to_check uuid)
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
      and owner_principal_id = public.current_principal_id()
  );
$$;

drop policy "Humans can read their own principal" on public.principals;

create policy "Callers can read their own principal"
on public.principals
for select
to anon, authenticated
using (id = public.current_principal_id());

drop policy "Active members can read groups" on public.groups;

create policy "Active members can read groups"
on public.groups
for select
to anon, authenticated
using (public.current_principal_is_group_member(id));

drop policy "Active members can read memberships" on public.memberships;

create policy "Active members can read memberships"
on public.memberships
for select
to anon, authenticated
using (public.current_principal_is_group_member(group_id));

create view public.agent_application_key_audit
with (security_barrier = true)
as
select
  keys.id as application_key_id,
  keys.agent_principal_id,
  keys.fingerprint,
  keys.state,
  keys.issued_at,
  keys.activated_at,
  keys.revoked_at,
  keys.revoked_reason,
  keys.replaces_key_id,
  keys.rotation_completed_at,
  agents.provisioned_at,
  agents.deactivated_at,
  agents.deactivation_reason
from public.agent_application_keys as keys
join public.provisioned_agents as agents
  on agents.principal_id = keys.agent_principal_id;

revoke all on table public.agent_application_key_audit from public, anon, authenticated;

revoke execute on function public.current_agent_application_key() from public, anon, authenticated;
revoke execute on function public.current_agent_principal_id() from public, authenticated;
revoke execute on function public.current_principal_id() from public;

grant select on table public.agent_application_key_audit to service_role;

grant select on table public.principals to anon;
grant select on table public.groups to anon;
grant select on table public.memberships to anon;
grant execute on function public.current_agent_principal_id() to anon;
grant execute on function public.current_principal_id() to anon, authenticated;
grant execute on function public.current_principal_is_group_member(uuid) to anon;
