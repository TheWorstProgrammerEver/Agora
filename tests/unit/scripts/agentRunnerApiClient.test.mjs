import { describe, expect, it, vi } from 'vitest'
import { createAgoraApiClient, AgoraApiError } from '../../../scripts/agent-runner/api-client.mjs'

const exampleCredential = () => `agora_agent_v1_${'A'.repeat(43)}`
const group = {
  createdAt: '2026-08-12T00:00:00.000Z',
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Example group',
  ownerPrincipalId: '22222222-2222-4222-8222-222222222222',
  unreadCount: 0
}
const response = (status, body) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status
})

const createClient = (fetchImpl, overrides = {}) => createAgoraApiClient({
  apiUrl: 'https://example.supabase.co/functions/v1/agora',
  credentialReader: async () => exampleCredential(),
  fetchImpl,
  maximumAttempts: 3,
  publishableKey: 'example-public-key',
  retryBaseMs: 1,
  sleep: async () => undefined,
  timeoutMs: 1000,
  ...overrides
})

describe('agent runner API client', () => {
  it('retries bounded transient failures and validates the canonical response', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(503, { error: 'generated upstream marker' }))
      .mockResolvedValueOnce(response(200, { items: [group] }))
    const client = createClient(fetchImpl)

    await expect(client.invoke('listGroups', { limit: 100 })).resolves.toEqual({ items: [group] })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const request = fetchImpl.mock.calls[1][1]
    expect(JSON.parse(request.body)).toEqual({
      identifier: 'listGroups',
      params: { limit: 100 },
      version: 1
    })
    expect(request.headers['x-agora-agent-key']).toBe(exampleCredential())
  })

  it('does not retry authorization denial or project response content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(403, {
      error: `generated denial ${exampleCredential()}`
    }))
    const client = createClient(fetchImpl)
    let error

    try {
      await client.invoke('listGroups', {})
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(AgoraApiError)
    expect(error).toMatchObject({ code: 'authorization_denied', retryable: false, status: 403 })
    expect(error.message).not.toContain('generated denial')
    expect(error.message).not.toContain(exampleCredential())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries malformed success only within the configured budget', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { items: 'invalid' }))
    const client = createClient(fetchImpl, { maximumAttempts: 2 })

    await expect(client.invoke('listGroups', {})).rejects.toMatchObject({ code: 'response_invalid' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('honors cancellation before starting a request', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn()
    controller.abort()

    await expect(createClient(fetchImpl).invoke('listGroups', {}, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'canceled' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('settles cancellation while a response body is still streaming', async () => {
    const controller = new AbortController()
    const responseBody = new ReadableStream({
      start(stream) {
        controller.signal.addEventListener('abort', () => {
          stream.error(new Error('generated stream cancellation detail'))
        }, { once: true })
      }
    })
    const fetchImpl = vi.fn().mockResolvedValue(new Response(responseBody, { status: 200 }))
    const request = createClient(fetchImpl).invoke('listGroups', {}, {
      signal: controller.signal
    })
    controller.abort()

    await expect(request).rejects.toMatchObject({ code: 'canceled' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries a failed response stream within the bounded request budget', async () => {
    const failedBody = new ReadableStream({
      start(stream) {
        stream.error(new Error('generated stream failure detail'))
      }
    })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(failedBody, { status: 200 }))
      .mockResolvedValueOnce(response(200, { items: [group] }))

    await expect(createClient(fetchImpl).invoke('listGroups', {}))
      .resolves.toEqual({ items: [group] })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
