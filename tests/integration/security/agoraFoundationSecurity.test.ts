import { describe, expect, it } from 'vitest'
import {
  agoraContractVersion,
  agoraRequestIdentifiers
} from '../../../common/agoraRequestIdentifiers'

const agoraFunctionUrl = 'http://127.0.0.1:54321/functions/v1/agora'

const postAgora = (body: unknown) => fetch(agoraFunctionUrl, {
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  method: 'POST'
})

describe('Agora foundation function', () => {
  it('fails closed for catalog requests while there are no product handlers', async () => {
    const response = await postAgora({
      identifier: agoraRequestIdentifiers.listGroups,
      params: {},
      version: agoraContractVersion
    })

    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toEqual({
      error: 'Agora request handlers are not implemented yet.'
    })
  })

  it('rejects unversioned and unknown requests', async () => {
    const [unversionedResponse, unknownResponse] = await Promise.all([
      postAgora({ identifier: agoraRequestIdentifiers.listGroups, params: {} }),
      postAgora({ identifier: 'unknown', params: {}, version: agoraContractVersion })
    ])

    expect(unversionedResponse.status).toBe(400)
    expect(unknownResponse.status).toBe(400)
  })
})
