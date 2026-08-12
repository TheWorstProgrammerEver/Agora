import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { agoraRequestIdentifiers } from '../../../../common/agoraRequestIdentifiers'
import { createAgoraDispatcher } from '../../../../supabase/functions/agora/dispatcher'

const createdAt = '2026-08-12T01:00:00.123456+00:00'

const messageRow = (
  principalId: string,
  groupId: string,
  overrides: Record<string, unknown> = {}
) => ({
  message_created_at: createdAt,
  message_group_id: groupId,
  message_id: randomUUID(),
  message_sequence: '1',
  message_text: 'Hello from Agora',
  sender_display_name: 'Agora sender',
  sender_kind: 'human',
  sender_principal_id: principalId,
  ...overrides
})

const createContext = (
  kind: 'agent' | 'human',
  principalId: string,
  responses: Array<{ data: unknown, error: unknown }>
) => {
  const rpc = vi.fn(async (
    _name: string,
    _params?: Record<string, unknown>
  ) => responses.shift() ?? { data: [], error: null })

  return {
    context: {
      database: { rpc },
      principal: { kind, principalId }
    },
    rpc
  }
}

describe('Agora message handlers', () => {
  it('routes human and agent sends through the same RPC without a caller-selected sender', async () => {
    for (const kind of ['human', 'agent'] as const) {
      const principalId = randomUUID()
      const groupId = randomUUID()
      const row = messageRow(principalId, groupId, { sender_kind: kind })
      const { context, rpc } = createContext(kind, principalId, [{ data: [row], error: null }])

      await expect(createAgoraDispatcher(context).dispatch({
        identifier: agoraRequestIdentifiers.sendMessage,
        params: {
          clientMessageId: 'client-attempt-1',
          groupId,
          text: 'Hello from Agora'
        }
      })).resolves.toEqual({
        createdAt,
        groupId,
        id: row.message_id,
        sender: {
          displayName: 'Agora sender',
          id: principalId,
          kind
        },
        sequence: '1',
        text: 'Hello from Agora'
      })
      expect(rpc).toHaveBeenCalledWith('send_agora_message', {
        client_message_id_to_use: 'client-attempt-1',
        group_id_to_use: groupId,
        message_text_to_use: 'Hello from Agora'
      })
      expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('sender_principal_id')
    }
  })

  it('rejects database responses that change the authenticated sender or target group', async () => {
    const principalId = randomUUID()
    const groupId = randomUUID()
    const wrongSender = createContext('human', principalId, [{
      data: [messageRow(randomUUID(), groupId)],
      error: null
    }])
    const wrongGroup = createContext('human', principalId, [{
      data: [messageRow(principalId, randomUUID())],
      error: null
    }])
    const params = { clientMessageId: 'attempt', groupId, text: 'Hello from Agora' }

    await expect(createAgoraDispatcher(wrongSender.context).dispatch({
      identifier: agoraRequestIdentifiers.sendMessage,
      params
    })).rejects.toThrow('Agora message database response is invalid.')
    await expect(createAgoraDispatcher(wrongGroup.context).dispatch({
      identifier: agoraRequestIdentifiers.sendMessage,
      params
    })).rejects.toThrow('Agora message database response is invalid.')
  })

  it('requires a serialized sequence and exactly one database row', async () => {
    const principalId = randomUUID()
    const groupId = randomUUID()
    const malformed = createContext('human', principalId, [{
      data: [messageRow(principalId, groupId, { message_sequence: 1 })],
      error: null
    }])
    const empty = createContext('human', principalId, [{ data: [], error: null }])
    const params = { clientMessageId: 'attempt', groupId, text: 'Hello from Agora' }

    await expect(createAgoraDispatcher(malformed.context).dispatch({
      identifier: agoraRequestIdentifiers.sendMessage,
      params
    })).rejects.toThrow('Agora group database response is invalid.')
    await expect(createAgoraDispatcher(empty.context).dispatch({
      identifier: agoraRequestIdentifiers.sendMessage,
      params
    })).rejects.toThrow('Agora message database response is invalid.')
  })

  it('maps authorization, idempotency conflicts, and validation errors without database details', async () => {
    const principalId = randomUUID()
    const groupId = randomUUID()
    const { context } = createContext('human', principalId, [
      { data: null, error: { code: '42501', message: 'private detail' } },
      { data: null, error: { code: '23505', message: 'private detail' } },
      { data: null, error: { code: '22023', message: 'private detail' } }
    ])
    const dispatcher = createAgoraDispatcher(context)
    const request = {
      identifier: agoraRequestIdentifiers.sendMessage,
      params: { clientMessageId: 'attempt', groupId, text: 'Hello' }
    } as const

    await expect(dispatcher.dispatch(request)).rejects.toMatchObject({ status: 403 })
    await expect(dispatcher.dispatch(request)).rejects.toMatchObject({ status: 409 })
    await expect(dispatcher.dispatch(request)).rejects.toMatchObject({ status: 400 })
  })
})
