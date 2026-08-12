import { cp, chmod, chown, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyArtifact } from './artifact-manifest.mjs'

const digestPattern = /^[a-f0-9]{64}$/
const userPattern = /^[a-z_][a-z0-9_-]{0,30}$/
const servicePattern = /^agora-agent-runner@([a-z_][a-z0-9_-]{0,30})\.service$/
const allowedConfigKeys = new Set([
  'AGORA_RUNNER_API_URL',
  'AGORA_RUNNER_CODEX_BIN',
  'AGORA_RUNNER_SUPABASE_PUBLISHABLE_KEY',
  'AGORA_RUNNER_SUPABASE_URL'
])

const requireRegular = async (target, label, { privateFile = false } = {}) => {
  const metadata = await lstat(target)
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (privateFile && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error(`${label} must be one regular file.`)
  }
  return metadata
}

const parseEnvironment = (content) => {
  const values = new Map()

  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error('Runner public configuration is malformed.')
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (!allowedConfigKeys.has(key) || values.has(key) || !value || /[\r\n\0]/.test(value)) {
      throw new Error('Runner public configuration is malformed.')
    }
    values.set(key, value)
  }

  if (values.size !== allowedConfigKeys.size) {
    throw new Error('Runner public configuration is incomplete.')
  }

  let apiUrl
  let supabaseUrl
  try {
    apiUrl = new URL(values.get('AGORA_RUNNER_API_URL'))
    supabaseUrl = new URL(values.get('AGORA_RUNNER_SUPABASE_URL'))
  } catch {
    throw new Error('Runner public configuration URL is invalid.')
  }
  if (
    !['http:', 'https:'].includes(apiUrl.protocol)
    || !['http:', 'https:'].includes(supabaseUrl.protocol)
    || apiUrl.origin !== supabaseUrl.origin
    || apiUrl.pathname !== '/functions/v1/agora'
    || apiUrl.search
    || apiUrl.hash
    || apiUrl.username
    || apiUrl.password
    || supabaseUrl.pathname !== '/'
    || supabaseUrl.search
    || supabaseUrl.hash
    || supabaseUrl.username
    || supabaseUrl.password
  ) {
    throw new Error('Runner public configuration URL is invalid.')
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(values.get('AGORA_RUNNER_CODEX_BIN'))) {
    throw new Error('Runner public Codex path is invalid.')
  }
  if (!/^[A-Za-z0-9._-]{1,512}$/.test(values.get('AGORA_RUNNER_SUPABASE_PUBLISHABLE_KEY'))) {
    throw new Error('Runner public project key is invalid.')
  }

  const serialized = Array.from(values.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n'

  if (/agora_agent_v1_|(?:SECRET|TOKEN|PRIVATE_KEY|SERVICE_ROLE)/i.test(serialized)) {
    throw new Error('Runner public configuration contains a forbidden credential field.')
  }

  return { serialized, values }
}

const protectTree = async (root, ownerUid) => {
  const metadata = await lstat(root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Installed runner artifact root is invalid.')
  }

  await chown(root, ownerUid, ownerUid)
  await chmod(root, 0o755)
  for (const name of await readdir(root)) {
    const target = path.join(root, name)
    const child = await lstat(target)
    if (child.isDirectory()) await protectTree(target, ownerUid)
    else {
      await chown(target, ownerUid, ownerUid)
      await chmod(target, child.mode & 0o111 ? 0o755 : 0o644)
    }
  }
}

const launcherContent = (releaseRoot) => `#!/bin/sh\nexec '${releaseRoot}/runtime/node' '${releaseRoot}/scripts/agent-runner/cli.mjs' "$@"\n`
const custodyLauncherContent = (releaseRoot) => `#!/bin/sh\nexec '${releaseRoot}/runtime/node' '${releaseRoot}/scripts/agent-keys/systemd-credential-launcher.mjs' "$@"\n`

const requireService = (service) => {
  const match = servicePattern.exec(service)
  if (!match || !userPattern.test(match[1])) throw new Error('Runner service instance is malformed.')
  return match[1]
}

