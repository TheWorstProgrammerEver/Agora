#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { createOperatorClient } from './operator-client.mjs'
import { validateFingerprint } from './key-format.mjs'

const usage = `Usage:
  operator-cli.mjs provision DISPLAY_NAME
  operator-cli.mjs rotate-begin AGENT_PRINCIPAL_ID
  operator-cli.mjs rotate-complete APPLICATION_KEY_ID FINGERPRINT
  operator-cli.mjs rotate-rollback APPLICATION_KEY_ID
  operator-cli.mjs revoke APPLICATION_KEY_ID REASON
  operator-cli.mjs deactivate AGENT_PRINCIPAL_ID REASON`

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

const validateUuid = (value) => {
  if (!uuidPattern.test(value)) {
    throw new Error('Operator identifier is malformed.')
  }

  return value
}

const requireIssuanceTerminal = (terminal) => {
  if (!terminal.isTTY) {
    throw new Error('Raw Agora agent keys are issued only to an interactive operator TTY.')
  }
}

const writeIssuance = (terminal, issuance) => {
  terminal.write(`Agent principal: ${issuance.agent_principal_id}\n`)
  terminal.write(`Application key ID: ${issuance.application_key_id}\n`)
  terminal.write(`Fingerprint: ${issuance.key_fingerprint}\n`)
  terminal.write('Raw key (shown once; transfer directly to the no-echo host prompt):\n')
  terminal.write(`${issuance.application_key}\n`)
}

export const runOperatorCommand = async (args, {
  client,
  terminal = process.stdout
} = {}) => {
  const [command, first, ...rest] = args
  const operatorClient = () => client ?? createOperatorClient()

  if (command === 'provision' && first && rest.length === 0) {
    requireIssuanceTerminal(terminal)
    writeIssuance(terminal, await operatorClient().provisionAgent(first))
    return
  }

  if (command === 'rotate-begin' && first && rest.length === 0) {
    requireIssuanceTerminal(terminal)
    writeIssuance(terminal, await operatorClient().beginRotation(validateUuid(first)))
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
    process.stderr.write(`ERROR: ${error.message}\n`)
    process.exitCode = 1
  })
}
