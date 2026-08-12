#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { createOperatorClient } from './operator-client.mjs'
import { validateFingerprint } from './key-format.mjs'
import { fail, writeProvisioningFailure } from '../agent-provisioning/failure.mjs'
import { parseReadinessReceipt } from '../agent-provisioning/readiness-receipt.mjs'

const usage = `Usage:
  operator-cli.mjs prepare DISPLAY_NAME
  operator-cli.mjs preflight AGENT_PRINCIPAL_ID --host-readiness RECEIPT
  operator-cli.mjs issue AGENT_PRINCIPAL_ID --readiness-capability CAPABILITY_ID
  operator-cli.mjs rotate-begin AGENT_PRINCIPAL_ID --readiness-capability CAPABILITY_ID
  operator-cli.mjs rotate-complete APPLICATION_KEY_ID FINGERPRINT
  operator-cli.mjs rotate-rollback APPLICATION_KEY_ID
  operator-cli.mjs revoke APPLICATION_KEY_ID REASON
  operator-cli.mjs deactivate AGENT_PRINCIPAL_ID REASON`

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

const validateUuid = (value) => {
  if (!uuidPattern.test(value)) {
    throw new Error('Operator identifier is malformed.')
  }

  return value.toLowerCase()
}

const requireIssuanceTerminal = (terminal) => {
  if (!terminal.isTTY) {
    fail(
      'key_issuance',
      'operator_tty_required',
      'npm run agent-keys:operator -- --help'
    )
  }
}

const writeIssuance = (terminal, issuance) => {
  terminal.write(`Agent principal: ${issuance.agent_principal_id}\n`)
  terminal.write(`Application key ID: ${issuance.application_key_id}\n`)
  terminal.write(`Fingerprint: ${issuance.key_fingerprint}\n`)
  terminal.write('Raw key (shown once; transfer directly to the no-echo host prompt):\n')
  terminal.write(`${issuance.application_key}\n`)
}

const requireSingleRow = (rows, operation) => {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`${operation} did not return one row.`)
  }

  return rows[0]
}

const parseHostReadiness = (args) => {
  if (args.length !== 2 || args[0] !== '--host-readiness') throw new Error(usage)
  return parseReadinessReceipt(args[1])
}

const parseReadinessCapability = (args) => {
  if (args.length !== 2 || args[0] !== '--readiness-capability') throw new Error(usage)
  return validateUuid(args[1])
}

const requireReadinessRow = (rows, principalId) => {
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail(
      'server_readiness',
      'principal_unavailable',
      `npm run agent-keys:operator -- preflight ${principalId} --host-readiness HOST_READINESS_RECEIPT`
    )
  }

  return rows[0]
}

const requireServerReadiness = (row, principalId, operation) => {
  if (row.agent_principal_id !== principalId) {
    fail(
      'server_readiness',
      'principal_unavailable',
      `npm run agent-keys:operator -- preflight ${principalId} --host-readiness HOST_READINESS_RECEIPT`
    )
  }

  if (!row.is_active) {
    fail('server_readiness', 'principal_inactive', 'npm run agent-keys:operator -- prepare NEW_DISPLAY_NAME')
  }

  if (Number(row.authorized_group_count) < 1) {
    fail(
      'server_readiness',
      'authorized_group_required',
      `npm run agent-keys:operator -- preflight ${principalId} --host-readiness HOST_READINESS_RECEIPT`
    )
  }

  const ready = operation === 'install'
    ? Number(row.live_key_count) === 0 && row.ready_for_initial_key
    : Number(row.active_key_count) === 1
      && Number(row.pending_rotation_count) === 0
      && row.ready_for_rotation

  if (!ready) {
    fail(
      'server_readiness',
      operation === 'install' ? 'initial_key_state_conflict' : 'rotation_state_conflict',
      `npm run agent-keys:operator -- preflight ${principalId} --host-readiness HOST_READINESS_RECEIPT`
    )
  }

  return row
}

