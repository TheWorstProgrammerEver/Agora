import { runCommand } from './command.mjs'
import { credentialName, credentialPath } from './systemd-credential-store.mjs'

const systemctlPath = '/usr/bin/systemctl'
const busctlPath = '/usr/bin/busctl'
const servicePattern = /^[A-Za-z0-9@_.:-]+\.service$/
const unitObjectPathPattern = /^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/

export const validateServiceName = (service) => {
  if (!servicePattern.test(service)) {
    throw new Error('Systemd service name is malformed.')
  }

  return service
}

const parseJsonOutput = (output, expectedType) => {
  let parsed

  try {
    parsed = JSON.parse(output.toString('utf8'))
  } catch {
    throw new Error('Systemd returned malformed credential metadata.')
  }

  if (parsed?.type !== expectedType || !Array.isArray(parsed.data)) {
    throw new Error('Systemd returned unexpected credential metadata.')
  }

  return parsed.data
}

export const createSystemdServiceControl = ({
  expectedCredentialName = credentialName,
  expectedCredentialPath = credentialPath,
  run = runCommand,
  service
}) => {
  const validatedService = validateServiceName(service)

  return {
    restartAndValidate: async () => {
      await run(systemctlPath, ['daemon-reload'])
      const unitOutput = await run(busctlPath, [
        '--json=short',
        'call',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager',
        'GetUnit',
        's',
        validatedService
      ], { output: 'buffer' })
      const [unitObjectPath] = parseJsonOutput(unitOutput, 'o')

      if (!unitObjectPathPattern.test(unitObjectPath)) {
        throw new Error('Systemd returned an invalid runner service object path.')
      }

      const bindingOutput = await run(busctlPath, [
        '--json=short',
        'get-property',
        'org.freedesktop.systemd1',
        unitObjectPath,
        'org.freedesktop.systemd1.Service',
        'LoadCredentialEncrypted'
      ], { output: 'buffer' })
      const bindings = parseJsonOutput(bindingOutput, 'a(ss)')

      if (
        bindings.length !== 1
        || bindings[0]?.[0] !== expectedCredentialName
        || bindings[0]?.[1] !== expectedCredentialPath
      ) {
        throw new Error('Runner service does not load the approved encrypted credential path.')
      }

      await run(systemctlPath, ['restart', validatedService])
      await run(systemctlPath, ['is-active', '--quiet', validatedService])
    },
    stop: async () => {
      await run(systemctlPath, ['stop', validatedService])
      const activeState = await run(systemctlPath, [
        'show',
        '--property=ActiveState',
        '--value',
        validatedService
      ], { output: 'buffer' })

      if (!['inactive', 'failed'].includes(activeState.toString('utf8').trim())) {
        throw new Error('Runner service remained active after stop.')
      }
    }
  }
}
