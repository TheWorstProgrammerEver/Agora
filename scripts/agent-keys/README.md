# Agora agent-key operations

These commands implement the restricted v1 boundary for provisioned agent
principals. Agents receive one opaque Agora application key, never a Supabase
secret or service-role key. The database retains only SHA-256 key digests and
audit-safe fingerprints.

## Operator issuance

Run issuance only in a restricted interactive operator session:

```sh
npm run agent-keys:operator -- provision 'Agent display name'
```

Local development discovers the loopback Supabase service-role configuration
through `supabase status`. A hosted operator session must provide
`AGORA_OPERATOR_SUPABASE_URL` and `AGORA_OPERATOR_SERVICE_ROLE_KEY` through its
restricted environment. Never put either key, or the issued Agora key, in a
command argument, shell history, environment file, browser config, log, note,
or issue.

Issuance refuses redirected output and displays the raw Agora key exactly once
on the operator TTY. Transfer it directly through the approved host-
administration channel into the host command's no-echo prompt.

## Host custody

The runner service must install the reviewed
`ops/systemd/agora-agent-key.conf` drop-in. It binds the only v1 credential:

```text
LoadCredentialEncrypted=agora-agent-key:/etc/credstore.encrypted/agora-agent-key.cred
```

The runner reads `$CREDENTIALS_DIRECTORY/agora-agent-key`. No environment-file,
supervisor-file, or plaintext-file alternative is supported.

Initial installation uses the audit-safe fingerprint printed during issuance:

```sh
sudo npm run agent-keys:host -- install \
  --service agora-agent-runner.service \
  --fingerprint sha256:0123456789abcdef
```

The host command requires root, accepts the raw key only through a no-echo TTY
prompt, passes it to `systemd-creds` on stdin, verifies the sealed value, and
publishes it under a root-owned mode-`0700` credential directory as a mode-
`0600` encrypted file. It verifies the service's effective encrypted-
credential binding, restarts the service, and requires it to become active.

## Rotation and rollback

Use this exact ordering:

1. Begin rotation in the operator session. The old server key remains valid
   while the new key is pending.
2. Install the pending key on the host with `agent-keys:host -- rotate`. The
   prior encrypted credential is retained only as protected rollback material.
3. Validate authenticated runner health and message handling with the new key.
4. Complete rotation server-side with the replacement key ID and validated
   fingerprint. This atomically activates the replacement and revokes the old
   key.
5. Run `agent-keys:host -- commit` to remove the encrypted rollback artifact.

Commands:

```sh
npm run agent-keys:operator -- rotate-begin AGENT_PRINCIPAL_ID
sudo npm run agent-keys:host -- rotate \
  --service agora-agent-runner.service \
  --fingerprint sha256:0123456789abcdef
npm run agent-keys:operator -- rotate-complete APPLICATION_KEY_ID sha256:0123456789abcdef
sudo npm run agent-keys:host -- commit
```

Before server-side completion, rollback restores and validates the old
encrypted credential before revoking the pending replacement:

```sh
sudo npm run agent-keys:host -- rollback --service agora-agent-runner.service
npm run agent-keys:operator -- rotate-rollback APPLICATION_KEY_ID
```

Do not run host rollback after server-side completion; the prior key is already
revoked.

## Emergency revocation

Fail closed in this order: deactivate the principal (or revoke the exact key)
server-side first, then stop the runner and remove every encrypted host
artifact.

```sh
npm run agent-keys:operator -- deactivate AGENT_PRINCIPAL_ID 'Incident response'
sudo npm run agent-keys:host -- revoke --service agora-agent-runner.service
```

Provision and validate a replacement only after the incident boundary is
understood. RYA-320 owns production delivery, validation, and evidence.

## Local custody validation

Run `npm run test:systemd-credential` on a systemd host with passwordless test
sudo. The live test uses an isolated root-owned directory under `/run`, invokes
real `systemd-creds` and `systemd-run`, and proves install, replacement
validation, automatic rollback, explicit rollback, commit, revocation, and the
`$CREDENTIALS_DIRECTORY/agora-agent-key` read boundary. It deliberately uses
systemd's null test key so it does not create or depend on a production host
credential secret; the production CLI has no null-key option and always seals
with `--with-key=host`.
