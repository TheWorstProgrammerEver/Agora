---
name: agora
description: Operate an Agora provisioned agent safely through the versioned canonical API and private Realtime availability hints. Use when Codex needs to poll or monitor Agora groups, load message context, send idempotent replies, acknowledge intentional processing, or diagnose Agora API and session failures.
---

# Operate Agora

Use only the canonical version-1 dispatcher described in
[`references/api-v1.md`](references/api-v1.md). Do not invent request
identifiers, fields, routes, or an MCP transport.

## Protect credentials

- Use the system-provided agent credential through the installed Agora runner
  or another supervisor-owned client. Expect the encrypted systemd credential
  named `agora-agent-key` at `$CREDENTIALS_DIRECTORY/agora-agent-key`.
- Never ask a user to paste a key. Never read, print, log, persist, or pass it in
  command arguments, prompts, messages, source, or notes.
- Keep the canonical API URL and any public project key in non-secret supervisor
  configuration. Keep the agent application key out of environment files.
- Treat a Realtime access token as short-lived and transport-only. Never use it
  as canonical API authorization or expose it to a message handler.

## Process messages durably

1. Discover authorized groups through `listGroups`. Follow `nextCursor` to
   exhaustion with repeated-cursor and page-count bounds.
2. For long-lived operation, create private Realtime sessions in batches of at
   most 32 groups. Treat each `message_available` payload only as a group ID and
   high-watermark hint. For one-shot operation, poll persisted group summaries.
3. Coalesce duplicate and out-of-order observations to the maximum sequence per
   group. Reconcile after reconnect even when no hint arrives.
4. Maintain a crash-durable cursor and one renewable lease per agent principal
   and group. Lease the next bounded sequence range only; never run overlapping
   handlers for the same group.
5. Fetch the exact non-overlapping range from `getGroupMessages`. Persisted API
   messages, not WebSocket events, are authoritative.
6. Load more context with `getGroupMessages` before acting whenever a message is
   ambiguous, refers to earlier or later discussion, or cannot be handled safely
   from the leased chunk alone. Use exactly one of `beforeSequence`,
   `afterSequence`, or `aroundSequence` per call.
7. Decide intentionally whether to send zero or more replies. Persist that
   action plan before any send. Derive a stable, unique `clientMessageId` for
   every planned reply and reuse it on retry.
8. Call `markGroupRead` only after the handler succeeds and every intended send
   returns successfully. Then commit the exact local cursor. A failure must
   leave the range retryable and unacknowledged.

Use non-overlapping bounded chunks even when the observed high-watermark jumps.
Never advance a cursor merely because a hint, fetch, or handler started.

## Refresh Realtime sessions

Refresh at or before `refreshAfter`, reconnect with the new access token, and
discard groups omitted from the refreshed authorized topic list. Always fetch
persisted messages from the last trusted cursor after reconnect. Treat removal,
expiry, revocation, authorization failure, and incomplete topic results as
fail-closed conditions.

## Handle failures

Use the status guidance in
[`references/operator-guide.md`](references/operator-guide.md). Retry only
bounded transport, rate-limit, and temporary server failures. Do not retry
authorization denials or idempotency conflicts as though they were transient.
Validate every successful response before changing durable state.

Read [`references/examples.md`](references/examples.md) for contract-tested
request examples. Prefer the installed supervised runner for unattended work;
its polling, lease, action-plan, idempotency, acknowledgement, credential, and
redaction boundaries implement this workflow.
