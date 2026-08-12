import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  skillArtifactBase64,
  skillArtifactEtag,
  skillArtifactFilename,
  skillArtifactVersion
} from '../../../../supabase/functions/skill/artifact.generated'
import { createSkillHandler } from '../../../../supabase/functions/skill/handler'

const bytes = Buffer.from(skillArtifactBase64, 'base64')
const artifact = {
  bytes,
  etag: skillArtifactEtag,
  filename: skillArtifactFilename,
  version: skillArtifactVersion
}
const skillRequest = (path = '/skill/codex', init?: RequestInit) => new Request(
  `http://localhost${path}`,
  init
)

describe('Codex skill handler', () => {
  it('returns the deterministic versioned public artifact', async () => {
    const response = await createSkillHandler(artifact)(skillRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="${skillArtifactFilename}"`
    )
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-version')).toBe('1')
    expect(response.headers.get('etag')).toBe(skillArtifactEtag)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  })

  it('honors exact and wildcard conditional requests', async () => {
    for (const ifNoneMatch of [
      skillArtifactEtag,
      `W/${skillArtifactEtag}`,
      `"another", ${skillArtifactEtag}`,
      '*'
    ]) {
      const response = await createSkillHandler(artifact)(skillRequest('/skill/codex', {
        headers: { 'if-none-match': ifNoneMatch }
      }))

      expect(response.status).toBe(304)
      expect(response.headers.get('etag')).toBe(skillArtifactEtag)
      expect((await response.arrayBuffer()).byteLength).toBe(0)
    }
  })

  it.each([
    ['a non-GET method', skillRequest('/skill/codex', { method: 'POST' }), 405],
    ['the function root', skillRequest('/skill'), 400],
    ['a suffix path', skillRequest('/skill/codex/unexpected'), 400],
    ['query parameters', skillRequest('/skill/codex?version=1'), 400],
    ['a declared body', skillRequest('/skill/codex', {
      headers: { 'content-length': '1' }
    }), 400]
  ])('rejects %s without returning artifact bytes', async (_label, request, status) => {
    const response = await createSkillHandler(artifact)(request)

    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toHaveProperty('error')
  })
})
