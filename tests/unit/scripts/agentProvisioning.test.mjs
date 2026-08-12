import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  artifactDigest,
  buildManifest,
  serializeManifest
} from '../../../scripts/agent-provisioning/artifact-manifest.mjs'
import {
  expectedLauncherContent,
  installRunnerArtifact,
  parseRunnerEnvironment
} from '../../../scripts/agent-provisioning/artifact-installer.mjs'
import {
  createReadinessReceipt,
  parseReadinessReceipt
} from '../../../scripts/agent-provisioning/readiness-receipt.mjs'
import { runHostPreflight } from '../../../scripts/agent-provisioning/host-preflight.mjs'

const fixtures = []
const createFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-provisioning-test-'))
  fixtures.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const createArtifact = async (root) => {
  await mkdir(path.join(root, 'ops/systemd'), { recursive: true })
  await mkdir(path.join(root, 'runtime'), { recursive: true })
  await mkdir(path.join(root, 'scripts/agent-runner'), { recursive: true })
  await writeFile(
    path.join(root, 'ops/systemd/agora-agent-runner@.service'),
    '[Service]\nExecStart=/usr/local/bin/agora-agent-runner run\n'
  )
  await writeFile(path.join(root, 'scripts/agent-runner/cli.mjs'), 'process.exit(0)\n', {
    mode: 0o755
  })
  await writeFile(path.join(root, 'runtime/node'), 'fixture runtime\n', { mode: 0o755 })
  const manifestBytes = Buffer.from(serializeManifest(await buildManifest(root)))
  await writeFile(path.join(root, 'agora-runner-manifest.json'), manifestBytes)
  return artifactDigest(manifestBytes)
}

const configContent = [
  'AGORA_RUNNER_API_URL=https://example.supabase.co/functions/v1/agora',
  'AGORA_RUNNER_CODEX_BIN=/home/test/.local/bin/codex',
  'AGORA_RUNNER_SUPABASE_PUBLISHABLE_KEY=public-key',
  'AGORA_RUNNER_SUPABASE_URL=https://example.supabase.co'
].join('\n') + '\n'

