import { describe, expect, it } from 'vitest'
import { agoraRealtimeAgentRole } from '../../../common/agoraRealtime'
import { createDatabaseClient } from './localSupabase'

const withDatabase = async <T>(run: (
  database: ReturnType<typeof createDatabaseClient>
) => Promise<T>) => {
  const database = createDatabaseClient('agora-realtime-catalog-security')

  try {
    await database.connect()
    return await run(database)
  } finally {
    await database.end()
  }
}

describe('private Realtime migration and catalog boundary', () => {
  it('defines a bounded non-login agent role with no management attributes', async () => {
    const role = await withDatabase(async (database) => (
      await database.query<{
        bypassRls: boolean
        canLogin: boolean
        createDatabase: boolean
        createRole: boolean
        inherit: boolean
        replication: boolean
        superuser: boolean
      }>(`
        select
          rolbypassrls as "bypassRls",
          rolcanlogin as "canLogin",
          rolcreatedb as "createDatabase",
          rolcreaterole as "createRole",
          rolinherit as inherit,
          rolreplication as replication,
          rolsuper as superuser
        from pg_roles
        where rolname = $1
      `, [agoraRealtimeAgentRole])
    ).rows[0])
    const memberships = await withDatabase(async (database) => (
      await database.query<{ role: string }>(`
        select granted.rolname as role
        from pg_auth_members
        join pg_roles as member on member.oid = pg_auth_members.member
        join pg_roles as granted on granted.oid = pg_auth_members.roleid
        where member.rolname = $1
        order by granted.rolname
      `, [agoraRealtimeAgentRole])
    ).rows)
    const authenticatorCanSetRole = await withDatabase(async (database) => (
      await database.query<{ allowed: boolean }>(`
        select pg_has_role('authenticator', $1, 'member') as allowed
      `, [agoraRealtimeAgentRole])
    ).rows[0]?.allowed)

    expect(role).toEqual({
      bypassRls: false,
      canLogin: false,
      createDatabase: false,
      createRole: false,
      inherit: true,
      replication: false,
      superuser: false
    })
    expect(memberships).toEqual([{ role: 'authenticated' }])
    expect(authenticatorCanSetRole).toBe(true)
  })

  it('adds no direct exposed Data API grants beyond inherited RLS roles', async () => {
    const directTableGrants = await withDatabase(async (database) => (
      await database.query<{ name: string }>(`
        select format('%I.%I', namespaces.nspname, relations.relname) as name
        from pg_class as relations
        join pg_namespace as namespaces on namespaces.oid = relations.relnamespace
        cross join lateral aclexplode(relations.relacl) as privileges
        join pg_roles as grantee on grantee.oid = privileges.grantee
        where namespaces.nspname in ('public', 'graphql_public')
          and grantee.rolname = $1
        order by name
      `, [agoraRealtimeAgentRole])
    ).rows)
    const directFunctionGrants = await withDatabase(async (database) => (
      await database.query<{ name: string }>(`
        select format('%I.%I(%s)', namespaces.nspname, functions.proname,
          pg_get_function_identity_arguments(functions.oid)) as name
        from pg_proc as functions
        join pg_namespace as namespaces on namespaces.oid = functions.pronamespace
        cross join lateral aclexplode(functions.proacl) as privileges
        join pg_roles as grantee on grantee.oid = privileges.grantee
        where namespaces.nspname in ('public', 'graphql_public')
          and grantee.rolname = $1
        order by name
      `, [agoraRealtimeAgentRole])
    ).rows)
    const realtimePrivileges = await withDatabase(async (database) => (
      await database.query<{
        delete: boolean
        insert: boolean
        select: boolean
        update: boolean
      }>(`
        select
          has_table_privilege($1, 'realtime.messages', 'delete') as delete,
          has_table_privilege($1, 'realtime.messages', 'insert') as insert,
          has_table_privilege($1, 'realtime.messages', 'select') as select,
          has_table_privilege($1, 'realtime.messages', 'update') as update
      `, [agoraRealtimeAgentRole])
    ).rows[0])

    expect(directTableGrants).toEqual([])
    expect(directFunctionGrants).toEqual([])
    expect(realtimePrivileges).toEqual({
      delete: false,
      insert: true,
      select: true,
      update: true
    })
  })

  it('authorizes private broadcast reads only and emits metadata through one fixed trigger', async () => {
    const policies = await withDatabase(async (database) => (
      await database.query<{
        command: string
        name: string
        roles: string[]
        using: string
      }>(`
        select
          cmd as command,
          policyname as name,
          roles::text[] as roles,
          qual as using
        from pg_policies
        where schemaname = 'realtime'
          and tablename = 'messages'
        order by policyname
      `)
    ).rows)
    const triggerDefinition = await withDatabase(async (database) => (
      await database.query<{ definition: string }>(`
        select pg_get_functiondef(oid) as definition
        from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = 'broadcast_agora_message_availability'
      `)
    ).rows[0]?.definition)

    expect(policies).toHaveLength(2)
    expect(policies.map(({ command }) => command)).toEqual(['SELECT', 'SELECT'])
    expect(policies.map(({ roles }) => roles).flat().sort()).toEqual([
      'agora_realtime_agent',
      'authenticated'
    ])
    expect(policies.every(({ using: expression }) => (
      expression.includes("extension = 'broadcast'")
    ))).toBe(true)
    expect(triggerDefinition).toContain("'groupId'")
    expect(triggerDefinition).toContain("'highWatermarkSequence'")
    expect(triggerDefinition).toContain("'message_available'")
    expect(triggerDefinition).toContain('true')
    expect(triggerDefinition).not.toMatch(/new\.text|application_key|sender/i)
  })
})
