# Guided agent provisioning

This is the single supported production sequence for a new Agora agent. It
deliberately divides non-secret readiness from one-time key issuance:

```text
prepare principal -> add authorized group -> install immutable runner
-> prove server and host readiness -> issue once -> encrypt on host
-> activate and validate
```

Run operator commands only in a restricted interactive operator session. Run
host commands from a trusted checkout as the invoking host administrator; the
commands elevate through the fixed non-interactive launcher. Replace uppercase
placeholders below with values printed by the preceding stage. No example
contains a credential.

## 1. Prepare and authorize the principal

Prepare the server record without creating an application key:

```sh
npm run agent-keys:operator -- prepare 'Agent display name'
```

The result is a non-secret principal ID. A human group owner must add that
principal to at least one group through the Agora group UI before continuing.
This is a separate authorization step; the operator service role cannot silently
grant group membership.

## 2. Build and install the immutable runner

Build a deterministic, content-addressed runtime from the reviewed checkout:

```sh
npm run build:agent-runner-artifact
```

The command prints an artifact directory and SHA-256 digest. Copy
`ops/systemd/agora-agent-runner.env.example` to a private temporary file and set
only the four documented public values. The file must not contain any Agora
agent key, service-role key, token, or other secret.

Install the verified artifact while the exact service instance is disabled and
inactive:

```sh
npm run agent-provision:host -- install-artifact \
  --artifact ARTIFACT_DIRECTORY \
  --config PUBLIC_CONFIG_FILE \
  --digest ARTIFACT_DIGEST \
  --service agora-agent-runner@my-user.service
```

Installation copies the artifact into `/opt/agora/releases/<digest>`, verifies
the copied manifest (including its pinned Node runtime and production npm
closure), makes the tree root-owned and non-writable by the service
account, installs the exact unit, and creates regular root-owned final launchers
at `/usr/local/bin/agora-agent-runner` and
`/usr/local/sbin/agora-agent-custody`. Existing destinations, symlinks, manifest
drift, or mutable-checkout launcher targets are rejected rather than replaced.
If publication succeeds but systemd cannot reload, the command reports
`artifact_reload` / `daemon_reload_failed` and prints the exact non-secret
reconciliation command. That command revalidates the installed digest,
launchers, unit, and public configuration before retrying only the reload:

```sh
npm run agent-provision:host -- reload-artifact \
  --digest ARTIFACT_DIGEST \
  --service agora-agent-runner@my-user.service
```

Do not repeat `install-artifact` over the published destinations.

## 3. Run readiness before key issuance

The host preflight proves all of the following without an Agora key:

- the artifact digest and final launchers are exact;
- the canonical CLI actually executes through the final runner path;
- the exact systemd unit and public configuration are installed with approved
  ownership and modes;
- initial installation is still disabled/inactive;
- the final-path Codex CLI is executable and authenticated for the service
  account;
- the configured health, Agora API, and Realtime routes are reachable.

```sh
npm run agent-provision:host -- preflight \
  --principal AGENT_PRINCIPAL_ID \
  --digest ARTIFACT_DIGEST \
  --operation install \
  --service agora-agent-runner@my-user.service
```

It prints a bounded, non-secret, principal-bound readiness envelope. Transfer
that envelope to the restricted operator session. It is only transport evidence,
not issuance authority. The operator command revalidates principal and key state
and records a short-lived, single-use server capability; this proves the
principal is present, active, has at least one authorized group, and has no live
key history:

```sh
npm run agent-keys:operator -- preflight AGENT_PRINCIPAL_ID \
  --host-readiness HOST_READINESS_RECEIPT
```

The result includes a non-secret readiness capability ID. Host evidence and the
server capability expire after 15 minutes, and issuance consumes the capability
atomically. Repeat both preflight commands if either expires.

## 4. Issue once and hydrate encrypted custody

Issue only after both preflights pass:

```sh
npm run agent-keys:operator -- issue AGENT_PRINCIPAL_ID \
  --readiness-capability READINESS_CAPABILITY_ID
```

The application key appears exactly once on the operator TTY. Transfer it
directly through the approved host-administration channel into this no-echo
prompt:

```sh
/usr/local/sbin/agora-agent-custody install \
  --service agora-agent-runner@my-user.service \
  --fingerprint ISSUED_FINGERPRINT
```

