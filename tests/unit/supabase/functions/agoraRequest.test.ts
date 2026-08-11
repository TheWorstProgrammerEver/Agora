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

const groupId = '10000000-0000-4000-8000-000000000001'

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
    ['a primitive body', null],
    ['invalid parameter types', {
      identifier: agoraRequestIdentifiers.listGroups,
      params: { limit: '20' },
      version: agoraContractVersion
    }],
    ['an extra envelope principal selector', {
      identifier: agoraRequestIdentifiers.listGroups,
      params: {},
      principalId: groupId,
      version: agoraContractVersion
    }],
    ['an extra parameter principal selector', {
      identifier: agoraRequestIdentifiers.listGroups,
      params: { principalId: groupId },
      version: agoraContractVersion
    }]
  ])('rejects %s', async (_label, body) => {
    await expect(parseAgoraRequest(jsonRequest(body))).rejects.toBeInstanceOf(AgoraRequestParseError)
  })

  it('requires JSON content and bounds the serialized request', async () => {
    const wrongContent = new Request('http://localhost/functions/v1/agora', {
      body: '{}',
      method: 'POST'
    })
    const oversized = jsonRequest({
      identifier: agoraRequestIdentifiers.createGroup,
      params: { name: 'x'.repeat(70_000) },
      version: agoraContractVersion
    })

    await expect(parseAgoraRequest(wrongContent)).rejects.toMatchObject({
      message: 'Agora request content type must be application/json.'
    })
    await expect(parseAgoraRequest(oversized)).rejects.toMatchObject({
      message: 'Agora request body is too large.'
    })
  })
})
