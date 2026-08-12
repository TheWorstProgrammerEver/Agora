import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeLocalRealtimeSigningEnvironment } from '../../../scripts/realtime-local-signing.mjs'

const status = (secret) => `status prefix\n${JSON.stringify({ JWT_SECRET: secret })}\n`

describe('local Realtime signing environment', () => {
  it('creates and refreshes only its private managed file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agora-realtime-env-'))
    const environmentPath = join(directory, '.env')
    const firstSecret = `first-${randomUUID()}`
    const secondSecret = `second-${randomUUID()}`

    try {
      expect(writeLocalRealtimeSigningEnvironment(status(firstSecret), environmentPath)).toBe(true)
      expect(statSync(environmentPath).mode & 0o777).toBe(0o600)
      expect(readFileSync(environmentPath, 'utf8')).toContain(JSON.stringify(firstSecret))
      expect(writeLocalRealtimeSigningEnvironment(status(firstSecret), environmentPath)).toBe(false)
      expect(writeLocalRealtimeSigningEnvironment(status(secondSecret), environmentPath)).toBe(true)
      expect(readFileSync(environmentPath, 'utf8')).toContain(JSON.stringify(secondSecret))
      expect(readFileSync(environmentPath, 'utf8')).not.toContain(firstSecret)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('preserves user-managed environment files and rejects invalid status', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agora-realtime-env-'))
    const environmentPath = join(directory, '.env')
    const original = 'UNRELATED_SETTING=preserve-me\n'

    try {
      writeFileSync(environmentPath, original)
      chmodSync(environmentPath, 0o600)
      expect(() => writeLocalRealtimeSigningEnvironment(status('test-secret'), environmentPath))
        .toThrow('supabase/functions/.env is user-managed and its '
          + 'AGORA_REALTIME_LOCAL_SIGNING_SECRET is missing or stale')
      expect(readFileSync(environmentPath, 'utf8')).toBe(original)
      writeFileSync(
        environmentPath,
        '# Managed by npm run get-going for local Agora Realtime only.\n'
          + 'AGORA_REALTIME_LOCAL_SIGNING_SECRET="preserve-me"\n'
          + 'UNRELATED_SETTING=preserve-me\n'
      )
      expect(() => writeLocalRealtimeSigningEnvironment(status('test-secret'), environmentPath))
        .toThrow('supabase/functions/.env is user-managed and its '
          + 'AGORA_REALTIME_LOCAL_SIGNING_SECRET is missing or stale')
      expect(readFileSync(environmentPath, 'utf8')).toContain('UNRELATED_SETTING=preserve-me')
      writeFileSync(
        environmentPath,
        'UNRELATED_SETTING=preserve-me\n'
          + 'AGORA_REALTIME_LOCAL_SIGNING_SECRET="test-secret"\n'
      )
      chmodSync(environmentPath, 0o644)
      expect(writeLocalRealtimeSigningEnvironment(status('test-secret'), environmentPath))
        .toBe(false)
      expect(statSync(environmentPath).mode & 0o777).toBe(0o600)
      expect(readFileSync(environmentPath, 'utf8')).toContain('UNRELATED_SETTING=preserve-me')
      expect(() => writeLocalRealtimeSigningEnvironment('{}', join(directory, '.missing')))
        .toThrow('Local Supabase status did not provide Realtime signing configuration.')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
