import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  fingerprintApplicationKey,
  validateApplicationKey
} from '../../scripts/agent-keys/key-format.mjs'

const credentialName = 'agora-agent-key'
const credentialDirectory = process.env.CREDENTIALS_DIRECTORY

if (!credentialDirectory || !path.isAbsolute(credentialDirectory)) {
  throw new Error('Systemd did not provide a credential directory.')
}

const applicationKey = await readFile(path.join(credentialDirectory, credentialName))

try {
  const keyText = validateApplicationKey(applicationKey.toString('utf8'))
  process.stdout.write(`${fingerprintApplicationKey(keyText)}\n`)
} finally {
  applicationKey.fill(0)
}
