#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { SystemdCredentialStore } from './systemd-credential-store.mjs'
import { createSystemdServiceControl } from './systemd-service.mjs'
import { readSecretFromTty } from './tty-secret.mjs'
import { validateFingerprint } from './key-format.mjs'
import { writeProvisioningFailure } from '../agent-provisioning/failure.mjs'

const usage = `Usage:
  systemd-credential-cli.mjs install --service UNIT --fingerprint sha256:...
  systemd-credential-cli.mjs rotate --service UNIT --fingerprint sha256:...
  systemd-credential-cli.mjs commit
  systemd-credential-cli.mjs rollback --service UNIT
  systemd-credential-cli.mjs revoke --service UNIT`

const parseOptions = (args) => {
  const [command, ...optionArgs] = args
  const options = {}

  for (let index = 0; index < optionArgs.length; index += 2) {
    const name = optionArgs[index]
    const value = optionArgs[index + 1]

    if (!['--fingerprint', '--service'].includes(name) || value === undefined) {
      throw new Error(usage)
    }

    options[name.slice(2)] = value
  }

  return { command, options }
}

const projectedCode = (error, command) => {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Agora agent keys must be entered through an interactive TTY.') return 'tty_required'
  if (message === 'Agora agent key does not match the expected fingerprint.') return 'fingerprint_mismatch'
  if (message === 'Agora agent key entry was cancelled.') return 'entry_canceled'
  if (message === 'Agora agent key TTY state could not be restored.') return 'tty_restore_failed'
  if (message === 'An encrypted Agora agent credential already exists.') return 'credential_conflict'
  return `${['install', 'rotate', 'commit', 'rollback', 'revoke'].includes(command) ? command : 'credential'}_failed`
}

const projectedRecovery = (args, command) => {
  const serviceIndex = args.indexOf('--service')
  const fingerprintIndex = args.indexOf('--fingerprint')
  const service = serviceIndex >= 0 ? args[serviceIndex + 1] : undefined
  const fingerprint = fingerprintIndex >= 0 ? args[fingerprintIndex + 1] : undefined

  if (
    ['install', 'rotate'].includes(command)
    && servicePattern.test(service ?? '')
    && /^sha256:[a-f0-9]{16}$/.test(fingerprint ?? '')
  ) {
    return `/usr/local/sbin/agora-agent-custody ${command} --service ${service} --fingerprint ${fingerprint}`
  }
  if (servicePattern.test(service ?? '')) {
    if (command === 'revoke') return `sudo systemctl disable --now ${service}`
    if (command === 'rollback') return `/usr/local/sbin/agora-agent-custody rollback --service ${service}`
    return `sudo systemctl reset-failed ${service}`
  }
  if (command === 'commit') return '/usr/local/sbin/agora-agent-custody commit'
  return '/usr/local/sbin/agora-agent-custody --help'
}

const servicePattern = /^[A-Za-z0-9@_.:-]+\.service$/

export const runCredentialCommand = async (args, {
  createServiceControl = createSystemdServiceControl,
  createStore,
  getUid = () => process.getuid?.(),
  readSecret = readSecretFromTty,
  write = (message) => process.stdout.write(message)
} = {}) => {
  if (getUid() !== 0) {
    throw new Error('Systemd credential custody commands must run as root.')
  }

  const { command, options } = parseOptions(args)
  const needsService = ['install', 'rotate', 'rollback', 'revoke'].includes(command)
  const serviceControl = needsService
    ? createServiceControl({ service: options.service })
    : undefined
  const validateActive = command === 'install'
    ? serviceControl?.activateAndValidate
    : serviceControl?.restartAndValidate
  const store = createStore
    ? createStore({ validateActive })
    : new SystemdCredentialStore({ validateActive })

  if (command === 'commit') {
    if (options.service || options.fingerprint) {
      throw new Error(usage)
    }
    await store.commitRotation()
    write('Encrypted credential rotation committed.\n')
    return
  }

  if (command === 'rollback') {
    if (!options.service || options.fingerprint) {
      throw new Error(usage)
    }
    await store.rollbackRotation()
    write('Encrypted credential rotation rolled back.\n')
    return
  }

  if (command === 'revoke') {
    if (!options.service || options.fingerprint) {
      throw new Error(usage)
    }
    await store.revoke(serviceControl.stop)
    write('Encrypted Agora agent credential removed.\n')
    return
  }

  if (!['install', 'rotate'].includes(command) || !options.service || !options.fingerprint) {
    throw new Error(usage)
  }

  const expectedFingerprint = validateFingerprint(options.fingerprint)
  const applicationKey = await readSecret()

  try {
    const installedFingerprint = command === 'install'
      ? await store.install(applicationKey, expectedFingerprint)
      : await store.rotate(applicationKey, expectedFingerprint)

    write(`Encrypted credential ${command === 'install' ? 'installed' : 'rotated'}: ${installedFingerprint}\n`)
    if (command === 'rotate') {
      write('Validate authenticated runner behavior before completing server-side rotation.\n')
    }
  } finally {
    applicationKey.fill(0)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCredentialCommand(process.argv.slice(2)).catch((error) => {
    const command = process.argv[2]
    writeProvisioningFailure(error, {
      code: projectedCode(error, command),
      recovery: projectedRecovery(process.argv.slice(2), command),
      stage: `credential_${['install', 'rotate', 'commit', 'rollback', 'revoke'].includes(command) ? command : 'command'}`
    })
    process.exitCode = 1
  })
}
