import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAnonymousClient,
  createDatabaseClient
} from './localSupabase'

const healthUrl = 'http://127.0.0.1:54321/functions/v1/health'
const sensitiveTerms = /agent|credential|database|group|invitation|message|principal|schema|stack|supabase|unread|user/i
let database: Client

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const getHealth = (path = healthUrl, init?: RequestInit) => fetch(path, {
  redirect: 'manual',
  signal: AbortSignal.timeout(3000),
  ...init
})

const expectGenericFailure = async (response: Response, status: number) => {
  expect(response.status).toBe(status)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = await response.text()
  expect(JSON.parse(body)).toEqual({ ok: false })
  expect(body).not.toMatch(sensitiveTerms)
}

beforeAll(async () => {
  database = createDatabaseClient('agora-health-security-tests')
  await database.connect()

  const response = await getHealth()

  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get('retry-after'))
    await response.body?.cancel()
    await sleep((retryAfterSeconds * 1000) + 100)
  } else {
    expect(response.status).toBe(200)
    await response.body?.cancel()
  }
})

afterAll(async () => {
  await database?.query('grant execute on function public.agora_health_check() to service_role')
  await database?.end()
})

describe.sequential('anonymous health endpoint', () => {
  it('limits anonymous database grants to principal resolution and active-member operations', async () => {
    const functions = await database.query<{
      allowed: boolean
      function_name: string
    }>(`
      select
        has_function_privilege('anon', functions.oid, 'execute') as allowed,
        functions.proname as function_name
      from pg_proc as functions
      inner join pg_namespace as schemas
        on schemas.oid = functions.pronamespace
      where schemas.nspname = 'public'
      order by functions.proname
    `)
    const healthGrants = await database.query<{
      anonymous: boolean
      authenticated: boolean
      service: boolean
    }>(`
      select
        has_function_privilege('anon', 'public.agora_health_check()', 'execute') as anonymous,
        has_function_privilege('authenticated', 'public.agora_health_check()', 'execute') as authenticated,
        has_function_privilege('service_role', 'public.agora_health_check()', 'execute') as service
    `)
    const tables = await database.query<{
      privilege_type: string
      table_name: string
    }>(`
      select privilege_type, table_name
      from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee = 'anon'
      order by table_name, privilege_type
    `)

    expect(functions.rows.filter(({ allowed }) => allowed)).toEqual([
      { allowed: true, function_name: 'authorize_agora_realtime_topics' },
      { allowed: true, function_name: 'current_agent_principal_id' },
      { allowed: true, function_name: 'current_principal_id' },
      { allowed: true, function_name: 'current_principal_is_group_member' },
      { allowed: true, function_name: 'get_agora_group' },
      { allowed: true, function_name: 'get_agora_group_messages' },
      { allowed: true, function_name: 'get_agora_unread_messages' },
      { allowed: true, function_name: 'list_agora_group_members' },
      { allowed: true, function_name: 'list_agora_groups' },
      { allowed: true, function_name: 'mark_agora_group_read' },
      { allowed: true, function_name: 'send_agora_message' }
    ])
    expect(healthGrants.rows).toEqual([{
      anonymous: false,
      authenticated: false,
      service: true
    }])
    expect(tables.rows).toEqual([
      { privilege_type: 'SELECT', table_name: 'groups' },
      { privilege_type: 'SELECT', table_name: 'membership_read_watermarks' },
      { privilege_type: 'SELECT', table_name: 'memberships' },
      { privilege_type: 'SELECT', table_name: 'messages' },
      { privilege_type: 'SELECT', table_name: 'principals' }
    ])
  })

  it('executes the fixed database check for an anonymous caller before returning a safe response', async () => {
    const directCheck = await createAnonymousClient().rpc('agora_health_check')
    const response = await getHealth()

    expect(directCheck.error).not.toBeNull()
    expect(directCheck.data).toBeNull()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ ok: true })
    expect(body).not.toMatch(sensitiveTerms)
  })

  it('does not accept suffix paths, probe parameters, bodies, or alternate methods', async () => {
    const responses = await Promise.all([
      getHealth(`${healthUrl}/unexpected`),
      getHealth(`${healthUrl}?inspect=schema`),
      getHealth(healthUrl, { method: 'PUT' }),
      getHealth(healthUrl, {
        body: JSON.stringify({ inspect: 'messages' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST'
      })
    ])

    await Promise.all([
      expectGenericFailure(responses[0], 400),
      expectGenericFailure(responses[1], 400),
      expectGenericFailure(responses[2], 405),
      expectGenericFailure(responses[3], 405)
    ])
  })

  it('ignores chat-shaped credentials and returns no capability-bearing data', async () => {
    const response = await getHealth(healthUrl, {
      headers: {
        authorization: 'Bearer deliberately-invalid',
        'x-agora-agent-key': 'agora_agent_deliberately_invalid'
      }
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('returns a bounded generic 503 when the database check is denied', async () => {
    await database.query('revoke execute on function public.agora_health_check() from service_role')
    const startedAt = performance.now()

    try {
      const response = await getHealth()

      expect(performance.now() - startedAt).toBeLessThan(2500)
      await expectGenericFailure(response, 503)
    } finally {
      await database.query('grant execute on function public.agora_health_check() to service_role')
    }
  })

  it('rate limits bursts without exposing service state', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => getHealth()))
    const limited = responses.find((response) => response.status === 429)

    expect(responses.some((response) => response.status === 200)).toBe(true)
    expect(limited).toBeDefined()
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0)
    await expectGenericFailure(limited as Response, 429)
  })
})
