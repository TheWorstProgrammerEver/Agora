import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  artifactDigest,
  buildManifest,
  serializeManifest
} from '../../../scripts/agent-provisioning/artifact-manifest.mjs'
import {
  expectedLauncherContent,
  installRunnerArtifact,
  parseRunnerEnvironment,
  runnerReleaseRoot
} from '../../../scripts/agent-provisioning/artifact-installer.mjs'
import {
  buildRunnerArtifact,
  resolveNpmEntrypoint
} from '../../../scripts/agent-provisioning/build-artifact.mjs'
import { runHostCommand } from '../../../scripts/agent-provisioning/host-cli.mjs'
import { writeProvisioningFailure } from '../../../scripts/agent-provisioning/failure.mjs'
import {
  createReadinessReceipt,
  parseReadinessReceipt
} from '../../../scripts/agent-provisioning/readiness-receipt.mjs'
import { runHostPreflight } from '../../../scripts/agent-provisioning/host-preflight.mjs'

const fixtures = []
const principalId = '11111111-1111-4111-8111-111111111111'
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
  const servicePath = path.join(root, 'ops/systemd/agora-agent-runner@.service')
  const cliPath = path.join(root, 'scripts/agent-runner/cli.mjs')
  const runtimePath = path.join(root, 'runtime/node')
  await writeFile(
    servicePath,
    '[Service]\nExecStart=/usr/local/bin/agora-agent-runner run\n',
    { mode: 0o644 }
  )
  await writeFile(cliPath, 'process.exit(0)\n', { mode: 0o755 })
  await writeFile(runtimePath, 'fixture runtime\n', { mode: 0o755 })
  await chmod(servicePath, 0o644)
  await chmod(cliPath, 0o755)
  await chmod(runtimePath, 0o755)
  const manifestBytes = Buffer.from(serializeManifest(await buildManifest(root)))
  await writeFile(path.join(root, 'agora-runner-manifest.json'), manifestBytes, { mode: 0o644 })
  return artifactDigest(manifestBytes)
}

const configContent = [
  'AGORA_RUNNER_API_URL=https://example.supabase.co/functions/v1/agora',
  'AGORA_RUNNER_CODEX_BIN=/home/test/.local/bin/codex',
  'AGORA_RUNNER_SUPABASE_PUBLISHABLE_KEY=public-key',
  'AGORA_RUNNER_SUPABASE_URL=https://example.supabase.co'
].join('\n') + '\n'

