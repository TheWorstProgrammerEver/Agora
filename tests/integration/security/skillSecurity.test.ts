import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  skillArtifactBase64,
  skillArtifactEtag,
  skillArtifactFilename,
  skillArtifactVersion
} from '../../../supabase/functions/skill/artifact.generated'

const skillUrl = 'http://127.0.0.1:54321/functions/v1/skill/codex'

const getSkill = (path = skillUrl, init?: RequestInit) => fetch(path, {
  redirect: 'manual',
  signal: AbortSignal.timeout(3000),
  ...init
})

describe('anonymous Codex skill endpoint', () => {
  it('serves the exact artifact without credentials', async () => {
    const response = await getSkill()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/zip')
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="${skillArtifactFilename}"`
    )
    expect(response.headers.get('content-version')).toBe(skillArtifactVersion)
    expect(response.headers.get('etag')).toBe(skillArtifactEtag)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(skillArtifactBase64, 'base64')
    )
  })

  it('does not vary the public artifact on chat-shaped credentials', async () => {
    const response = await getSkill(skillUrl, {
      headers: {
        authorization: 'Bearer deliberately-invalid',
        'x-agora-agent-key': 'agora_agent_deliberately_invalid'
      }
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe(skillArtifactEtag)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(skillArtifactBase64, 'base64')
    )
  })

  it('returns no bytes for a matching ETag', async () => {
    const response = await getSkill(skillUrl, {
      headers: { 'if-none-match': skillArtifactEtag }
    })

    expect(response.status).toBe(304)
    expect(response.headers.get('etag')).toBe(skillArtifactEtag)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })

  it.each([
    [`${skillUrl}/unexpected`, undefined, 400],
    [`${skillUrl}?inspect=groups`, undefined, 400],
    [skillUrl, { method: 'POST' }, 405]
  ])('rejects malformed public requests', async (url, init, status) => {
    const response = await getSkill(url, init)

    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toHaveProperty('error')
  })
})