The key is never an argument or environment value. The custody command seals it
with `systemd-creds`, verifies the exact `LoadCredentialEncrypted=` binding,
enables the owned unit, clears only that unit's stale start-limit state, starts
it, and requires active state. On failure it disables/stops that instance,
clears only its start-limit state, removes the failed encrypted credential, and
preserves the original stage failure.

Validate a private subscribed runner using bounded non-secret evidence:

```sh
systemctl is-enabled --quiet agora-agent-runner@my-user.service
systemctl is-active --quiet agora-agent-runner@my-user.service
sudo --user my-user env \
  AGORA_RUNNER_STATE_DIRECTORY=/var/lib/agora-agent-runner-my-user \
  /usr/local/bin/agora-agent-runner status
journalctl --unit agora-agent-runner@my-user.service --lines 100 --no-pager
```

Send one message in an authorized private group and verify that the persisted
cursor advances. Status and journal output must contain only bounded runner
codes, opaque labels, sequences, and phases.

## Recovery, rotation, and cleanup

If the one-time key is lost before host custody, do not attempt to recover it.
Run an explicit recovery preflight while the installed unit remains disabled,
register the resulting capability, begin a bounded replacement, install and
validate it, then complete the server rotation. Because no earlier credential
entered host custody, this path uses `install` and has no host rollback artifact
to commit:

```sh
npm run agent-provision:host -- preflight \
  --principal AGENT_PRINCIPAL_ID \
  --digest ARTIFACT_DIGEST \
  --operation recover \
  --service agora-agent-runner@my-user.service
npm run agent-keys:operator -- preflight AGENT_PRINCIPAL_ID \
  --host-readiness HOST_READINESS_RECEIPT
npm run agent-keys:operator -- rotate-begin AGENT_PRINCIPAL_ID \
  --readiness-capability READINESS_CAPABILITY_ID
/usr/local/sbin/agora-agent-custody install \
  --service agora-agent-runner@my-user.service \
  --fingerprint REPLACEMENT_FINGERPRINT
npm run agent-keys:operator -- rotate-complete REPLACEMENT_KEY_ID REPLACEMENT_FINGERPRINT
```

For an ordinary rotation of a healthy runner, run host preflight with
`--operation rotate`, register its server capability, then begin rotation with
that capability before using `agora-agent-custody rotate`. Complete server
rotation and commit host custody only after the replacement is validated.

Before server completion, a failed rotation restores and validates the original
credential, stops any restart loop, and keeps the replacement pending until the
operator rolls it back:

```sh
/usr/local/sbin/agora-agent-custody rollback \
  --service agora-agent-runner@my-user.service
npm run agent-keys:operator -- rotate-rollback REPLACEMENT_KEY_ID
```

For a failed initial activation or complete decommission, revoke server authority
first, then encrypted host custody, then the owned artifact. Never clean up a
release while its encrypted credential still exists:

```sh
npm run agent-keys:operator -- deactivate AGENT_PRINCIPAL_ID 'Provisioning rollback'
/usr/local/sbin/agora-agent-custody revoke \
  --service agora-agent-runner@my-user.service
npm run agent-provision:host -- cleanup \
  --digest ARTIFACT_DIGEST \
  --service agora-agent-runner@my-user.service
```

Reboot validation consists of rebooting the host, then repeating the enabled,
active, bounded status, journal, private-message, and cursor checks. Emergency
revocation uses the same server-first deactivate and host revoke ordering.

## Local development

Local development uses the same staged principal, membership-before-key,
encrypted systemd custody, and final-path launcher rules. Its only shortcuts are
explicit and disposable: operator configuration may be discovered from the
loopback `supabase status`, public runner URLs may point to the loopback stack,
and `npm run all-done` plus `supabase db reset` may destroy the local namespace.
These shortcuts are guarded to loopback and are not accepted for a hosted target.

Production supplies the hosted operator configuration through its restricted
session and uses host-key encryption. Never use the null-key test facility,
plaintext files, environment files, command arguments, or a mutable checkout as
production credential or runner custody.

## Failure contract

Operator, host, and custody entrypoints emit one bounded JSON failure containing
`event`, `stage`, `code`, and one copy-safe `recovery` command. Native stderr,
response bodies, keys, prompts, local paths, and arbitrary exception messages are
not included. A failed activation whose cleanup succeeds also reports
`reconciliationCode: cleanup_verified`. If cleanup itself fails, the primary
`stage` is `activation_reconciliation` and bounded `causeStage`/`causeCode`
retain the original activation failure. Run the recovery command, correct the
named stage, then retry from that stage; do not skip ahead to issuance or
activation.