describe('runner artifact installation', () => {
  it.each([
    '../outside',
    '/etc',
    'a/../b',
    'A'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65)
  ])('rejects unsafe release digest %j before deriving a cleanup path', async (digest) => {
    const fixture = await createFixture()
    const outside = path.join(fixture, 'outside')
    const roots = {
      config: path.join(fixture, 'etc/agora-agent-runner'),
      custodyLauncher: path.join(fixture, 'usr/local/sbin/agora-agent-custody'),
      launcher: path.join(fixture, 'usr/local/bin/agora-agent-runner'),
      releases: path.join(fixture, 'opt/agora/releases'),
      systemd: path.join(fixture, 'etc/systemd/system')
    }
    await mkdir(outside)
    await writeFile(path.join(outside, 'sentinel'), 'unchanged')
    const run = vi.fn()

    await expect(runHostCommand([
      'cleanup', '--digest', digest, '--service', 'agora-agent-runner@test.service'
    ], { getUid: () => 0, roots, run })).rejects.toThrow('digest is malformed')
    expect(run).not.toHaveBeenCalled()
    expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('unchanged')
  })

  it('derives a release as exactly one owned child', () => {
    const releases = '/opt/agora/releases'
    const digest = 'a'.repeat(64)
    expect(runnerReleaseRoot(releases, digest)).toBe(path.join(releases, digest))
  })

  it('reports a retryable artifact reload transition after publication', async () => {
    const digest = 'a'.repeat(64)
    const service = 'agora-agent-runner@test.service'
    const install = vi.fn(async () => ({ user: 'test' }))
    const verifyInstalled = vi.fn(async () => {})
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('native reload marker'))
      .mockResolvedValueOnce(Buffer.alloc(0))
    const recovery = `npm run agent-provision:host -- reload-artifact --digest ${digest} --service ${service}`

    const failure = await runHostCommand([
      'install-artifact', '--artifact', '/artifact', '--config', '/config', '--digest', digest,
      '--service', service
    ], { getUid: () => 0, install, run }).catch((error) => error)
    expect(failure).toMatchObject({
      code: 'daemon_reload_failed',
      recovery,
      stage: 'artifact_reload'
    })
    const failureOutput = []
    writeProvisioningFailure(failure, {
      code: 'host_command_failed',
      recovery: 'npm run agent-provision:host -- --help',
      stage: 'host'
    }, (value) => failureOutput.push(value))
    expect(JSON.parse(failureOutput.join(''))).toEqual({
      code: 'daemon_reload_failed',
      event: 'provisioning_failed',
      recovery,
      stage: 'artifact_reload'
    })
    expect(failureOutput.join('')).not.toContain('native reload marker')

    const output = []
    await expect(runHostCommand([
      'reload-artifact', '--digest', digest, '--service', service
    ], {
      getUid: () => 0,
      run,
      verifyInstalled,
      write: (value) => output.push(value)
    })).resolves.toBeUndefined()
    expect(install).toHaveBeenCalledTimes(1)
    expect(verifyInstalled).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(output.join('')).toContain('artifact_reload_complete')
  })

  it('invokes npm through the active Node runtime when npm is outside child PATH', async () => {
    const fixture = await createFixture()
    const npmCli = path.join(fixture, 'private-toolchain/lib/node_modules/npm/bin/npm-cli.js')
    await mkdir(path.dirname(npmCli), { recursive: true })
    await writeFile(npmCli, 'process.exit(0)\n')
    const canonicalNpmCli = await realpath(npmCli)
    expect(await resolveNpmEntrypoint(npmCli)).toBe(canonicalNpmCli)

    const run = vi.fn(async () => Buffer.alloc(0))
    await buildRunnerArtifact({
      outputRoot: path.join(fixture, 'artifacts'),
      resolveNpm: async () => canonicalNpmCli,
      run
    })

    expect(run).toHaveBeenCalledWith(
      process.execPath,
      [canonicalNpmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it('rejects a symlink used as the artifact source argument', async () => {
    const fixture = await createFixture()
    const artifact = path.join(fixture, 'artifact')
    const artifactLink = path.join(fixture, 'artifact-link')
    const config = path.join(fixture, 'runner.conf')
    await mkdir(artifact)
    const digest = await createArtifact(artifact)
    await symlink(artifact, artifactLink)
    await writeFile(config, configContent, { mode: 0o600 })

    await expect(installRunnerArtifact({
      artifact: artifactLink,
      config,
      digest,
      ownerUid: process.getuid(),
      roots: {
        config: path.join(fixture, 'etc/agora-agent-runner'),
        custodyLauncher: path.join(fixture, 'usr/local/sbin/agora-agent-custody'),
        launcher: path.join(fixture, 'usr/local/bin/agora-agent-runner'),
        releases: path.join(fixture, 'opt/agora/releases'),
        systemd: path.join(fixture, 'etc/systemd/system')
      },
      service: 'agora-agent-runner@test.service'
    })).rejects.toThrow('source path is not canonical')
  })

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

    const run = vi.fn(async () => Buffer.alloc(0))
    await runHostCommand([
      'reload-artifact', '--digest', digest, '--service', 'agora-agent-runner@test.service'
    ], { getUid: () => 0, roots, run, write: () => {} })
    expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/systemctl', ['daemon-reload'])
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
      principal: principalId,
      roots,
      run: async () => Buffer.alloc(0),
      service: 'agora-agent-runner@test.service'
    })).rejects.toMatchObject({
      code: 'launcher_invalid',
      stage: 'launcher_readiness'
    })
  })

  it.each(['install', 'recover'])('proves %s host readiness below a canonical final entry with an aliased ancestor', async (operation) => {
    const fixture = await createFixture()
    const artifact = path.join(fixture, 'artifact')
    const config = path.join(fixture, 'runner.conf')
    const installedRoot = path.join(fixture, 'installed-root')
    const installedAlias = path.join(fixture, 'installed-alias')
    await mkdir(installedRoot)
    await symlink(installedRoot, installedAlias, 'dir')
    const roots = {
      config: path.join(installedAlias, 'etc/agora-agent-runner'),
      custodyLauncher: path.join(installedAlias, 'usr/local/sbin/agora-agent-custody'),
      launcher: path.join(installedAlias, 'usr/local/bin/agora-agent-runner'),
      releases: path.join(installedAlias, 'opt/agora/releases'),
      systemd: path.join(installedAlias, 'etc/systemd/system')
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
      operation,
      ownerUid: process.getuid(),
      principal: principalId,
      roots,
      run,
      service: 'agora-agent-runner@test.service'
    })).resolves.toMatchObject({
      artifactDigest: digest,
      agentPrincipalId: principalId,
      operation,
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
      agentPrincipalId: principalId,
      artifactDigest: 'a'.repeat(64),
      now,
      operation: 'install',
      service: 'agora-agent-runner@test.service'
    })

    expect(parseReadinessReceipt(receipt, now + 1_000)).toMatchObject({
      agentPrincipalId: principalId,
      artifactDigest: 'a'.repeat(64),
      operation: 'install',
      service: 'agora-agent-runner@test.service'
    })
    expect(() => parseReadinessReceipt(receipt, now + (16 * 60 * 1_000))).toThrow('expired')
  })

  it('rejects a modified receipt', () => {
    const receipt = createReadinessReceipt({
      agentPrincipalId: principalId,
      artifactDigest: 'a'.repeat(64),
      operation: 'install',
      service: 'agora-agent-runner@test.service'
    })
    expect(() => parseReadinessReceipt(receipt.replace('a', 'b'))).toThrow('malformed')
  })

  it('binds readiness evidence to exactly one principal', () => {
    const otherPrincipalId = randomUUID()
    const receipt = createReadinessReceipt({
      agentPrincipalId: principalId,
      artifactDigest: 'a'.repeat(64),
      operation: 'install',
      service: 'agora-agent-runner@test.service'
    })

    expect(parseReadinessReceipt(receipt).agentPrincipalId).not.toBe(otherPrincipalId)
  })
})
