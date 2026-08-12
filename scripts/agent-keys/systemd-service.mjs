import { runCommand } from './command.mjs'
import { credentialName, credentialPath } from './systemd-credential-store.mjs'
import { ProvisioningFailure } from '../agent-provisioning/failure.mjs'

const systemctlPath = '/usr/bin/systemctl'
const busctlPath = '/usr/bin/busctl'
const servicePattern = /^agora-agent-runner@[a-z_][a-z0-9_-]{0,30}\.service$/
const unitObjectPathPattern = /^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/

export const validateServiceName = (service) => {
  if (!servicePattern.test(service)) {
    throw new ProvisioningFailure({
      code: 'runner_unit_invalid',
      recovery: '/usr/local/sbin/agora-agent-custody --help',
      stage: 'unit_binding'
    })
  }

  return service
}

export const isRunnerServiceName = (service) => servicePattern.test(service)

const recoveryCommands = (service) => ({
  binding: `sudo systemctl show --property=FragmentPath,LoadState,LoadCredentialEncrypted ${service}`,
  cleanup: `sudo systemctl disable --now ${service}; sudo systemctl reset-failed ${service}; sudo systemctl show --property=ActiveState,UnitFileState ${service}`,
  disable: `sudo systemctl disable --now ${service}`,
  enable: `sudo systemctl enable ${service}`,
  health: `sudo systemctl status ${service} --no-pager`,
  reload: 'sudo systemctl daemon-reload',
  reset: `sudo systemctl reset-failed ${service}`,
  restart: `sudo systemctl restart ${service}`
})

const runStage = async (details, operation) => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ProvisioningFailure) throw error
    throw new ProvisioningFailure(details)
  }
}

const parseJsonOutput = (output, expectedType) => {
  let parsed

  try {
    parsed = JSON.parse(output.toString('utf8'))
  } catch {
    throw new Error('malformed systemd metadata')
  }

  if (parsed?.type !== expectedType || !Array.isArray(parsed.data)) {
    throw new Error('unexpected systemd metadata')
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
  const recovery = recoveryCommands(validatedService)

  const validateBinding = async () => {
    await runStage({ code: 'daemon_reload_failed', recovery: recovery.reload, stage: 'unit_binding' }, () => (
      run(systemctlPath, ['daemon-reload'])
    ))
    await runStage({ code: 'credential_binding_invalid', recovery: recovery.binding, stage: 'unit_binding' }, async () => {
      const unitOutput = await run(busctlPath, [
        '--json=short',
        'call',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager',
        'LoadUnit',
        's',
        validatedService
      ], { output: 'buffer' })
      const [unitObjectPath] = parseJsonOutput(unitOutput, 'o')

      if (!unitObjectPathPattern.test(unitObjectPath)) throw new Error('invalid unit path')

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
        throw new Error('credential binding mismatch')
      }
    })
  }

  const readServiceState = () => run(systemctlPath, [
    'show',
    '--property=ActiveState,UnitFileState',
    validatedService
  ], { output: 'buffer' }).then((output) => Object.fromEntries(
    output.toString('utf8').trim().split('\n').map((line) => {
      const separator = line.indexOf('=')
      if (separator < 1) throw new Error('invalid systemd state')
      return [line.slice(0, separator), line.slice(separator + 1)]
    })
  ))

  const reconcileFailedStart = async ({ activationFailure, disable }) => {
    const commands = disable
      ? [
          { args: ['disable', validatedService], code: 'service_disable_failed' },
          { args: ['stop', validatedService], code: 'service_stop_failed' },
          { args: ['reset-failed', validatedService], code: 'start_limit_reset_failed' }
        ]
      : [
          { args: ['stop', validatedService], code: 'service_stop_failed' },
          { args: ['reset-failed', validatedService], code: 'start_limit_reset_failed' }
        ]
    const failedCommands = []
    for (const command of commands) {
      try {
        await run(systemctlPath, command.args)
      } catch {
        failedCommands.push(command.code)
      }
    }

    let state
    try {
      state = await readServiceState()
    } catch {
      failedCommands.push('cleanup_state_unavailable')
    }
    const expectedUnitFileState = disable ? 'disabled' : 'enabled'
    if (state?.ActiveState !== 'inactive' || state?.UnitFileState !== expectedUnitFileState) {
      failedCommands.push('cleanup_state_invalid')
    }

    if (failedCommands.length > 0) {
      throw new ProvisioningFailure({
        causeCode: activationFailure.code,
        causeStage: activationFailure.stage,
        code: failedCommands[0],
        recovery: recovery.cleanup,
        stage: 'activation_reconciliation'
      })
    }

    throw new ProvisioningFailure({
      code: activationFailure.code,
      reconciliationCode: 'cleanup_verified',
      recovery: activationFailure.recovery,
      stage: activationFailure.stage
    })
  }

  const resetStartLimitIfFailed = () => runStage({
    code: 'start_limit_state_unavailable',
    recovery: recovery.reset,
    stage: 'activation_readiness'
  }, async () => {
    const output = await run(systemctlPath, [
      'show',
      '--property=ActiveState',
      '--value',
      validatedService
    ], { output: 'buffer' })
    const state = output.toString('utf8').trim()
    if (state === 'failed') await run(systemctlPath, ['reset-failed', validatedService])
    else if (!['active', 'inactive'].includes(state)) throw new Error('invalid active state')
  })

  const startAndValidate = async ({ enable }) => {
    await validateBinding()
    await resetStartLimitIfFailed()

    try {
      if (enable) {
        await runStage({ code: 'service_enable_failed', recovery: recovery.enable, stage: 'service_enablement' }, () => (
          run(systemctlPath, ['enable', validatedService])
        ))
      }
      await runStage({ code: 'service_restart_failed', recovery: recovery.restart, stage: 'service_start' }, () => (
        run(systemctlPath, ['restart', validatedService])
      ))
      await runStage({ code: 'service_inactive', recovery: recovery.health, stage: 'service_health' }, () => (
        run(systemctlPath, ['is-active', '--quiet', validatedService])
      ))
    } catch (error) {
      await reconcileFailedStart({ activationFailure: error, disable: enable })
    }
  }

  return {
    activateAndValidate: async () => startAndValidate({ enable: true }),
    restartAndValidate: async () => startAndValidate({ enable: false }),
    stop: async () => {
      await validateBinding()
      await runStage({ code: 'service_disable_failed', recovery: recovery.disable, stage: 'service_stop' }, () => (
        run(systemctlPath, ['disable', '--now', validatedService])
      ))
      await runStage({ code: 'start_limit_reset_failed', recovery: recovery.reset, stage: 'service_stop' }, () => (
        run(systemctlPath, ['reset-failed', validatedService])
      ))
      await runStage({ code: 'service_stop_unverified', recovery: recovery.health, stage: 'service_stop' }, async () => {
        const state = await readServiceState()
        if (state.ActiveState !== 'inactive' || state.UnitFileState !== 'disabled') {
          throw new Error('unsafe service state')
        }
      })
    }
  }
}