const pathExists = async (target) => {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export const installRunnerArtifact = async ({
  artifact,
  config,
  digest,
  ownerUid = 0,
  roots = {
    config: '/etc/agora-agent-runner',
    custodyLauncher: '/usr/local/sbin/agora-agent-custody',
    launcher: '/usr/local/bin/agora-agent-runner',
    releases: '/opt/agora/releases',
    systemd: '/etc/systemd/system'
  },
  service
}) => {
  if (!digestPattern.test(digest)) throw new Error('Runner artifact digest is malformed.')
  const user = requireService(service)
  const artifactInput = path.resolve(artifact)
  const sourceRoot = await realpath(artifactInput)
  const sourceMetadata = await lstat(artifactInput)
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error('Runner artifact source path is not canonical.')
  }
  const sourceVerification = await verifyArtifact(sourceRoot)
  if (sourceVerification.digest !== digest) throw new Error('Runner artifact digest does not match.')

  const configInput = path.resolve(config)
  await requireRegular(configInput, 'Runner public configuration', { privateFile: true })
  const configSource = await realpath(configInput)
  await requireRegular(configSource, 'Runner public configuration', { privateFile: true })
  const publicConfig = parseEnvironment(await readFile(configSource, 'utf8'))
  const releaseRoot = path.join(roots.releases, digest)
  const temporaryRelease = path.join(roots.releases, `.${digest}.installing`)
  const installedUnit = path.join(roots.systemd, 'agora-agent-runner@.service')
  const installedConfig = path.join(roots.config, `${user}.conf`)
  const ownedTargets = [releaseRoot, roots.launcher, roots.custodyLauncher, installedUnit, installedConfig]

  await mkdir(roots.releases, { mode: 0o755, recursive: true })
  if (await pathExists(temporaryRelease) || (await Promise.all(ownedTargets.map(pathExists))).some(Boolean)) {
    throw new Error('Runner artifact destination already exists and requires explicit reconciliation.')
  }

  try {
    await cp(sourceRoot, temporaryRelease, { recursive: true })
    const installedVerification = await verifyArtifact(temporaryRelease)
    if (installedVerification.digest !== digest) throw new Error('Installed runner artifact verification failed.')
    await protectTree(temporaryRelease, ownerUid)
    await rename(temporaryRelease, releaseRoot)

    await mkdir(path.dirname(roots.launcher), { mode: 0o755, recursive: true })
    await writeFile(roots.launcher, launcherContent(releaseRoot), { flag: 'wx', mode: 0o755 })
    await chown(roots.launcher, ownerUid, ownerUid)
    await mkdir(path.dirname(roots.custodyLauncher), { mode: 0o755, recursive: true })
    await writeFile(roots.custodyLauncher, custodyLauncherContent(releaseRoot), {
      flag: 'wx',
      mode: 0o755
    })
    await chown(roots.custodyLauncher, ownerUid, ownerUid)

    await mkdir(roots.systemd, { mode: 0o755, recursive: true })
    await cp(path.join(releaseRoot, 'ops/systemd/agora-agent-runner@.service'), installedUnit, {
      errorOnExist: true,
      force: false
    })
    await chown(installedUnit, ownerUid, ownerUid)
    await chmod(installedUnit, 0o644)

    await mkdir(roots.config, { mode: 0o700, recursive: true })
    await writeFile(installedConfig, publicConfig.serialized, { flag: 'wx', mode: 0o600 })
    await chown(installedConfig, ownerUid, ownerUid)

    return { codexPath: publicConfig.values.get('AGORA_RUNNER_CODEX_BIN'), releaseRoot, user }
  } catch (error) {
    await rm(temporaryRelease, { force: true, recursive: true })
    for (const target of ownedTargets.toReversed()) {
      await rm(target, { force: true, recursive: target === releaseRoot })
    }
    throw error
  }
}

export const expectedLauncherContent = launcherContent
export const expectedCustodyLauncherContent = custodyLauncherContent
export const parseRunnerEnvironment = parseEnvironment
export const runnerServiceUser = requireService
