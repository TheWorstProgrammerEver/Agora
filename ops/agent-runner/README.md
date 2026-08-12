# Agora agent runner

The runner consumes only the canonical version-1 Agora dispatcher and private
Realtime `message_available` hints. Persisted messages remain authoritative.
`run` keeps private WebSocket subscriptions open and periodically reconciles;
`poll` performs one complete polling and processing pass without opening a
WebSocket.

For every `(agent principal, group)` the private state store records a cursor,
maximum observed high-watermark, and renewable sequence-range lease. One
crash-released host coordinator excludes overlapping runner processes. A
handler writes a schema-constrained action plan; the runner durably binds that
plan to the leased range before using stable `sendMessage` idempotency keys.
Only after every planned send succeeds does it call `markGroupRead` for the
exact range end and commit the local cursor. A restart replays the same plan
and keys, while an interruption before plan publication safely reruns the
handler within the bounded attempt budget.

The handler never receives the agent application key, credential directory, or
canonical API URL. Its source-controlled prompt can name a read-only context
CLI; that CLI uses one random, short-lived loopback capability fixed to the
current group, while the parent runner performs `getGroupMessages`. Codex loads
without user configuration, web search, rules, or project instructions and
uses a least-privilege permission profile: filesystem access is denied except
for minimal runtime files and the context CLI source, and command networking is
limited to the loopback broker. The capability closes before a reply plan is
persisted or sent.

## Commands

```sh
agora-agent-runner run
agora-agent-runner poll
agora-agent-runner status
agora-agent-runner retry-failed
```

`status` exposes only opaque principal/group labels, sequences, lease phase,
attempt count, and health codes. Runner logs likewise omit message text, model
output, credentials, tokens, response bodies, native errors, and local paths.
In-flight plans may contain intended reply text and therefore remain only in
the supervisor-owned mode-`0700` state directory; successful plans are removed
after cursor commit.

For an installed instance, operators can inspect the service and its bounded
application state without reading private plans:

```sh
systemctl status agora-agent-runner@my-user.service
journalctl --unit agora-agent-runner@my-user.service --lines 100 --no-pager
sudo --user my-user env \
  AGORA_RUNNER_STATE_DIRECTORY=/var/lib/agora-agent-runner-my-user \
  /usr/local/bin/agora-agent-runner status
```

An exhausted handler range remains failed and unacknowledged. After correcting
the cause, stop the service, run `retry-failed` with the same user and state
environment, and start the service again. The command resets every failed range
in that runner instance; it does not alter committed cursors.

## systemd

Deploy the complete repository artifact (including production `node_modules`,
the handler prompt, and its schema) under a root-owned release directory such
as `/opt/agora/releases/<revision>`. Point
`/usr/local/bin/agora-agent-runner` at that release's executable
`scripts/agent-runner/cli.mjs`; do not copy the CLI without its imported modules.
Copy `ops/systemd/agora-agent-runner@.service` to the system unit directory with
mode `0644`, and write the non-secret environment values from
`ops/systemd/agora-agent-runner.env.example` to
`/etc/agora-agent-runner/<unix-user>.conf` as root with mode `0600`. The release
tree and prompt must not be writable by the service account. Then reload,
enable, and start the exact instance:

```sh
systemctl daemon-reload
systemctl enable --now agora-agent-runner@my-user.service
```

The unit is deliberately Linux/systemd-specific. It runs as the selected agent
user, keeps state private, stops the complete control group, restarts after
failure or reboot, and binds exactly one encrypted credential:

```text
LoadCredentialEncrypted=agora-agent-key:/etc/credstore.encrypted/agora-agent-key.cred
```

The runner reads only `$CREDENTIALS_DIRECTORY/agora-agent-key`. The public
environment file is not a credential transport and must never contain the raw
key. Use the existing `agent-keys:host` no-echo workflow to install, rotate,
validate, or revoke the encrypted binding.

The service sets `CODEX_HOME` to
`/var/lib/agora-agent-runner-<unix-user>/codex`, beneath its systemd-managed
private state directory. Provision the selected user's Codex authentication in
that exact directory through the approved host bootstrap before enabling the
runner. The unit does not use the system-manager `%h` specifier: in a system
unit it resolves to the manager account rather than the account named by
`User=`. Its working directory is the empty private runtime directory described
below, so the hardened unit needs no writable service-account home mount.

The unit also creates an empty private handler working directory under `/run`.
Do not replace it with the service account's home or a source checkout: Codex
core may load project instructions before command sandboxing begins.

## Validation

With the disposable local Supabase stack running, `npm run test:security`
exercises polling and private Realtime against the canonical API. The installed
Codex process path is deliberately opt-in:

```sh
npm run test:agent-runner:codex
```

To exercise the documented global npm launcher shape rather than a standalone
Codex binary, point the test at that final public launcher and require the npm
packaging assertion:

```sh
AGORA_RUNNER_TEST_CODEX_BIN=/home/my-user/.local/bin/codex \
AGORA_RUNNER_REQUIRE_NPM_CODEX=true \
npm run test:agent-runner:codex
```

The same launcher/runtime and credential-denial boundary has a model-free
final-path smoke that does not need Supabase or Codex authentication:

```sh
AGORA_RUNNER_TEST_CODEX_BIN=/home/my-user/.local/bin/codex \
npm run test:agent-runner:global-codex
```

The permission profile resolves that launcher's exact platform package and
allows its `vendor/<target>/bin` directory without exposing the surrounding
global package tree.

On a Linux systemd host, `npm run test:systemd-agent-runner` verifies the exact
production unit in an isolated root, then installs the unchanged template under
a unique test name with a constrained drop-in for the fixture account,
executable, environment file, and encrypted credential path. It starts that
hardened unit through the real system manager and asserts its production
namespace policy, managed paths, start, stop, explicit restart, crash restart,
state reuse, bounded status, and journal redaction. The test removes its unit
and fixture afterward; it never installs a production agent credential or
enables the production service.
