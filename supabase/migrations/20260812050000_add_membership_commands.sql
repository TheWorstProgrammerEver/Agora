create index memberships_group_created_at_id_idx
  on public.memberships (group_id, created_at desc, id desc);

create function public.invite_agora_human(
  group_id_to_invite uuid,
  email_to_invite text
)
returns table (
  invitation_id uuid,
  invitation_created_at timestamptz,
  invitation_email text,
  group_id uuid,
  group_name text,
  invited_by_principal_id uuid,
  invited_by_display_name text,
  invited_by_kind public.principal_kind
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
  normalized_email text := lower(trim(coalesce(email_to_invite, '')));
  target_group_name text;
begin
  if not exists (
    select 1
    from public.principals as caller
    where caller.id = caller_principal_id
      and caller.kind = 'human'::public.principal_kind
      and caller.auth_user_id = auth.uid()
  ) then
    raise exception 'Only a human group owner can invite a human.'
      using errcode = 'insufficient_privilege';
  end if;

  if char_length(normalized_email) not between 3 and 320
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception 'Invitation email is invalid.'
      using errcode = 'invalid_parameter_value';
  end if;

  if normalized_email = public.current_auth_email() then
    raise exception 'A group owner cannot invite themselves.'
      using errcode = 'invalid_parameter_value';
  end if;

  select target.name
  into target_group_name
  from public.groups as target
  where target.id = group_id_to_invite
    and target.owner_principal_id = caller_principal_id
  for update;

  if not found then
    raise exception 'Only the group owner can issue an invitation.'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1
    from public.memberships as active_membership
    join public.principals as active_principal
      on active_principal.id = active_membership.principal_id
    join auth.users as active_user
      on active_user.id = active_principal.auth_user_id
    where active_membership.group_id = group_id_to_invite
      and active_principal.kind = 'human'::public.principal_kind
      and lower(trim(active_user.email)) = normalized_email
  ) then
    raise exception 'The invited human is already an active member.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  return query
  with written_invitation as (
    insert into public.invitations (
      group_id,
      email,
      group_name,
      invited_by_principal_id
    )
    values (
      group_id_to_invite,
      normalized_email,
      target_group_name,
      caller_principal_id
    )
    on conflict on constraint invitations_group_email_key do update
      set email = excluded.email
    returning invitations.id, invitations.created_at, invitations.email,
      invitations.group_id, invitations.group_name,
      invitations.invited_by_principal_id
  )
  select
    written_invitation.id,
    written_invitation.created_at,
    written_invitation.email,
    written_invitation.group_id,
    written_invitation.group_name,
    inviter.id,
    inviter.display_name,
    inviter.kind
  from written_invitation
  join public.principals as inviter
    on inviter.id = written_invitation.invited_by_principal_id;
end;
$$;

