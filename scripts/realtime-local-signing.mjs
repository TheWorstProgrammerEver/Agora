import {
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'

const managedHeader = '# Managed by npm run get-going for local Agora Realtime only.'

const parseStatus = (output) => {
  const jsonStart = output.indexOf('{')

  if (jsonStart === -1) {
    throw new Error('Local Supabase status did not provide Realtime signing configuration.')
  }

  const status = JSON.parse(output.slice(jsonStart))

  if (typeof status.JWT_SECRET !== 'string' || status.JWT_SECRET === '') {
    throw new Error('Local Supabase status did not provide Realtime signing configuration.')
  }

  return status.JWT_SECRET
}

const serializedEnvironment = (secret) => [
  managedHeader,
  `AGORA_REALTIME_LOCAL_SIGNING_SECRET=${JSON.stringify(secret)}`,
  ''
].join('\n')

const isManagedEnvironment = (value) => {
  const lines = value.split('\n')

  return lines.length === 3
    && lines[0] === managedHeader
    && lines[1].startsWith('AGORA_REALTIME_LOCAL_SIGNING_SECRET=')
    && lines[2] === ''
}

export const writeLocalRealtimeSigningEnvironment = (
  statusOutput,
  environmentPath = 'supabase/functions/.env'
) => {
  const candidate = serializedEnvironment(parseStatus(statusOutput))
  const existed = existsSync(environmentPath)

  if (existed) {
    const current = readFileSync(environmentPath, 'utf8')

    if (!isManagedEnvironment(current)) {
      const expectedSigningLine = candidate.split('\n')[1]

      if (current.split('\n').includes(expectedSigningLine)) {
        chmodSync(environmentPath, 0o600)
        return false
      }

      throw new Error(
        'supabase/functions/.env is user-managed and its AGORA_REALTIME_LOCAL_SIGNING_SECRET is missing or stale. Add the current value from local Supabase status before starting Agora.'
      )
    }

    if (current === candidate) {
      chmodSync(environmentPath, 0o600)
      return false
    }
  }

  const temporaryPath = `${environmentPath}.${process.pid}.${randomUUID()}.tmp`

  try {
    writeFileSync(temporaryPath, candidate, { flag: 'wx', mode: 0o600 })

    if (existed) {
      renameSync(temporaryPath, environmentPath)
    } else {
      linkSync(temporaryPath, environmentPath)
      unlinkSync(temporaryPath)
    }

    chmodSync(environmentPath, 0o600)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }

  return true
}

export const ensureLocalRealtimeSigningEnvironment = async (run) => {
  const { stdout } = await run(
    'npx',
    ['--no-install', 'supabase', 'status', '-o', 'json'],
    { capture: true }
  )

  return writeLocalRealtimeSigningEnvironment(stdout)
}
