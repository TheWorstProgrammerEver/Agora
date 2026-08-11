import { describe, expect, it } from 'vitest'
import {
  agoraContractVersion,
  agoraRequestIdentifiers
} from '../../../../common/agoraRequestIdentifiers'
import {
  AgoraRequestParseError,
  parseAgoraRequest
} from '../../../../supabase/functions/agora/request'

const jsonRequest = (body: unknown) => new Request('http://localhost/functions/v1/agora', {
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  method: 'POST'
})

describe('Agora request parsing', () => {
  it('accepts the shared version and identifier catalog', async () => {
    await expect(parseAgoraRequest(jsonRequest({
      identifier: agoraRequestIdentifiers.listGroups,
      params: { limit: 20 },
      version: agoraContractVersion
    }))).resolves.toEqual({
      identifier: agoraRequestIdentifiers.listGroups,
      params: { limit: 20 }
    })
  })

  it.each([
    ['an unversioned envelope', { identifier: agoraRequestIdentifiers.listGroups, params: {} }],
    ['an unknown identifier', { identifier: 'unknown', params: {}, version: agoraContractVersion }],
    ['a primitive body', null]
  ])('rejects %s', async (_label, body) => {
    await expect(parseAgoraRequest(jsonRequest(body))).rejects.toBeInstanceOf(AgoraRequestParseError)
  })
})
