import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { readBoundedResponse } from '../agent-runner/api-client.mjs'
import { runCommand } from '../agent-keys/command.mjs'
import {
  expectedCustodyLauncherContent,
  expectedLauncherContent,
  parseRunnerEnvironment,
  runnerServiceUser
} from './artifact-installer.mjs'
import { verifyArtifact } from './artifact-manifest.mjs'
import { ProvisioningFailure } from './failure.mjs'

const systemctlPath = '/usr/bin/systemctl'
const runuserPath = '/usr/sbin/runuser'
const digestPattern = /^[a-f0-9]{64}$/

const parseProperties = (source) => Object.fromEntries(
  source.toString('utf8').trim().split('\n').map((line) => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  })
)

const requireOwnedRegular = async (target, mode, ownerUid = 0) => {
  const metadata = await lstat(target)
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.uid !== ownerUid
    || (metadata.mode & 0o777) !== mode
  ) {
    throw new Error('Installed runner file custody is invalid.')
  }
}

const checkRoute = async (url, expectedStatuses, fetchImpl, options = {}) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal })
    await readBoundedResponse(response)
    if (!expectedStatuses.includes(response.status)) throw new Error('Runner route returned an unexpected status.')
  } finally {
    clearTimeout(timeout)
  }
}

const withStage = async ({ code, recovery, stage }, operation) => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ProvisioningFailure) throw error
    throw new ProvisioningFailure({ code, recovery, stage })
  }
}

export const runHostPreflight = async ({
  digest,
  fetchImpl = fetch,
  operation,
  ownerUid = 0,
  roots = {
    config: '/etc/agora-agent-runner',
    custodyLauncher: '/usr/local/sbin/agora-agent-custody',
    launcher: '/usr/local/bin/agora-agent-runner',
    releases: '/opt/agora/releases',
    systemd: '/etc/systemd/system'
  },
  run = runCommand,
  service
}) => {
  if (!digestPattern.test(digest) || !['install', 'rotate'].includes(operation)) {
    throw new Error('Host preflight input is invalid.')
  }
  const user = runnerServiceUser(service)
  const releaseRoot = path.join(roots.releases, digest)
  const recovery = `npm run agent-provision:host -- preflight --digest ${digest} --operation ${operation} --service ${service}`
  await withStage({ code: 'artifact_invalid', recovery, stage: 'artifact_readiness' }, async () => {
    if (await realpath(releaseRoot) !== releaseRoot) throw new Error('noncanonical')
    const artifact = await verifyArtifact(releaseRoot)
    if (artifact.digest !== digest) throw new Error('digest mismatch')
  })

  await withStage({ code: 'launcher_invalid', recovery, stage: 'launcher_readiness' }, async () => {
    await requireOwnedRegular(roots.launcher, 0o755, ownerUid)
    if (await readFile(roots.launcher, 'utf8') !== expectedLauncherContent(releaseRoot)) {
      throw new Error('runner launcher mismatch')
    }
    await requireOwnedRegular(roots.custodyLauncher, 0o755, ownerUid)
    if (await readFile(roots.custodyLauncher, 'utf8') !== expectedCustodyLauncherContent(releaseRoot)) {
      throw new Error('custody launcher mismatch')
    }

    const smoke = await run(roots.launcher, ['installation-check'], { output: 'buffer' })
    const expectedSmoke = { entrypoint: 'canonical', runner: 'agora-agent-runner', version: 1 }
    if (smoke.toString('utf8').trim() !== JSON.stringify(expectedSmoke)) {
      throw new Error('launcher smoke mismatch')
    }
  })

  const unitPath = path.join(roots.systemd, 'agora-agent-runner@.service')
  const artifactUnit = path.join(releaseRoot, 'ops/systemd/agora-agent-runner@.service')
  const configPath = path.join(roots.config, `${user}.conf`)
  const config = await withStage({ code: 'unit_invalid', recovery, stage: 'unit_readiness' }, async () => {
    await requireOwnedRegular(unitPath, 0o644, ownerUid)
    if (!Buffer.from(await readFile(unitPath)).equals(await readFile(artifactUnit))) {
      throw new Error('unit mismatch')
    }
    await requireOwnedRegular(configPath, 0o600, ownerUid)
    const parsedConfig = parseRunnerEnvironment(await readFile(configPath, 'utf8'))
    const state = parseProperties(await run(systemctlPath, [
      'show',
      '--property=ActiveState,FragmentPath,LoadState,UnitFileState',
      service
    ], { output: 'buffer' }))
    if (state.FragmentPath !== unitPath || state.LoadState !== 'loaded') {
      throw new Error('unit not loaded')
    }
    if (operation === 'install' && (state.ActiveState !== 'inactive' || state.UnitFileState !== 'disabled')) {
      throw new Error('initial unit already active')
    }
    if (operation === 'rotate' && (state.ActiveState !== 'active' || state.UnitFileState !== 'enabled')) {
      throw new Error('rotation unit inactive')
    }
    return parsedConfig
  })

  const home = `/home/${user}`
  const codexPath = config.values.get('AGORA_RUNNER_CODEX_BIN')
  await withStage({ code: 'codex_unready', recovery, stage: 'codex_readiness' }, () => (
    run(runuserPath, [
      '-u', user, '--', '/usr/bin/env', '-i',
      `HOME=${home}`,
      `CODEX_HOME=${home}/.codex`,
      'PATH=/usr/local/bin:/usr/bin:/bin',
      codexPath,
      'login',
      'status'
    ])
  ))

  const apiUrl = new URL(config.values.get('AGORA_RUNNER_API_URL'))
  const supabaseUrl = new URL(config.values.get('AGORA_RUNNER_SUPABASE_URL'))
  const publishableKey = config.values.get('AGORA_RUNNER_SUPABASE_PUBLISHABLE_KEY')
  const headers = { apikey: publishableKey }
  const healthUrl = new URL('/functions/v1/health', apiUrl)
  await withStage({ code: 'routes_unreachable', recovery, stage: 'route_readiness' }, async () => {
    await checkRoute(healthUrl, [200], fetchImpl, { headers })
    await checkRoute(apiUrl, [204], fetchImpl, { headers, method: 'OPTIONS' })
    await checkRoute(
      new URL(`/realtime/v1/websocket?apikey=${encodeURIComponent(publishableKey)}&vsn=1.0.0`, supabaseUrl),
      [400, 426],
      fetchImpl
    )
  })

  return { artifactDigest: digest, operation, service, user }
}
