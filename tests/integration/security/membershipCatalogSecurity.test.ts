import { describe, expect, it } from 'vitest'
import { createDatabaseClient } from './localSupabase'

const membershipFunctions = [
  'accept_agora_invitation',
  'add_agora_agent_member',
  'invite_agora_human',
  'list_agora_group_members',
  'list_agora_pending_invitations',
  'reject_agora_invitation',
  'remove_agora_group_member'
]

const agentCallableFunctions = new Set(['list_agora_group_members'])

const withDatabase = async <T>(run: (
  database: ReturnType<typeof createDatabaseClient>
) => Promise<T>) => {
  const database = createDatabaseClient('agora-membership-catalog-security')

  try {
    await database.connect()
    return await run(database)
  } finally {
    await database.end()
  }
}

describe('membership command database catalog security', () => {
  it('keeps every function security-definer with an empty search path', async () => {
    const rows = await withDatabase(async (database) => (
      await database.query<{
        name: string
        securityDefiner: boolean
        settings: string[]
      }>(`
        select
          proname as name,
          prosecdef as "securityDefiner",
          coalesce(proconfig, '{}') as settings
        from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = any($1::text[])
        order by proname
      `, [membershipFunctions])
    ).rows)

    expect(rows.map(({ name }) => name)).toEqual([...membershipFunctions].sort())
    expect(rows.every(({ securityDefiner }) => securityDefiner)).toBe(true)
    expect(rows.every(({ settings }) => settings.includes('search_path=""'))).toBe(true)
  })

  it('gives agents only the active-member query while humans receive the command catalog', async () => {
    const rows = await withDatabase(async (database) => (
      await database.query<{
        anon: boolean
        authenticated: boolean
        name: string
      }>(`
        select
          proname as name,
          has_function_privilege('anon', oid, 'execute') as anon,
          has_function_privilege('authenticated', oid, 'execute') as authenticated
        from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = any($1::text[])
        order by proname
      `, [membershipFunctions])
    ).rows)

    expect(rows).toHaveLength(membershipFunctions.length)
    expect(rows.every(({ authenticated }) => authenticated)).toBe(true)
    expect(rows.filter(({ anon }) => anon).map(({ name }) => name)).toEqual([
      ...agentCallableFunctions
    ])
  })
})