describe('runner artifact installation', () => {
  it('installs a verified release with a regular final-path launcher', async () => {
    const fixture = await createFixture()
    const artifact = path.join(fixture, 'artifact')
    const config = path.join(fixture, 'runner.conf')
    const roots = {
      config: path.join(fixture, 'etc/agora-agent-runner'),
      custodyLauncher: path.join(fixture, 'usr/local/sbin/agora-agent-custody'),
      launcher: path.join(fixture, 'usr/local/bin/agora-agent-runner'),
      releases: path.join(fixture, 'opt/agora/releases'),
      systemd: path.join(fixture, 'etc/systemd/system')
    }
    await mkdir(artifact)
    const digest = await createArtifact(artifact)
    await writeFile(config, configContent, { mode: 0o600 })

    const installed = await installRunnerArtifact({
      artifact,
      config,
      digest,
      ownerUid: process.getuid(),
      roots,
      service: 'agora-agent-runner@test.service'
    })

    expect(await readFile(roots.launcher, 'utf8')).toBe(expectedLauncherContent(installed.releaseRoot))
    expect(await readFile(path.join(roots.config, 'test.conf'), 'utf8')).toBe(configContent)
  })

  it('rejects a symlink occupying the final launcher path without replacing it', async () => {
    const fixture = await createFixture()
    const artifact = path.join(fixture, 'artifact')
    const config = path.join(fixture, 'runner.conf')
    const roots = {
      config: path.join(fixture, 'etc/agora-agent-runner'),
      custodyLauncher: path.join(fixture, 'usr/local/sbin/agora-agent-custody'),
      launcher: path.join(fixture, 'usr/local/bin/agora-agent-runner'),
      releases: path.join(fixture, 'opt/agora/releases'),
      systemd: path.join(fixture, 'etc/systemd/system')
    }
    await mkdir(artifact)
    const digest = await createArtifact(artifact)
    await writeFile(config, configContent, { mode: 0o600 })
    await mkdir(path.dirname(roots.launcher), { recursive: true })
    await symlink(path.join(artifact, 'scripts/agent-runner/cli.mjs'), roots.launcher)

    await expect(installRunnerArtifact({
      artifact,
      config,
      digest,
      ownerUid: process.getuid(),
      roots,
      service: 'agora-agent-runner@test.service'
    })).rejects.toThrow('already exists')
    expect(await readFile(roots.launcher, 'utf8')).toBe('process.exit(0)\n')
  })

  it('rejects a symlinked no-op launcher before service activation', async () => {
    const fixture = await createFixture()
    const artifact = path.join(fixture, 'artifact')
    const config = path.join(fixture, 'runner.conf')
    const roots = {
      config: path.join(fixture, 'etc/agora-agent-runner'),
      custodyLauncher: path.join(fixture, 'usr/local/sbin/agora-agent-custody'),
      launcher: path.join(fixture, 'usr/local/bin/agora-agent-runner'),
      releases: path.join(fixture, 'opt/agora/releases'),
      systemd: path.join(fixture, 'etc/systemd/system')
    }
    await mkdir(artifact)
    const digest = await createArtifact(artifact)
    await writeFile(config, configContent, { mode: 0o600 })
    await installRunnerArtifact({
      artifact,
      config,
      digest,
      ownerUid: process.getuid(),
      roots,
      service: 'agora-agent-runner@test.service'
    })
    const noOp = path.join(fixture, 'successful-no-op')
    await writeFile(noOp, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await unlink(roots.launcher)
    await symlink(noOp, roots.launcher)

    await expect(runHostPreflight({
      digest,
      operation: 'install',
      ownerUid: process.getuid(),
      roots,
      run: async () => Buffer.alloc(0),
      service: 'agora-agent-runner@test.service'
    })).rejects.toMatchObject({
      code: 'launcher_invalid',
      stage: 'launcher_readiness'
    })
  })

  it('proves the complete non-secret host readiness sequence', async () => {
    const fixture = await createFixture()
    const artifact = path.join(fixture, 'artifact')
    const config = path.join(fixture, 'runner.conf')
    const roots = {
      config: path.join(fixture, 'etc/agora-agent-runner'),
      custodyLauncher: path.join(fixture, 'usr/local/sbin/agora-agent-custody'),
      launcher: path.join(fixture, 'usr/local/bin/agora-agent-runner'),
      releases: path.join(fixture, 'opt/agora/releases'),
      systemd: path.join(fixture, 'etc/systemd/system')
    }
    await mkdir(artifact)
    const digest = await createArtifact(artifact)
    await writeFile(config, configContent, { mode: 0o600 })
    await installRunnerArtifact({
      artifact,
      config,
      digest,
      ownerUid: process.getuid(),
      roots,
      service: 'agora-agent-runner@test.service'
    })
    const run = async (file) => {
      if (file === roots.launcher) {
        return Buffer.from(`${JSON.stringify({
          entrypoint: 'canonical',
          runner: 'agora-agent-runner',
          version: 1
        })}\n`)
      }
      if (file === '/usr/bin/systemctl') {
        return Buffer.from([
          'ActiveState=inactive',
          `FragmentPath=${path.join(roots.systemd, 'agora-agent-runner@.service')}`,
          'LoadState=loaded',
          'UnitFileState=disabled'
        ].join('\n'))
      }
      if (file === '/usr/sbin/runuser') return Buffer.alloc(0)
      throw new Error('Unexpected host command')
    }
    const statuses = [200, 204, 400]

    await expect(runHostPreflight({
      digest,
      fetchImpl: async () => new Response(null, { status: statuses.shift() }),
      operation: 'install',
      ownerUid: process.getuid(),
      roots,
      run,
      service: 'agora-agent-runner@test.service'
    })).resolves.toMatchObject({
      artifactDigest: digest,
      operation: 'install',
      service: 'agora-agent-runner@test.service'
    })
    expect(statuses).toEqual([])
  })

  it('rejects credential-bearing public configuration', () => {
    expect(() => parseRunnerEnvironment(`${configContent}AGORA_AGENT_SECRET=value\n`)).toThrow(
      'public configuration is malformed'
    )
  })
})

describe('host readiness receipt', () => {
  it('binds the operation, unit, artifact, and bounded timestamp', () => {
    const now = Date.parse('2026-08-12T10:00:00Z')
    const receipt = createReadinessReceipt({
      artifactDigest: 'a'.repeat(64),
      now,
      operation: 'install',
      service: 'agora-agent-runner@test.service'
    })

    expect(parseReadinessReceipt(receipt, now + 1_000)).toMatchObject({
      artifactDigest: 'a'.repeat(64),
      operation: 'install',
      service: 'agora-agent-runner@test.service'
    })
    expect(() => parseReadinessReceipt(receipt, now + (16 * 60 * 1_000))).toThrow('expired')
  })

  it('rejects a modified receipt', () => {
    const receipt = createReadinessReceipt({
      artifactDigest: 'a'.repeat(64),
      operation: 'install',
      service: 'agora-agent-runner@test.service'
    })
    expect(() => parseReadinessReceipt(receipt.replace('a', 'b'))).toThrow('malformed')
  })
})
