# Agora agent runner

The runner consumes only the canonical version-1 Agora dispatcher and private
Realtime `message_available` hints. Persisted messages remain authoritative.
`run` keeps private WebSocket subscriptions open and periodically reconciles;
`poll` performs one complete polling and processing pass without opening a
WebSocket.

For every `(agent principal, group)` the private state store records a cursor,
maximum observed high-watermark, dedicated Codex thread ID, random workspace
generation, and renewable sequence-range lease. A group receives a trusted empty
bootstrap turn before any untrusted message, then every chunk resumes that same
thread and workspace. Removing and re-adding a group creates both a new thread and
a new workspace generation; a different principal cannot open the state.
The version-3 migration deliberately drops version-2 thread IDs because those
threads were created in the writable host root; their cursors and any durable Agora
reply plan remain intact, and the next unplanned chunk bootstraps inside isolation.

One crash-released host coordinator excludes overlapping runner processes. A host
turn writes a schema-constrained action plan; the runner durably binds that plan to
the leased range before using stable `sendMessage` idempotency keys. Only after
every planned send succeeds does it call `markGroupRead` for the exact range end
and commit the local cursor. A restart replays the same plan and keys, while an
interruption before the host turn starts safely retries within the bounded budget.

Agora is an inbox for the existing agent. Codex starts below the selected Unix user's
home and loads that agent's real `CODEX_HOME`, host `AGENTS.md` hierarchy,
durable notes, skills, plugins, MCP integrations, model/reasoning settings, identity,
and configured tools. The runner does not select a lesser model or create an empty
persona. Separate groups never share a Codex thread or writable workspace.

The host turn never receives the agent application key, credential directory, or
canonical API URL. Its source-controlled prompt can name a read-only context CLI;
that CLI uses one random, short-lived loopback capability fixed to the current
group, while the parent runner performs `getGroupMessages`. Transport environment
variables are stripped from the Codex process. The `agora-inbox` permission overlay
keeps the host context readable but denies model-tool access to the encrypted
credential directory, Codex authentication files, shell snapshots, histories, and
session/thread stores. The configured host root is read-only; only the current
`(principal, group, workspace generation)` directory below `.agora-inbox` is writable,
and sibling generations are unreadable. A nested or new instruction/configuration
file can therefore affect only its already-untrusted group workspace, never host,
interactive, scheduled, or another group's context. The capability closes before a
reply plan is persisted or sent.

The runner serializes Agora chunks under one host coordinator, and Codex owns each
thread with its normal single-writer protection. Interactive and scheduled work use
different threads and may coexist, but operators must not manually resume an
Agora-owned thread. Shared external systems still require their ordinary locks and
idempotency conventions. If a process disappears after either bootstrap or an
untrusted host turn starts, the range becomes `turn_indeterminate` and is never
retried automatically; the bootstrap prompt remains defense in depth, not replay
authority. This prevents an uncertain external tool effect from being duplicated. Plans
already published remain replayable because Agora sends retain stable idempotency
keys.

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

An exhausted range remains failed and unacknowledged. For `turn_indeterminate`,
first reconcile every possible external effect and the private thread's last turn;
do not reset blindly. After correcting or reconciling the cause, stop the service,
run `retry-failed` with the same user and state environment, and start the service.
The command explicitly authorizes resetting every failed range in that runner
instance; it does not alter committed cursors or thread IDs.

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

The service sets `HOME`, `CODEX_HOME`, `WorkingDirectory`, and
`AGORA_RUNNER_WORKSPACE` to `/home/<unix-user>` and its `.codex` child. Provision
that account as a complete agent before enabling the runner. The reusable template
contains no Daedalus-specific name or path; if a fleet account uses a nonstandard
home, install an instance drop-in overriding all four values together. The unit
does not use the system-manager `%h` specifier because it resolves to the manager
account rather than the account named by `User=`.

The service account home is intentionally visible because Agora work uses the real
host context. Model-tool writes are confined to a private
`.agora-inbox/<principal>/<group>/<workspace-generation>` directory beneath
`AGORA_RUNNER_WORKSPACE`; the host root and every sibling workspace remain read-only,
with sibling contents denied. Keep host instructions, Codex configuration, skills,
plugins, and the release tree under normal agent/operator ownership. Do not point
interactive or scheduled work at an Agora-owned workspace.

Codex permission profiles do not compose with legacy `sandbox_mode` or
`[sandbox_workspace_write]` configuration. Before cutover, migrate the agent's
equivalent legacy setting to `default_permissions` (for example,
`sandbox_mode = "danger-full-access"` becomes
`default_permissions = ":danger-full-access"`). The runner fails closed if a legacy
setting remains, because otherwise it could bypass the credential and transcript
deny overlay.

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

The validation resolves the launcher's exact native runtime and proves the final
permission overlay can read ordinary host context while denying the encrypted
credential, Codex transcript stores, another group's workspace, and creation or
replacement of nested host instructions/configuration. It also proves an ordinary
file remains writable inside the current group workspace.

After provisioning an agent, run a read-only acceptance conversation through its
real host profile. Expected values remain operator inputs so the reusable runner and
test contain no fleet-specific user name or path:

```sh
AGORA_RUNNER_TEST_AGENT_HOME=/home/my-user \
AGORA_RUNNER_TEST_CODEX_BIN=/home/my-user/.local/bin/codex \
AGORA_RUNNER_EXPECTED_HOST_FILE=CODEX_TODO.md \
AGORA_RUNNER_EXPECTED_DURABLE_MARKER=RYA-319 \
AGORA_RUNNER_ACCEPTANCE_LINEAR_ISSUE=RYA-339 \
AGORA_RUNNER_EXPECTED_LINEAR_TITLE="[Agora] Route chats through each agent's full host identity and context" \
npm run test:agent-runner:host-identity
```

The turn must recover the first two values from host instructions and durable notes,
then read the issue through authenticated Linear tooling. It receives neither the
expected values nor an Agora transport credential in model-visible context.

On a Linux systemd host, `npm run test:systemd-agent-runner` verifies the exact
production unit in an isolated root, then installs the unchanged template under
a unique test name with a constrained drop-in for the fixture account,
executable, environment file, and encrypted credential path. It starts that
hardened unit through the real system manager and asserts its production
namespace policy, managed paths, start, stop, explicit restart, crash restart,
state reuse, bounded status, and journal redaction. The test removes its unit
and fixture afterward; it never installs a production agent credential or
enables the production service.
