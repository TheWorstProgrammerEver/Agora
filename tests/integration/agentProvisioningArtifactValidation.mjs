import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCommand } from '../../scripts/agent-keys/command.mjs'
import { installRunnerArtifact } from '../../scripts/agent-provisioning/artifact-installer.mjs'
import { buildRunnerArtifact } from '../../scripts/agent-provisioning/build-artifact.mjs'

const fixture = await mkdtemp(path.join(tmpdir(), 'agora-artifact-validation-'))
const config = path.join(fixture, 'runner.conf')
const roots = {
  config: path.join(fixture, 'etc/agora-agent-runner'),
  custodyLauncher: path.join(fixture, 'usr/local/sbin/agora-agent-custody'),
  launcher: path.join(fixture, 'usr/local/bin/agora-agent-runner'),
  releases: path.join(fixture, 'opt/agora/releases'),
  systemd: path.join(fixture, 'etc/systemd/system')
}

try {
  await writeFile(config, [
    'AGORA_RUNNER_API_URL=https://example.supabase.co/functions/v1/agora',
    'AGORA_RUNNER_CODEX_BIN=/home/test/.local/bin/codex',
    'AGORA_RUNNER_SUPABASE_PUBLISHABLE_KEY=public-key',
    'AGORA_RUNNER_SUPABASE_URL=https://example.supabase.co'
  ].join('\n') + '\n', { mode: 0o600 })
  const artifact = await buildRunnerArtifact({ outputRoot: path.join(fixture, 'artifacts') })
  const installed = await installRunnerArtifact({
    artifact: artifact.destination,
    config,
    digest: artifact.digest,
    ownerUid: process.getuid(),
    roots,
    service: 'agora-agent-runner@test.service'
  })
  const launcher = await lstat(roots.launcher)
  const release = await lstat(installed.releaseRoot)

  if (launcher.isSymbolicLink() || !launcher.isFile() || release.isSymbolicLink()) {
    throw new Error('Installed artifact paths are not regular immutable paths.')
  }
  if (await realpath(roots.launcher) !== roots.launcher) {
    throw new Error('Installed runner launcher is not its own canonical path.')
  }
  const output = await runCommand(roots.launcher, ['installation-check'], { output: 'buffer' })
  if (output.toString('utf8').trim() !== JSON.stringify({
    entrypoint: 'canonical',
    runner: 'agora-agent-runner',
    version: 1
  })) {
    throw new Error('Installed final-path launcher did not execute the real runner CLI.')
  }
  if ((await readFile(roots.launcher, 'utf8')).includes(process.cwd())) {
    throw new Error('Installed final-path launcher resolves into the mutable checkout.')
  }
} finally {
  await rm(fixture, { force: true, recursive: true })
}

process.stdout.write('Immutable runner artifact and final-path launcher validation passed.\n')
