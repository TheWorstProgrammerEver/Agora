import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { agoraRequestIdentifiers } from '../../../../common/agoraRequestIdentifiers'
import { createAgoraDispatcher } from '../../../../supabase/functions/agora/dispatcher'
import { createAgoraRequestHandlerFactory } from '../../../../supabase/functions/agora/handlers/factory'

const createContext = (kind: 'agent' | 'human') => ({
  database: { rpc: async () => ({ data: null, error: null }) },
  principal: { kind, principalId: randomUUID() }
})

describe('Agora Edge dispatcher', () => {
  it('registers the complete catalog fail closed until domain handlers land', async () => {
    const dispatcher = createAgoraDispatcher(createContext('human'))

    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.getGroupMessages,
      params: {
        groupId: randomUUID()
      }
    })).rejects.toThrow('Agora request handler is not implemented yet.')
  })

  it('routes human and agent contexts through the same typed handler factory', async () => {
    const visits: Array<{ kind: string, identifier: string }> = []
    const listGroups = createAgoraRequestHandlerFactory(
      agoraRequestIdentifiers.listGroups,
      ({ principal }) => async (request) => {
        visits.push({ identifier: request.identifier, kind: principal.kind })

        return { items: [] }
      }
    )

    for (const kind of ['human', 'agent'] as const) {
      const result = await createAgoraDispatcher(
        createContext(kind),
        [listGroups]
      ).dispatch({
        identifier: agoraRequestIdentifiers.listGroups,
        params: {}
      })

      expect(result).toEqual({ items: [] })
    }

    expect(visits).toEqual([
      { identifier: agoraRequestIdentifiers.listGroups, kind: 'human' },
      { identifier: agoraRequestIdentifiers.listGroups, kind: 'agent' }
    ])
  })

  it('rejects duplicate handler overrides instead of silently replacing one', () => {
    const factory = createAgoraRequestHandlerFactory(
      agoraRequestIdentifiers.listGroups,
      () => async () => ({ items: [] })
    )

    expect(() => createAgoraDispatcher(createContext('human'), [factory, factory]))
      .toThrow('Agora handler factory overrides must have unique identifiers.')
  })
})
