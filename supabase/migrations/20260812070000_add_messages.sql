alter table public.groups
add column last_message_sequence bigint not null default 0,
add constraint groups_last_message_sequence_nonnegative
  check (last_message_sequence >= 0);

create table public.messages (
  id uuid primary key default extensions.gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  sequence bigint not null,
  sender_principal_id uuid not null references public.principals(id) on delete restrict,
  text text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint messages_sequence_positive check (sequence > 0),
  constraint messages_text_not_blank check (text ~ '[^[:space:]]'),
  constraint messages_text_length check (char_length(text) between 1 and 4000),
  constraint messages_group_sequence_key unique (group_id, sequence),
  constraint messages_group_id_id_key unique (group_id, id)
);

create index messages_sender_principal_id_idx
  on public.messages (sender_principal_id);

create table public.message_idempotency_keys (
  group_id uuid not null references public.groups(id) on delete cascade,
  sender_principal_id uuid not null references public.principals(id) on delete restrict,
  client_message_id text not null,
  message_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint message_idempotency_keys_client_id_not_blank
    check (client_message_id ~ '[^[:space:]]'),
  constraint message_idempotency_keys_client_id_length
    check (char_length(client_message_id) between 1 and 200),
  constraint message_idempotency_keys_group_sender_client_key
    primary key (group_id, sender_principal_id, client_message_id),
  constraint message_idempotency_keys_group_message_fkey
    foreign key (group_id, message_id)
    references public.messages(group_id, id)
    on delete cascade,
  constraint message_idempotency_keys_message_key unique (message_id)
);

create index message_idempotency_keys_sender_principal_id_idx
  on public.message_idempotency_keys (sender_principal_id);

create function public.send_agora_message(
  group_id_to_use uuid,
  client_message_id_to_use text,
  message_text_to_use text
)
returns table (
  message_id uuid,
  message_created_at timestamptz,
  message_group_id uuid,
  sender_principal_id uuid,
  sender_display_name text,
  sender_kind public.principal_kind,
  message_sequence text,
  message_text text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_principal_id uuid := public.current_principal_id();
  allocated_sequence bigint;
  message_to_return public.messages%rowtype;
begin
  if caller_principal_id is null then
    raise exception 'An authenticated Agora principal is required.'
      using errcode = 'insufficient_privilege';
  end if;

  if group_id_to_use is null
    or client_message_id_to_use is null
    or not (client_message_id_to_use ~ '[^[:space:]]')
    or char_length(client_message_id_to_use) > 200
    or message_text_to_use is null
    or not (message_text_to_use ~ '[^[:space:]]')
    or char_length(message_text_to_use) > 4000 then
    raise exception 'Message parameters are invalid.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The group row is the per-group sequencer and serializes idempotency checks.
  perform target_group.id
  from public.groups as target_group
  where target_group.id = group_id_to_use
  for update;

  if not found then
    raise exception 'Only an active group member can send a message.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Membership transitions take the same group lock, so this fresh statement
  -- observes any transition that committed while this sender waited.
  if not exists (
    select 1
    from public.memberships as caller_membership
    where caller_membership.group_id = group_id_to_use
      and caller_membership.principal_id = caller_principal_id
  ) then
    raise exception 'Only an active group member can send a message.'
      using errcode = 'insufficient_privilege';
  end if;

  select target_message.*
  into message_to_return
  from public.message_idempotency_keys as idempotency
  join public.messages as target_message
    on target_message.group_id = idempotency.group_id
    and target_message.id = idempotency.message_id
  where idempotency.group_id = group_id_to_use
    and idempotency.sender_principal_id = caller_principal_id
    and idempotency.client_message_id = client_message_id_to_use;

  if message_to_return.id is not null then
    if message_to_return.text is distinct from message_text_to_use then
      raise exception 'A client message identifier cannot be reused for different text.'
        using errcode = 'unique_violation';
    end if;
  else
    update public.groups as target_group
    set last_message_sequence = target_group.last_message_sequence + 1
    where target_group.id = group_id_to_use
    returning target_group.last_message_sequence into allocated_sequence;

    insert into public.messages (
      group_id,
      sequence,
      sender_principal_id,
      text,
      created_at
    )
    values (
      group_id_to_use,
      allocated_sequence,
      caller_principal_id,
      message_text_to_use,
      clock_timestamp()
    )
    returning * into message_to_return;

    insert into public.message_idempotency_keys (
      group_id,
      sender_principal_id,
      client_message_id,
      message_id
    )
    values (
      group_id_to_use,
      caller_principal_id,
      client_message_id_to_use,
      message_to_return.id
    );
  end if;

  return query
  select
    target_message.id,
    target_message.created_at,
    target_message.group_id,
    target_message.sender_principal_id,
    sender.display_name,
    sender.kind,
    target_message.sequence::text,
    target_message.text
  from public.messages as target_message
  join public.principals as sender
    on sender.id = target_message.sender_principal_id
  where target_message.id = message_to_return.id;
end;
$$;

alter table public.messages enable row level security;
alter table public.message_idempotency_keys enable row level security;

create policy "Active members can read messages"
on public.messages
for select
to anon, authenticated
using (public.current_principal_is_group_member(group_id));

revoke all on table public.messages from public, anon, authenticated;
revoke all on table public.message_idempotency_keys from public, anon, authenticated;
revoke execute on function public.send_agora_message(uuid, text, text)
  from public, anon, authenticated;

grant select on table public.messages to anon, authenticated;
grant select, insert, update, delete on table public.messages to service_role;
grant select, insert, update, delete on table public.message_idempotency_keys to service_role;
grant execute on function public.send_agora_message(uuid, text, text) to anon, authenticated;
