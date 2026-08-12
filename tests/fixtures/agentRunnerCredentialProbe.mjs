import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { readAgentCredential } from '../../scripts/agent-runner/credential.mjs'

try {
  const credential = await readAgentCredential(process.env.CREDENTIALS_DIRECTORY)
  const fingerprint = createHash('sha256').update(credential).digest('hex').slice(0, 16)
  process.stdout.write(`${JSON.stringify({ fingerprint: `sha256:${fingerprint}`, ok: true })}\n`)
} catch (error) {
  const directory = await lstat(process.env.CREDENTIALS_DIRECTORY)
  const credential = await lstat(join(process.env.CREDENTIALS_DIRECTORY, 'agora-agent-key'))
  process.stdout.write(`${JSON.stringify({
    directory: {
      mode: (directory.mode & 0o7777).toString(8),
      gid: directory.gid,
      symbolicLink: directory.isSymbolicLink(),
      type: directory.isDirectory() ? 'directory' : 'other',
      uid: directory.uid
    },
    error: error.message,
    file: {
      links: credential.nlink,
      mode: (credential.mode & 0o7777).toString(8),
      gid: credential.gid,
      symbolicLink: credential.isSymbolicLink(),
      type: credential.isFile() ? 'file' : 'other',
      uid: credential.uid
    },
    ok: false,
    processGid: process.getgid?.(),
    processUid: process.getuid?.()
  })}\n`)
}