create function public.list_agora_pending_invitations(
  cursor_created_at timestamptz default null,
  cursor_invitation_id uuid default null,
  page_size integer default 50
)
returns table (
  invitation_id uuid,
  invitation_created_at timestamptz,
  invitation_email text,
  group_id uuid,
  group_name text,
  invited_by_principal_id uuid,
  invited_by_display_name text,
  invited_by_kind public.principal_kind,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
  caller_email text := public.current_auth_email();
begin
  if not exists (
    select 1
    from public.principals as caller
    where caller.id = caller_principal_id
      and caller.kind = 'human'::public.principal_kind
      and caller.auth_user_id = auth.uid()
  ) then
    raise exception 'Only an authenticated human can list pending invitations.'
      using errcode = 'insufficient_privilege';
  end if;

  if (cursor_created_at is null) is distinct from (cursor_invitation_id is null) then
    raise exception 'A complete invitation cursor is required.'
      using errcode = 'invalid_parameter_value';
  end if;

  if page_size is null or page_size < 1 or page_size > 100 then
    raise exception 'Invitation page size must be between 1 and 100.'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with page_candidates as materialized (
    select
      pending.id,
      pending.created_at,
      pending.email,
      pending.group_id,
      pending.group_name,
      inviter.id as inviter_id,
      inviter.display_name,
      inviter.kind
    from public.invitations as pending
    join public.principals as inviter
      on inviter.id = pending.invited_by_principal_id
    where pending.email = caller_email
      and (
        cursor_created_at is null
        or (pending.created_at, pending.id) < (cursor_created_at, cursor_invitation_id)
      )
    order by pending.created_at desc, pending.id desc
    limit page_size + 1
  ),
  page_state as (
    select count(*) > page_size as has_more
    from page_candidates
  )
  select
    page_candidates.id,
    page_candidates.created_at,
    page_candidates.email,
    page_candidates.group_id,
    page_candidates.group_name,
    page_candidates.inviter_id,
    page_candidates.display_name,
    page_candidates.kind,
    page_state.has_more
  from page_candidates
  cross join page_state
  order by page_candidates.created_at desc, page_candidates.id desc
  limit page_size;
end;
$$;

create function public.accept_agora_invitation(invitation_id_to_accept uuid)
returns table (
  invitation_id uuid,
  group_id uuid,
  membership_created_at timestamptz,
  membership_role public.membership_role,
  principal_id uuid,
  principal_display_name text,
  principal_kind public.principal_kind
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  accepted_membership public.memberships%rowtype;
  caller_email text := public.current_auth_email();
  caller_principal_id uuid := public.current_principal_id();
  target_group_id uuid;
begin
  if not exists (
    select 1
    from public.principals as caller
    where caller.id = caller_principal_id
      and caller.kind = 'human'::public.principal_kind
      and caller.auth_user_id = auth.uid()
  ) then
    raise exception 'Only an authenticated human can accept an invitation.'
      using errcode = 'insufficient_privilege';
  end if;

  select pending.group_id
  into target_group_id
  from public.invitations as pending
  where pending.id = invitation_id_to_accept
    and pending.email = caller_email;

  if not found then
    raise exception 'The pending invitation is unavailable.'
      using errcode = 'no_data_found';
  end if;

  perform 1
  from public.groups as target
  where target.id = target_group_id
  for update;

  if not found then
    raise exception 'The pending invitation is unavailable.'
      using errcode = 'no_data_found';
  end if;

  perform 1
  from public.invitations as pending
  where pending.id = invitation_id_to_accept
    and pending.group_id = target_group_id
    and pending.email = caller_email
  for update;

  if not found then
    raise exception 'The pending invitation is unavailable.'
      using errcode = 'no_data_found';
  end if;

  insert into public.memberships (group_id, principal_id, role)
  values (target_group_id, caller_principal_id, 'member'::public.membership_role)
  returning memberships.* into accepted_membership;

  return query
  select
    invitation_id_to_accept,
    accepted_membership.group_id,
    accepted_membership.created_at,
    accepted_membership.role,
    accepted_principal.id,
    accepted_principal.display_name,
    accepted_principal.kind
  from public.principals as accepted_principal
  where accepted_principal.id = accepted_membership.principal_id;
end;
$$;

create function public.reject_agora_invitation(invitation_id_to_reject uuid)
returns table (group_id uuid, invitation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_email text := public.current_auth_email();
  caller_principal_id uuid := public.current_principal_id();
  target_group_id uuid;
begin
  if not exists (
    select 1
    from public.principals as caller
    where caller.id = caller_principal_id
      and caller.kind = 'human'::public.principal_kind
      and caller.auth_user_id = auth.uid()
  ) then
    raise exception 'Only an authenticated human can reject an invitation.'
      using errcode = 'insufficient_privilege';
  end if;

  delete from public.invitations as pending
  where pending.id = invitation_id_to_reject
    and pending.email = caller_email
  returning pending.group_id into target_group_id;

  if not found then
    raise exception 'The pending invitation is unavailable.'
      using errcode = 'no_data_found';
  end if;

  return query select target_group_id, invitation_id_to_reject;
end;
$$;

create function public.list_agora_group_members(
  group_id_to_list uuid,
  cursor_created_at timestamptz default null,
  cursor_membership_id uuid default null,
  page_size integer default 50
)
returns table (
  membership_id uuid,
  group_id uuid,
  membership_created_at timestamptz,
  membership_role public.membership_role,
  principal_id uuid,
  principal_display_name text,
  principal_kind public.principal_kind,
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
  if caller_principal_id is null or not exists (
    select 1
    from public.memberships as caller_membership
    where caller_membership.group_id = group_id_to_list
      and caller_membership.principal_id = caller_principal_id
  ) then
    raise exception 'The group membership directory is unavailable.'
      using errcode = 'no_data_found';
  end if;

  if (cursor_created_at is null) is distinct from (cursor_membership_id is null) then
    raise exception 'A complete member cursor is required.'
      using errcode = 'invalid_parameter_value';
  end if;

  if page_size is null or page_size < 1 or page_size > 100 then
    raise exception 'Member page size must be between 1 and 100.'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with page_candidates as materialized (
    select
      active_membership.id,
      active_membership.group_id,
      active_membership.created_at,
      active_membership.role,
      member_principal.id as member_principal_id,
      member_principal.display_name,
      member_principal.kind
    from public.memberships as active_membership
    join public.principals as member_principal
      on member_principal.id = active_membership.principal_id
    where active_membership.group_id = group_id_to_list
      and (
        cursor_created_at is null
        or (active_membership.created_at, active_membership.id)
          < (cursor_created_at, cursor_membership_id)
      )
    order by active_membership.created_at desc, active_membership.id desc
    limit page_size + 1
  ),
  page_state as (
    select count(*) > page_size as has_more
    from page_candidates
  )
  select
    page_candidates.id,
    page_candidates.group_id,
    page_candidates.created_at,
    page_candidates.role,
    page_candidates.member_principal_id,
    page_candidates.display_name,
    page_candidates.kind,
    page_state.has_more
  from page_candidates
  cross join page_state
  order by page_candidates.created_at desc, page_candidates.id desc
  limit page_size;
end;
$$;

create function public.add_agora_agent_member(
  group_id_to_update uuid,
  agent_principal_id_to_add uuid
)
returns table (
  group_id uuid,
  membership_created_at timestamptz,
  membership_role public.membership_role,
  principal_id uuid,
  principal_display_name text,
  principal_kind public.principal_kind
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
  group_owner_principal_id uuid;
  target_membership public.memberships%rowtype;
begin
  if not exists (
    select 1
    from public.principals as caller
    where caller.id = caller_principal_id
      and caller.kind = 'human'::public.principal_kind
      and caller.auth_user_id = auth.uid()
  ) then
    raise exception 'Only a human group owner can add an agent.'
      using errcode = 'insufficient_privilege';
  end if;

  select target.owner_principal_id
  into group_owner_principal_id
  from public.groups as target
  where target.id = group_id_to_update
  for update;

  if not found or group_owner_principal_id <> caller_principal_id then
    raise exception 'Only the group owner can add an agent.'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1
  from public.provisioned_agents as target_agent
  join public.principals as target_principal
    on target_principal.id = target_agent.principal_id
  where target_agent.principal_id = agent_principal_id_to_add
    and target_agent.deactivated_at is null
    and target_principal.kind = 'agent'::public.principal_kind
    and target_principal.auth_user_id is null
  for share of target_agent, target_principal;

  if not found then
    raise exception 'The provisioned agent is unavailable.'
      using errcode = 'no_data_found';
  end if;

  select active_membership.*
  into target_membership
  from public.memberships as active_membership
  where active_membership.group_id = group_id_to_update
    and active_membership.principal_id = agent_principal_id_to_add
  for update;

  if not found then
    insert into public.memberships (group_id, principal_id, role)
    values (
      group_id_to_update,
      agent_principal_id_to_add,
      'member'::public.membership_role
    )
    returning memberships.* into target_membership;
  end if;

  return query
  select
    target_membership.group_id,
    target_membership.created_at,
    target_membership.role,
    agent_principal.id,
    agent_principal.display_name,
    agent_principal.kind
  from public.principals as agent_principal
  where agent_principal.id = target_membership.principal_id;
end;
$$;

create function public.remove_agora_group_member(
  group_id_to_update uuid,
  principal_id_to_remove uuid
)
returns table (group_id uuid, principal_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
  group_owner_principal_id uuid;
begin
  if not exists (
    select 1
    from public.principals as caller
    where caller.id = caller_principal_id
      and caller.kind = 'human'::public.principal_kind
      and caller.auth_user_id = auth.uid()
  ) then
    raise exception 'Only a human group owner can remove a member.'
      using errcode = 'insufficient_privilege';
  end if;

  select target.owner_principal_id
  into group_owner_principal_id
  from public.groups as target
  where target.id = group_id_to_update
  for update;

  if not found or group_owner_principal_id <> caller_principal_id then
    raise exception 'Only the group owner can remove a member.'
      using errcode = 'insufficient_privilege';
  end if;

  if principal_id_to_remove = group_owner_principal_id then
    raise exception 'The group owner cannot be removed.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  delete from public.memberships as target_membership
  where target_membership.group_id = group_id_to_update
    and target_membership.principal_id = principal_id_to_remove
    and target_membership.role = 'member'::public.membership_role;

  return query select group_id_to_update, principal_id_to_remove;
end;
$$;

revoke execute on function public.invite_agora_human(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.list_agora_pending_invitations(timestamptz, uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.accept_agora_invitation(uuid)
  from public, anon, authenticated;
revoke execute on function public.reject_agora_invitation(uuid)
  from public, anon, authenticated;
revoke execute on function public.list_agora_group_members(uuid, timestamptz, uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.add_agora_agent_member(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.remove_agora_group_member(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.invite_agora_human(uuid, text) to authenticated;
grant execute on function public.list_agora_pending_invitations(timestamptz, uuid, integer)
  to authenticated;
grant execute on function public.accept_agora_invitation(uuid) to authenticated;
grant execute on function public.reject_agora_invitation(uuid) to authenticated;
grant execute on function public.list_agora_group_members(uuid, timestamptz, uuid, integer)
  to anon, authenticated;
grant execute on function public.add_agora_agent_member(uuid, uuid) to authenticated;
grant execute on function public.remove_agora_group_member(uuid, uuid) to authenticated;
