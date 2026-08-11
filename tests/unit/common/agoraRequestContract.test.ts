import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AgoraCatalogIsComplete,
  AgoraRequestEnvelope,
  AgoraRequestResult
} from '../../../common/agoraRequestContract'
import {
  agoraContractVersion,
  agoraRequestIdentifiers,
  agoraRequestNames,
  isAgoraRequestIdentifier
} from '../../../common/agoraRequestIdentifiers'
import { SendMessageCommand, agoraRequestTypes } from '../../../src/data/agora/requests'

describe('Agora request contract', () => {
  it('keeps the identifier and DTO catalogs complete and unique', () => {
    expectTypeOf<AgoraCatalogIsComplete>().toEqualTypeOf<true>()
    expect(new Set(agoraRequestNames).size).toBe(agoraRequestNames.length)
    expect(agoraRequestTypes.map(({ identifier }) => identifier).sort()).toEqual(
      [...agoraRequestNames].sort()
    )
  })

  it('uses a versioned envelope and preserves request result types', () => {
    const request = new SendMessageCommand({
      clientMessageId: 'message-attempt-1',
      groupId: 'group-1',
      text: 'Hello'
    })
    const envelope: AgoraRequestEnvelope<'sendMessage'> = {
      identifier: request.identifier,
      params: request.params,
      version: agoraContractVersion
    }

    expect(envelope).toEqual({
      identifier: agoraRequestIdentifiers.sendMessage,
      params: request.params,
      version: 1
    })
    expectTypeOf<AgoraRequestResult<'sendMessage'>>().toMatchTypeOf<{
      groupId: string
      sequence: string
    }>()
  })

  it('recognizes only catalog identifiers', () => {
    expect(isAgoraRequestIdentifier('listGroups')).toBe(true)
    expect(isAgoraRequestIdentifier('otherApp.load')).toBe(false)
    expect(isAgoraRequestIdentifier(undefined)).toBe(false)
  })
})