export const runOperatorCommand = async (args, {
  client,
  terminal = process.stdout
} = {}) => {
  const [command, first, ...rest] = args
  const operatorClient = () => client ?? createOperatorClient()

  if ((command === '--help' || command === '-h') && !first) {
    terminal.write(`${usage}\n`)
    return
  }

  if (command === 'prepare' && first && rest.length === 0) {
    const prepared = requireSingleRow(
      await operatorClient().prepareAgent(first),
      'Agent preparation'
    )
    terminal.write(`${JSON.stringify({
      agentPrincipalId: prepared.agent_principal_id,
      displayName: prepared.display_name,
      stage: 'principal_prepared'
    })}\n`)
    return
  }

  if (command === 'preflight' && first) {
    const payload = parseHostReadiness(rest)
    const principalId = validateUuid(first)
    if (payload.agentPrincipalId !== principalId) {
      fail(
        'host_readiness',
        'readiness_principal_mismatch',
        `npm run agent-provision:host -- preflight --principal ${principalId} --digest ${payload.artifactDigest} --operation ${payload.operation} --service ${payload.service}`
      )
    }
    const readiness = requireServerReadiness(
      requireReadinessRow(
        await operatorClient().getProvisioningReadiness(principalId),
        principalId
      ),
      principalId,
      payload.operation
    )
    let capability
    try {
      capability = requireSingleRow(
        await operatorClient().recordProvisioningReadiness({
          agentPrincipalId: principalId,
          artifactDigest: payload.artifactDigest,
          checkedAt: new Date(payload.checkedAt).toISOString(),
          operation: payload.operation,
          service: payload.service
        }),
        'Agent host readiness registration'
      )
    } catch {
      fail(
        'server_readiness',
        'readiness_registration_failed',
        `npm run agent-keys:operator -- preflight ${principalId} --host-readiness HOST_READINESS_RECEIPT`
      )
    }
    terminal.write(`${JSON.stringify({
      agentPrincipalId: principalId,
      artifactDigest: payload.artifactDigest,
      authorizedGroupCount: Number(readiness.authorized_group_count),
      readinessCapabilityId: capability.readiness_capability_id,
      readinessExpiresAt: capability.expires_at,
      stage: 'ready_for_key_issuance'
    })}\n`)
    return
  }

  if (command === 'issue' && first) {
    const principalId = validateUuid(first)
    const capabilityId = parseReadinessCapability(rest)
    requireIssuanceTerminal(terminal)
    try {
      writeIssuance(terminal, await operatorClient().issueInitialKey(principalId, capabilityId))
    } catch {
      fail(
        'key_issuance',
        'readiness_capability_rejected',
        `npm run agent-keys:operator -- preflight ${principalId} --host-readiness HOST_READINESS_RECEIPT`
      )
    }
    return
  }

  if (command === 'rotate-begin' && first) {
    const principalId = validateUuid(first)
    const capabilityId = parseReadinessCapability(rest)
    requireIssuanceTerminal(terminal)
    try {
      writeIssuance(terminal, await operatorClient().beginRotation(principalId, capabilityId))
    } catch {
      fail(
        'key_issuance',
        'readiness_capability_rejected',
        `npm run agent-keys:operator -- preflight ${principalId} --host-readiness HOST_READINESS_RECEIPT`
      )
    }
    return
  }

  if (command === 'rotate-complete' && first && rest.length === 1) {
    await operatorClient().completeRotation(validateUuid(first), validateFingerprint(rest[0]))
    terminal.write('Agent key rotation completed; the prior server-side key is revoked.\n')
    return
  }

  if (command === 'rotate-rollback' && first && rest.length === 0) {
    await operatorClient().rollbackRotation(validateUuid(first))
    terminal.write('Pending agent key rotation rolled back server-side.\n')
    return
  }

  if (command === 'revoke' && first && rest.length === 1) {
    await operatorClient().revokeKey(validateUuid(first), rest[0])
    terminal.write('Agent application key revoked server-side.\n')
    return
  }

  if (command === 'deactivate' && first && rest.length === 1) {
    await operatorClient().deactivateAgent(validateUuid(first), rest[0])
    terminal.write('Agent principal and every live application key deactivated server-side.\n')
    return
  }

  throw new Error(usage)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOperatorCommand(process.argv.slice(2)).catch((error) => {
    writeProvisioningFailure(error, {
      code: 'operator_command_failed',
      recovery: 'npm run agent-keys:operator -- --help',
      stage: 'operator'
    })
    process.exitCode = 1
  })
}
