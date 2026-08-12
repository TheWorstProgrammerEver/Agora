import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { agoraRequestIdentifiers } from '../../../../common/agoraRequestIdentifiers'
import { MissingAuthenticationError } from '../../../../supabase/functions/agora/auth/authenticatePrincipal'
import { createAgoraHandler } from '../../../../supabase/functions/agora/handler'
import { AgoraGroupRequestError } from '../../../../supabase/functions/agora/handlers/groups/error'
import { AgoraMessageRequestError } from '../../../../supabase/functions/agora/handlers/messages/error'
import { AgoraRealtimeRequestError } from '../../../../supabase/functions/agora/handlers/realtime/error'

const context = {
  database: { rpc: async () => ({ data: null, error: null }) },
  principal: { kind: 'human' as const, principalId: randomUUID() }
}

const request = (path = '/agora', method = 'POST') => new Request(`http://localhost${path}`, {
  body: method === 'POST' ? '{}' : undefined,
  method
})

describe('Agora HTTP handler', () => {
  it('authenticates before parsing and dispatches one normalized request', async () => {
    const events: string[] = []
    const authenticate = vi.fn(async () => {
      events.push('authenticate')
      return context
    })
    const parseRequest = vi.fn(async () => {
      events.push('parse')
      return { identifier: agoraRequestIdentifiers.listGroups, params: {} } as const
    })
    const dispatch = vi.fn(async () => {
      events.push('dispatch')
      return { items: [] }
    })
    const handler = createAgoraHandler({
      authenticate,
      createDispatcher: () => ({ dispatch }),
      parseRequest
    })
    const response = await handler(request())

    expect(response.status).toBe(200)
    expect(events).toEqual(['authenticate', 'parse', 'dispatch'])
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ items: [] })
  })

  it('fails bad credentials before parsing or business dispatch', async () => {
    const parseRequest = vi.fn()
    const dispatch = vi.fn()
    const handler = createAgoraHandler({
      authenticate: vi.fn().mockRejectedValue(new MissingAuthenticationError()),
      createDispatcher: () => ({ dispatch }),
      parseRequest
    })
    const response = await handler(request())

    expect(response.status).toBe(401)
    expect(parseRequest).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('keeps suffixes, queries, methods, and preflight outside business dispatch', async () => {
    const authenticate = vi.fn().mockResolvedValue(context)
    const parseRequest = vi.fn()
    const dispatch = vi.fn()
    const handler = createAgoraHandler({
      authenticate,
      createDispatcher: () => ({ dispatch }),
      parseRequest
    })

    expect((await handler(request('/agora/health'))).status).toBe(400)
    expect((await handler(request('/agora?route=skill'))).status).toBe(400)
    expect((await handler(request('/agora', 'GET'))).status).toBe(405)
    const preflight = await handler(request('/agora', 'OPTIONS'))

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-agora-agent-key')
    expect(authenticate).not.toHaveBeenCalled()
    expect(parseRequest).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('projects unexpected failures without leaking their details', async () => {
    const handler = createAgoraHandler({
      authenticate: vi.fn().mockRejectedValue(new Error('private failure detail')),
      createDispatcher: () => ({ dispatch: vi.fn() }),
      parseRequest: vi.fn()
    })
    const response = await handler(request())
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toBe('{"error":"Agora request failed."}')
    expect(body).not.toContain('private failure detail')
  })

  it('projects bounded group authorization failures', async () => {
    const handler = createAgoraHandler({
      authenticate: vi.fn().mockResolvedValue(context),
      createDispatcher: () => ({
        dispatch: vi.fn().mockRejectedValue(
          new AgoraGroupRequestError('This group operation is not permitted.', 403)
        )
      }),
      parseRequest: vi.fn().mockResolvedValue({
        identifier: agoraRequestIdentifiers.deleteGroup,
        params: { groupId: randomUUID() }
      })
    })
    const response = await handler(request())

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'This group operation is not permitted.'
    })
  })

  it('projects bounded message conflicts', async () => {
    const handler = createAgoraHandler({
      authenticate: vi.fn().mockResolvedValue(context),
      createDispatcher: () => ({
        dispatch: vi.fn().mockRejectedValue(
          new AgoraMessageRequestError('This client message identifier is already in use.', 409)
        )
      }),
      parseRequest: vi.fn().mockResolvedValue({
        identifier: agoraRequestIdentifiers.sendMessage,
        params: { clientMessageId: 'attempt', groupId: randomUUID(), text: 'Hello' }
      })
    })
    const response = await handler(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'This client message identifier is already in use.'
    })
  })

  it('projects bounded Realtime authorization failures', async () => {
    const handler = createAgoraHandler({
      authenticate: vi.fn().mockResolvedValue(context),
      createDispatcher: () => ({
        dispatch: vi.fn().mockRejectedValue(
          new AgoraRealtimeRequestError('This Realtime session is not permitted.', 403)
        )
      }),
      parseRequest: vi.fn().mockResolvedValue({
        identifier: agoraRequestIdentifiers.createRealtimeSession,
        params: { groupIds: [randomUUID()] }
      })
    })
    const response = await handler(request())

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'This Realtime session is not permitted.'
    })
  })
})
