import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runAsRoot } from '../../scripts/agent-keys/elevated-node.mjs'

const facilityPath = fileURLToPath(new URL(
  './agentRunnerSystemdHandoff.mjs',
  import.meta.url
))
const productionUnitPath = fileURLToPath(new URL(
  '../../ops/systemd/agora-agent-runner@.service',
  import.meta.url
))

const validateProductionUnit = async () => {
  const root = await mkdtemp('/tmp/agora-runner-systemd-verify-')
  try {
    await Promise.all([
      mkdir(`${root}/etc/agora-agent-runner`, { recursive: true }),
      mkdir(`${root}/etc/credstore.encrypted`, { recursive: true }),
      mkdir(`${root}/etc/systemd/system`, { recursive: true }),
      mkdir(`${root}/run/agora-agent-runner-handler-root`, { recursive: true }),
      mkdir(`${root}/usr/local/bin`, { recursive: true }),
      mkdir(`${root}/var/lib/agora-agent-runner-root/codex`, { recursive: true })
    ])
    await Promise.all([
      copyFile(productionUnitPath, `${root}/etc/systemd/system/agora-agent-runner@.service`),
      writeFile(`${root}/etc/agora-agent-runner/root.conf`, (
        'AGORA_RUNNER_API_URL=https://example.invalid/functions/v1/agora\n'
      )),
      writeFile(`${root}/etc/group`, 'root:x:0:\n'),
      writeFile(`${root}/etc/passwd`, 'root:x:0:0:root:/root:/bin/sh\n'),
      ...['basic', 'multi-user', 'network-online', 'sysinit'].map((target) => (
        writeFile(
          `${root}/etc/systemd/system/${target}.target`,
          `[Unit]\nDescription=Validation ${target} target\n`
        )
      )),
      writeFile(`${root}/usr/local/bin/agora-agent-runner`, '#!/bin/sh\nexit 0\n', {
        mode: 0o755
      })
    ])
    await chmod(`${root}/usr/local/bin/agora-agent-runner`, 0o755)
    execFileSync('/usr/bin/systemd-analyze', [
      `--root=${root}`,
      'verify',
      'agora-agent-runner@root.service'
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch {
    throw new Error('Production agent runner systemd unit verification failed.')
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

await validateProductionUnit()

const code = await runAsRoot({
  args: [
    process.cwd(),
    String(process.getuid?.()),
    String(process.getgid?.()),
    process.execPath
  ],
  entrypoint: facilityPath
})

if (code !== 0) {
  throw new Error('Live systemd agent runner validation failed.')
}

process.stdout.write('Live systemd runner install, restart, resume, health, and credential validation passed.\n')
