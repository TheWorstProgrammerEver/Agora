#!/usr/bin/env node
import { lstat, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runCommand } from '../agent-keys/command.mjs'
import { credentialPath } from '../agent-keys/systemd-credential-store.mjs'
import {
  expectedCustodyLauncherContent,
  expectedLauncherContent,
  installRunnerArtifact,
  runnerServiceUser
} from './artifact-installer.mjs'
import { runHostPreflight } from './host-preflight.mjs'
import { createReadinessReceipt } from './readiness-receipt.mjs'
import { writeProvisioningFailure } from './failure.mjs'

const usage = `Usage:
  host-cli.mjs install-artifact --artifact DIRECTORY --config FILE --digest SHA256 --service UNIT
  host-cli.mjs preflight --principal AGENT_PRINCIPAL_ID --digest SHA256 --operation install|recover|rotate --service UNIT
  host-cli.mjs cleanup --digest SHA256 --service UNIT`
const systemctlPath = '/usr/bin/systemctl'
const roots = {
  config: '/etc/agora-agent-runner',
  custodyLauncher: '/usr/local/sbin/agora-agent-custody',
  launcher: '/usr/local/bin/agora-agent-runner',
  releases: '/opt/agora/releases',
  systemd: '/etc/systemd/system'
}

const parseOptions = (args) => {
  const [command, ...pairs] = args
  if (pairs.length % 2 !== 0) throw new Error(usage)
  const options = {}

  for (let index = 0; index < pairs.length; index += 2) {
    const name = pairs[index]
    if (!['--artifact', '--config', '--digest', '--operation', '--principal', '--service'].includes(name)) {
      throw new Error(usage)
    }
    if (options[name.slice(2)] !== undefined) throw new Error(usage)
    options[name.slice(2)] = pairs[index + 1]
  }

  return { command, options }
}

const exists = async (target) => {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

const cleanup = async ({ digest, service }, run) => {
  const user = runnerServiceUser(service)
  const releaseRoot = path.join(roots.releases, digest)
  const unit = path.join(roots.systemd, 'agora-agent-runner@.service')
  const config = path.join(roots.config, `${user}.conf`)

  if (await exists(credentialPath)) {
    throw new Error('Encrypted runner credential must be revoked before artifact cleanup.')
  }
  if (await readFile(roots.launcher, 'utf8') !== expectedLauncherContent(releaseRoot)) {
    throw new Error('Runner launcher ownership cannot be proven for cleanup.')
  }
  if (await readFile(roots.custodyLauncher, 'utf8') !== expectedCustodyLauncherContent(releaseRoot)) {
    throw new Error('Runner custody launcher ownership cannot be proven for cleanup.')
  }
  if (!Buffer.from(await readFile(unit)).equals(
    await readFile(path.join(releaseRoot, 'ops/systemd/agora-agent-runner@.service'))
  )) {
    throw new Error('Runner unit ownership cannot be proven for cleanup.')
  }

  await run(systemctlPath, ['disable', '--now', service])
  await run(systemctlPath, ['reset-failed', service])
  for (const target of [config, unit, roots.launcher, roots.custodyLauncher, releaseRoot]) {
    await rm(target, { recursive: target === releaseRoot })
  }
  await run(systemctlPath, ['daemon-reload'])
}

export const runHostCommand = async (args, {
  getUid = () => process.getuid?.(),
  install = installRunnerArtifact,
  preflight = runHostPreflight,
  run = runCommand,
  write = process.stdout.write.bind(process.stdout)
} = {}) => {
  if (getUid() !== 0) throw new Error('Host provisioning commands must run as root.')
  const { command, options } = parseOptions(args)

  if (command === '--help' || command === '-h') {
    if (Object.keys(options).length > 0) throw new Error(usage)
    write(`${usage}\n`)
    return
  }

  if (command === 'install-artifact') {
    if (!options.artifact || !options.config || !options.digest || !options.service || options.operation || options.principal) {
      throw new Error(usage)
    }
    const installed = await install({ ...options, roots })
    await run(systemctlPath, ['daemon-reload'])
    write(`${JSON.stringify({
      artifactDigest: options.digest,
      service: options.service,
      stage: 'artifact_installed',
      user: installed.user
    })}\n`)
    return
  }

  if (command === 'preflight') {
    if (!options.digest || !options.operation || !options.principal || !options.service || options.artifact || options.config) {
      throw new Error(usage)
    }
    await preflight({ ...options, roots, run })
    write(`${createReadinessReceipt({
      agentPrincipalId: options.principal,
      artifactDigest: options.digest,
      operation: options.operation,
      service: options.service
    })}\n`)
    return
  }

  if (command === 'cleanup') {
    if (!options.digest || !options.service || options.artifact || options.config || options.operation || options.principal) {
      throw new Error(usage)
    }
    await cleanup(options, run)
    write(`${JSON.stringify({ service: options.service, stage: 'cleanup_complete' })}\n`)
    return
  }

  throw new Error(usage)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHostCommand(process.argv.slice(2)).catch((error) => {
    writeProvisioningFailure(error, {
      code: 'host_command_failed',
      recovery: 'npm run agent-provision:host -- --help',
      stage: 'host'
    })
    process.exitCode = 1
  })
}
