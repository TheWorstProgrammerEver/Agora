import { describe, expect, it } from 'vitest'
import { createDatabaseClient } from './localSupabase'

const lifecycleFunctions = [
  'begin_agent_application_key_rotation',
  'complete_agent_application_key_rotation',
  'deactivate_agent_principal',
  'provision_agent_principal',
  'revoke_agent_application_key',
  'rollback_agent_application_key_rotation'
]

const agentFunctions = [
  'agent_application_key_digest',
  'agent_application_key_is_well_formed',
  'current_agent_application_key',
  'current_agent_principal_id',
  'current_principal_id',
  'enforce_provisioned_agent_principal',
  'generate_agent_application_key',
  'protect_provisioned_agent_principal',
  ...lifecycleFunctions
]

const withDatabase = async <T>(run: (database: ReturnType<typeof createDatabaseClient>) => Promise<T>) => {
  const database = createDatabaseClient('agora-agent-key-catalog-security')

  try {
    await database.connect()
    return await run(database)
  } finally {
    await database.end()
  }
}

describe('agent-key database catalog security', () => {
  it('gives every agent-key function an explicit empty search path', async () => {
    const rows = await withDatabase(async (database) => (
      await database.query<{
        name: string
        settings: string[]
      }>(`
        select proname as name, coalesce(proconfig, '{}') as settings
        from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = any($1::text[])
        order by proname
      `, [agentFunctions])
    ).rows)

    expect(rows.map(({ name }) => name)).toEqual([...agentFunctions].sort())
    expect(rows.every(({ settings }) => settings.includes('search_path=""'))).toBe(true)
  })

  it('reserves lifecycle functions for service-role operators', async () => {
    const rows = await withDatabase(async (database) => (
      await database.query<{
        anon: boolean
        authenticated: boolean
        name: string
        service_role: boolean
      }>(`
        select
          proname as name,
          has_function_privilege('anon', oid, 'execute') as anon,
          has_function_privilege('authenticated', oid, 'execute') as authenticated,
          has_function_privilege('service_role', oid, 'execute') as service_role
        from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = any($1::text[])
        order by proname
      `, [lifecycleFunctions])
    ).rows)

    expect(rows).toHaveLength(lifecycleFunctions.length)
    expect(rows.every((row) => !row.anon && !row.authenticated && row.service_role)).toBe(true)
  })

  it('exposes only the RLS resolver and audit-safe operator view', async () => {
    const result = await withDatabase((database) => database.query<{
      agent_keys_rls: boolean
      agents_rls: boolean
      anon_agent_resolver: boolean
      anon_audit_view: boolean
      service_agent_keys: boolean
      service_audit_view: boolean
    }>(`
      select
        (select relrowsecurity from pg_class where oid = 'public.agent_application_keys'::regclass)
          as agent_keys_rls,
        (select relrowsecurity from pg_class where oid = 'public.provisioned_agents'::regclass)
          as agents_rls,
        has_function_privilege('anon', 'public.current_agent_principal_id()', 'execute')
          as anon_agent_resolver,
        has_table_privilege('anon', 'public.agent_application_key_audit', 'select')
          as anon_audit_view,
        has_table_privilege('service_role', 'public.agent_application_keys', 'select')
          as service_agent_keys,
        has_table_privilege('service_role', 'public.agent_application_key_audit', 'select')
          as service_audit_view
    `))

    expect(result.rows).toEqual([{
      agent_keys_rls: true,
      agents_rls: true,
      anon_agent_resolver: true,
      anon_audit_view: false,
      service_agent_keys: false,
      service_audit_view: true
    }])
  })
})
