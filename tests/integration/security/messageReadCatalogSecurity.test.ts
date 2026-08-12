import { describe, expect, it } from 'vitest'
import { createDatabaseClient } from './localSupabase'

const withDatabase = async <T>(run: (
  database: ReturnType<typeof createDatabaseClient>
) => Promise<T>) => {
  const database = createDatabaseClient('agora-message-read-catalog-security')

  try {
    await database.connect()
    return await run(database)
  } finally {
    await database.end()
  }
}

describe('message read migration and database catalog security', () => {
  it('keeps message read RPCs security-definer with explicit search paths', async () => {
    const functions = await withDatabase(async (database) => (
      await database.query<{
        anon: boolean
        authenticated: boolean
        name: string
        securityDefiner: boolean
        settings: string[]
      }>(`
        select
          has_function_privilege('anon', functions.oid, 'execute') as anon,
          has_function_privilege('authenticated', functions.oid, 'execute') as authenticated,
          functions.proname as name,
          functions.prosecdef as "securityDefiner",
          coalesce(functions.proconfig, '{}') as settings
        from pg_proc as functions
        where functions.pronamespace = 'public'::regnamespace
          and functions.proname in (
            'advance_message_sender_watermark',
            'get_agora_group_messages',
            'get_agora_unread_messages',
            'mark_agora_group_read'
          )
        order by functions.proname
      `)
    ).rows)

    expect(functions).toEqual([
      {
        anon: false,
        authenticated: false,
        name: 'advance_message_sender_watermark',
        securityDefiner: true,
        settings: ['search_path=""']
      },
      {
        anon: true,
        authenticated: true,
        name: 'get_agora_group_messages',
        securityDefiner: true,
        settings: ['search_path=""']
      },
      {
        anon: true,
        authenticated: true,
        name: 'get_agora_unread_messages',
        securityDefiner: true,
        settings: ['search_path=""']
      },
      {
        anon: true,
        authenticated: true,
        name: 'mark_agora_group_read',
        securityDefiner: true,
        settings: ['search_path=""']
      }
    ])
  })

  it('permits only RLS-filtered watermark reads to ordinary callers', async () => {
    const state = await withDatabase(async (database) => (
      await database.query<{
        anonDelete: boolean
        anonInsert: boolean
        anonSelect: boolean
        anonUpdate: boolean
        authenticatedDelete: boolean
        authenticatedInsert: boolean
        authenticatedSelect: boolean
        authenticatedUpdate: boolean
        rowSecurity: boolean
      }>(`
        select
          has_table_privilege(
            'anon', 'public.membership_read_watermarks', 'select'
          ) as "anonSelect",
          has_table_privilege(
            'anon', 'public.membership_read_watermarks', 'insert'
          ) as "anonInsert",
          has_table_privilege(
            'anon', 'public.membership_read_watermarks', 'update'
          ) as "anonUpdate",
          has_table_privilege(
            'anon', 'public.membership_read_watermarks', 'delete'
          ) as "anonDelete",
          has_table_privilege(
            'authenticated', 'public.membership_read_watermarks', 'select'
          ) as "authenticatedSelect",
          has_table_privilege(
            'authenticated', 'public.membership_read_watermarks', 'insert'
          ) as "authenticatedInsert",
          has_table_privilege(
            'authenticated', 'public.membership_read_watermarks', 'update'
          ) as "authenticatedUpdate",
          has_table_privilege(
            'authenticated', 'public.membership_read_watermarks', 'delete'
          ) as "authenticatedDelete",
          relations.relrowsecurity as "rowSecurity"
        from pg_class as relations
        where relations.oid = 'public.membership_read_watermarks'::regclass
      `)
    ).rows[0])
    const policies = await withDatabase(async (database) => (
      await database.query<{ command: string, name: string }>(`
        select cmd as command, policyname as name
        from pg_policies
        where schemaname = 'public'
          and tablename = 'membership_read_watermarks'
      `)
    ).rows)

    expect(state).toEqual({
      anonDelete: false,
      anonInsert: false,
      anonSelect: true,
      anonUpdate: false,
      authenticatedDelete: false,
      authenticatedInsert: false,
      authenticatedSelect: true,
      authenticatedUpdate: false,
      rowSecurity: true
    })
    expect(policies).toEqual([{
      command: 'SELECT',
      name: 'Members can read their own watermark'
    }])
  })

  it('binds each watermark to one membership with cascading deletion', async () => {
    const foreignKey = await withDatabase(async (database) => (
      await database.query<{
        deleteAction: string
        definition: string
        referencedTable: string
      }>(`
        select
          constraints.confdeltype::text as "deleteAction",
          pg_get_constraintdef(constraints.oid) as definition,
          constraints.confrelid::regclass::text as "referencedTable"
        from pg_constraint as constraints
        where constraints.conrelid = 'public.membership_read_watermarks'::regclass
          and constraints.contype = 'f'
      `)
    ).rows[0])
    const trigger = await withDatabase(async (database) => (
      await database.query<{ enabled: string, name: string }>(`
        select tgenabled as enabled, tgname as name
        from pg_trigger
        where tgrelid = 'public.messages'::regclass
          and not tgisinternal
          and tgname = 'advance_message_sender_watermark_after_insert'
      `)
    ).rows)

    expect(foreignKey).toMatchObject({
      deleteAction: 'c',
      referencedTable: 'memberships'
    })
    expect(foreignKey.definition).toContain('FOREIGN KEY (membership_id)')
    expect(trigger).toEqual([{
      enabled: 'O',
      name: 'advance_message_sender_watermark_after_insert'
    }])
  })
})
