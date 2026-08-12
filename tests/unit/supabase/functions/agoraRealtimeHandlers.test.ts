import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { agoraRequestIdentifiers } from '../../../../common/agoraRequestIdentifiers'
import { formatAgoraRealtimeTopic } from '../../../../common/agoraRealtime'
import { createAgoraDispatcher } from '../../../../supabase/functions/agora/dispatcher'
import { createRealtimeSessionHandlerFactory } from '../../../../supabase/functions/agora/handlers/realtime/createRealtimeSession'

const createContext = (
  kind: 'agent' | 'human',
  principalId: string,
  response: { data: unknown, error: unknown }
) => {
  const rpc = vi.fn(async () => response)

  return {
    context: { database: { rpc }, principal: { kind, principalId } },
    rpc
  }
}

describe('Agora Realtime session handler', () => {
  it('authorizes every requested group before issuing one agent-scoped credential', async () => {
    const principalId = randomUUID()
    const groupIds = [randomUUID(), randomUUID()].sort()
    const { context, rpc } = createContext('agent', principalId, {
      data: groupIds.map((groupId, index) => ({
        high_watermark_sequence: String(index + 4),
        topic_group_id: groupId
      })),
      error: null
    })
    const issueCredential = vi.fn(async () => ({
      accessToken: 'short-lived-test-token',
      expiresAt: '2026-08-12T02:05:00.000Z',
      refreshAfter: '2026-08-12T02:04:00.000Z'
    }))
    const dispatcher = createAgoraDispatcher(context, [
      createRealtimeSessionHandlerFactory(issueCredential)
    ])

    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.createRealtimeSession,
      params: { groupIds }
    })).resolves.toEqual({
      accessToken: 'short-lived-test-token',
      expiresAt: '2026-08-12T02:05:00.000Z',
      refreshAfter: '2026-08-12T02:04:00.000Z',
      topics: groupIds.map((groupId, index) => ({
        groupId,
        highWatermarkSequence: String(index + 4),
        topic: formatAgoraRealtimeTopic(groupId)
      }))
    })
    expect(rpc).toHaveBeenCalledWith('authorize_agora_realtime_topics', {
      group_ids_to_authorize: groupIds
    })
    expect(issueCredential).toHaveBeenCalledWith({ groupIds, principalId })
  })

  it('rejects humans before database access or credential creation', async () => {
    const groupId = randomUUID()
    const { context, rpc } = createContext('human', randomUUID(), { data: [], error: null })
    const issueCredential = vi.fn()
    const dispatcher = createAgoraDispatcher(context, [
      createRealtimeSessionHandlerFactory(issueCredential)
    ])

    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.createRealtimeSession,
      params: { groupIds: [groupId] }
    })).rejects.toMatchObject({ status: 403 })
    expect(rpc).not.toHaveBeenCalled()
    expect(issueCredential).not.toHaveBeenCalled()
  })

  it('rejects partial, duplicate, malformed, and denied authorization results', async () => {
    const principalId = randomUUID()
    const groupIds = [randomUUID(), randomUUID()]
    const responses = [
      { data: [{ high_watermark_sequence: '0', topic_group_id: groupIds[0] }], error: null },
      {
        data: groupIds.map(() => ({ high_watermark_sequence: '0', topic_group_id: groupIds[0] })),
        error: null
      },
      {
        data: groupIds.map((groupId) => ({ high_watermark_sequence: 0, topic_group_id: groupId })),
        error: null
      },
      { data: null, error: { code: '42501', message: 'private detail' } }
    ]

    for (const response of responses) {
      const context = createContext('agent', principalId, response).context
      const dispatcher = createAgoraDispatcher(context, [
        createRealtimeSessionHandlerFactory(vi.fn())
      ])
      const result = dispatcher.dispatch({
        identifier: agoraRequestIdentifiers.createRealtimeSession,
        params: { groupIds }
      })

      if (response.error) {
        await expect(result).rejects.toMatchObject({ status: 403 })
      } else {
        await expect(result).rejects.toThrow('Agora Realtime database response is invalid.')
      }
    }
  })
})
