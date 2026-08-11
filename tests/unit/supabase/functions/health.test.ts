import { describe, expect, it, vi } from 'vitest'
import { readHealthConfig } from '../../../../supabase/functions/health/config'
import { createDatabaseCheck } from '../../../../supabase/functions/health/databaseCheck'
import { createHealthHandler } from '../../../../supabase/functions/health/handler'
import { createRateLimiter } from '../../../../supabase/functions/health/rateLimiter'

const healthRequest = (path = '/functions/v1/health', init?: RequestInit) => new Request(
  `http://localhost${path}`,
  init
)

describe('health handler', () => {
  it('returns only the safe success payload after the database check', async () => {
    const checkDatabase = vi.fn().mockResolvedValue(true)
    const handler = createHealthHandler({ checkDatabase, takeRateLimit: () => ({ allowed: true }) })
    const response = await handler(healthRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(checkDatabase).toHaveBeenCalledOnce()
  })

  it('projects database errors to one generic failure', async () => {
    const handler = createHealthHandler({
      checkDatabase: vi.fn().mockRejectedValue(new Error('private database detail')),
      takeRateLimit: () => ({ allowed: true })
    })
    const response = await handler(healthRequest())

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ ok: false })
  })

  it.each([
    ['a non-GET method', healthRequest('/functions/v1/health', { method: 'POST' }), 405],
    ['query parameters', healthRequest('/functions/v1/health?probe=schema'), 400],
    ['a request body', healthRequest('/functions/v1/health', {
      body: 'probe',
      method: 'POST'
    }), 405]
  ])('rejects %s without checking the database', async (_label, request, status) => {
    const checkDatabase = vi.fn().mockResolvedValue(true)
    const handler = createHealthHandler({ checkDatabase, takeRateLimit: () => ({ allowed: true }) })
    const response = await handler(request)

    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ ok: false })
    expect(checkDatabase).not.toHaveBeenCalled()
  })

  it('uses a monotonic fixed-window request budget', () => {
    let now = 100
    const takeRateLimit = createRateLimiter(2, 1000, () => now)

    expect(takeRateLimit()).toEqual({ allowed: true })
    expect(takeRateLimit()).toEqual({ allowed: true })
    expect(takeRateLimit()).toEqual({ allowed: false, retryAfterSeconds: 1 })
    now = 1100
    expect(takeRateLimit()).toEqual({ allowed: true })
  })
})

describe('health database check', () => {
  it('uses the server-only key for one fixed bounded GET RPC', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('true'))
    const checkDatabase = createDatabaseCheck({
      fetch,
      supabaseServiceRoleKey: 'server-only-project-key',
      supabaseUrl: 'https://project.example.test',
      timeoutMs: 750
    })

    await expect(checkDatabase()).resolves.toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]
    expect(url.toString()).toBe('https://project.example.test/rest/v1/rpc/agora_health_check')
    expect(init).toMatchObject({
      headers: {
        apikey: 'server-only-project-key',
        authorization: 'Bearer server-only-project-key',
        'cache-control': 'no-store'
      },
      method: 'GET'
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('fails closed for missing or invalid configuration', async () => {
    const fetch = vi.fn()
    const missingConfig = createDatabaseCheck({
      fetch,
      supabaseServiceRoleKey: '',
      supabaseUrl: '',
      timeoutMs: 1000
    })
    const invalidUrl = createDatabaseCheck({
      fetch,
      supabaseServiceRoleKey: 'server-only-project-key',
      supabaseUrl: 'not a URL',
      timeoutMs: 1000
    })

    await expect(missingConfig()).resolves.toBe(false)
    await expect(invalidUrl()).resolves.toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('health configuration', () => {
  it('bounds operator-provided values and falls back safely', () => {
    const values = new Map([
      ['AGORA_HEALTH_DATABASE_TIMEOUT_MS', '999999'],
      ['AGORA_HEALTH_RATE_LIMIT', '12'],
      ['AGORA_HEALTH_RATE_LIMIT_WINDOW_MS', 'invalid'],
      ['SUPABASE_SERVICE_ROLE_KEY', 'server-only-project-key'],
      ['SUPABASE_URL', 'https://project.example.test']
    ])

    expect(readHealthConfig((name) => values.get(name))).toEqual({
      databaseTimeoutMs: 1000,
      rateLimit: 12,
      rateLimitWindowMs: 10000,
      supabaseServiceRoleKey: 'server-only-project-key',
      supabaseUrl: 'https://project.example.test'
    })
  })
})
