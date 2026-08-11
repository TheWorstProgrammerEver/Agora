import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { agoraRequestIdentifiers } from '../../../../common/agoraRequestIdentifiers'
import { createAgoraDispatcher } from '../../../../supabase/functions/agora/dispatcher'
import { decodeGroupCursor } from '../../../../supabase/functions/agora/handlers/groups/cursor'

const createdAt = '2026-08-12T00:00:00.123456+00:00'

const createContext = (
  kind: 'agent' | 'human',
  responses: Array<{ data: unknown, error: unknown }>
) => {
  const rpc = vi.fn(async (
    _name: string,
    _params?: Record<string, unknown>
  ) => responses.shift() ?? { data: [], error: null })

  return {
    context: {
      database: { rpc },
      principal: { kind, principalId: randomUUID() }
    },
    rpc
  }
}

const groupRow = (id = randomUUID(), hasMore = false) => ({
  created_at: createdAt,
  has_more: hasMore,
  id,
  name: 'Group',
  owner_principal_id: randomUUID(),
  unread_count: 0
})

describe('Agora group handlers', () => {
  it('returns minimal create and delete mutation DTOs', async () => {
    const row = groupRow()
    const { context, rpc } = createContext('human', [
      { data: [row], error: null },
      { data: [{ group_id: row.id }], error: null }
    ])
    const dispatcher = createAgoraDispatcher(context)

    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.createGroup,
      params: { name: 'Group' }
    })).resolves.toEqual({
      group: {
        createdAt,
        id: row.id,
        name: row.name,
        ownerPrincipalId: row.owner_principal_id
      }
    })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.deleteGroup,
      params: { groupId: row.id }
    })).resolves.toEqual({ groupId: row.id })
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'create_agora_group',
      'delete_agora_group'
    ])
  })

  it('maps explicit member state for human and agent group queries', async () => {
    for (const kind of ['human', 'agent'] as const) {
      const principalId = randomUUID()
      const row = groupRow()
      const getRow = {
        group_created_at: row.created_at,
        group_id: row.id,
        group_name: row.name,
        membership_created_at: row.created_at,
        membership_role: kind === 'human' ? 'owner' : 'member',
        owner_principal_id: row.owner_principal_id,
        principal_display_name: `${kind} caller`,
        principal_id: principalId,
        principal_kind: kind
      }
      const { context } = createContext(kind, [
        { data: [row], error: null },
        { data: [getRow], error: null }
      ])
      const dispatcher = createAgoraDispatcher(context)

      await expect(dispatcher.dispatch({
        identifier: agoraRequestIdentifiers.listGroups,
        params: {}
      })).resolves.toEqual({
        items: [expect.objectContaining({ id: row.id, unreadCount: 0 })]
      })
      await expect(dispatcher.dispatch({
        identifier: agoraRequestIdentifiers.getGroup,
        params: { groupId: row.id }
      })).resolves.toEqual({
        currentMember: expect.objectContaining({
          groupId: row.id,
          principal: expect.objectContaining({ id: principalId, kind })
        }),
        group: expect.objectContaining({ id: row.id })
      })
    }
  })

  it('uses a stable final-item cursor and rejects malformed cursors before RPC access', async () => {
    const first = groupRow(randomUUID(), true)
    const second = groupRow(randomUUID(), true)
    const { context, rpc } = createContext('human', [{
      data: [first, second],
      error: null
    }])
    const dispatcher = createAgoraDispatcher(context)
    const page = await dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.listGroups,
      params: { limit: 2 }
    }) as { items: unknown[], nextCursor?: string }

    expect(page.items).toHaveLength(2)
    expect(decodeGroupCursor(page.nextCursor ?? '')).toEqual({
      createdAt,
      id: second.id
    })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.listGroups,
      params: { cursor: 'not-a-valid-cursor' }
    })).rejects.toMatchObject({ status: 400 })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('denies agent lifecycle mutations before database access', async () => {
    const { context, rpc } = createContext('agent', [])
    const dispatcher = createAgoraDispatcher(context)

    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.createGroup,
      params: { name: 'Denied' }
    })).rejects.toMatchObject({ status: 403 })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.deleteGroup,
      params: { groupId: randomUUID() }
    })).rejects.toMatchObject({ status: 403 })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('maps database authorization errors without exposing database details', async () => {
    const { context } = createContext('human', [{
      data: null,
      error: { code: '42501', message: 'private database detail' }
    }])

    await expect(createAgoraDispatcher(context).dispatch({
      identifier: agoraRequestIdentifiers.deleteGroup,
      params: { groupId: randomUUID() }
    })).rejects.toMatchObject({
      message: 'This group operation is not permitted.',
      status: 403
    })
  })
})
