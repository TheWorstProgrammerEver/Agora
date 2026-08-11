#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { SystemdCredentialStore } from './systemd-credential-store.mjs'
import { createSystemdServiceControl } from './systemd-service.mjs'
import { readSecretFromTty } from './tty-secret.mjs'
import { validateFingerprint } from './key-format.mjs'

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
  const store = createStore
    ? createStore({ validateActive: serviceControl?.restartAndValidate })
    : new SystemdCredentialStore({ validateActive: serviceControl?.restartAndValidate })

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
    process.stderr.write(`ERROR: ${error.message}\n`)
    process.exitCode = 1
  })
}
