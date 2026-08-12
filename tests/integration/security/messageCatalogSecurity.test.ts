import { describe, expect, it } from 'vitest'
import {
  maximumClientMessageIdLength,
  maximumMessageTextLength
} from '../../../common/agoraMessageLimits'
import { createDatabaseClient } from './localSupabase'

const withDatabase = async <T>(run: (
  database: ReturnType<typeof createDatabaseClient>
) => Promise<T>) => {
  const database = createDatabaseClient('agora-message-catalog-security')

  try {
    await database.connect()
    return await run(database)
  } finally {
    await database.end()
  }
}

describe('message migration and database catalog security', () => {
  it('keeps the send function security-definer, RLS-aware, and callable by both principal roles', async () => {
    const row = await withDatabase(async (database) => (
      await database.query<{
        anon: boolean
        authenticated: boolean
        securityDefiner: boolean
        settings: string[]
      }>(`
        select
          has_function_privilege('anon', oid, 'execute') as anon,
          has_function_privilege('authenticated', oid, 'execute') as authenticated,
          prosecdef as "securityDefiner",
          coalesce(proconfig, '{}') as settings
        from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = 'send_agora_message'
      `)
    ).rows[0])

    expect(row).toMatchObject({
      anon: true,
      authenticated: true,
      securityDefiner: true
    })
    expect(row.settings).toContain('search_path=""')
  })

  it('exposes only member-filtered message reads and no ordinary idempotency or mutation privilege', async () => {
    const privileges = await withDatabase(async (database) => (
      await database.query<{
        anonDelete: boolean
        anonIdempotencySelect: boolean
        anonIdempotencyWrite: boolean
        anonInsert: boolean
        anonSelect: boolean
        anonUpdate: boolean
        authenticatedDelete: boolean
        authenticatedIdempotencySelect: boolean
        authenticatedIdempotencyWrite: boolean
        authenticatedInsert: boolean
        authenticatedSelect: boolean
        authenticatedUpdate: boolean
      }>(`
        select
          has_table_privilege('anon', 'public.messages', 'select') as "anonSelect",
          has_table_privilege('anon', 'public.messages', 'insert') as "anonInsert",
          has_table_privilege('anon', 'public.messages', 'update') as "anonUpdate",
          has_table_privilege('anon', 'public.messages', 'delete') as "anonDelete",
          has_table_privilege(
            'anon', 'public.message_idempotency_keys', 'select'
          ) as "anonIdempotencySelect",
          (
            has_table_privilege('anon', 'public.message_idempotency_keys', 'insert')
            or has_table_privilege('anon', 'public.message_idempotency_keys', 'update')
            or has_table_privilege('anon', 'public.message_idempotency_keys', 'delete')
          ) as "anonIdempotencyWrite",
          has_table_privilege(
            'authenticated', 'public.messages', 'select'
          ) as "authenticatedSelect",
          has_table_privilege(
            'authenticated', 'public.messages', 'insert'
          ) as "authenticatedInsert",
          has_table_privilege(
            'authenticated', 'public.messages', 'update'
          ) as "authenticatedUpdate",
          has_table_privilege(
            'authenticated', 'public.messages', 'delete'
          ) as "authenticatedDelete",
          has_table_privilege(
            'authenticated', 'public.message_idempotency_keys', 'select'
          ) as "authenticatedIdempotencySelect",
          (
            has_table_privilege(
              'authenticated', 'public.message_idempotency_keys', 'insert'
            )
            or has_table_privilege(
              'authenticated', 'public.message_idempotency_keys', 'update'
            )
            or has_table_privilege(
              'authenticated', 'public.message_idempotency_keys', 'delete'
            )
          ) as "authenticatedIdempotencyWrite"
      `)
    ).rows[0])
    const relations = await withDatabase(async (database) => (
      await database.query<{ name: string, rowSecurity: boolean }>(`
        select relname as name, relrowsecurity as "rowSecurity"
        from pg_class
        where oid in (
          'public.messages'::regclass,
          'public.message_idempotency_keys'::regclass
        )
        order by relname
      `)
    ).rows)
    const policies = await withDatabase(async (database) => (
      await database.query<{ name: string, tableName: string }>(`
        select policyname as name, tablename as "tableName"
        from pg_policies
        where schemaname = 'public'
          and tablename in ('messages', 'message_idempotency_keys')
        order by tablename, policyname
      `)
    ).rows)

    expect(privileges).toEqual({
      anonDelete: false,
      anonIdempotencySelect: false,
      anonIdempotencyWrite: false,
      anonInsert: false,
      anonSelect: true,
      anonUpdate: false,
      authenticatedDelete: false,
      authenticatedIdempotencySelect: false,
      authenticatedIdempotencyWrite: false,
      authenticatedInsert: false,
      authenticatedSelect: true,
      authenticatedUpdate: false
    })
    expect(relations).toEqual([
      { name: 'message_idempotency_keys', rowSecurity: true },
      { name: 'messages', rowSecurity: true }
    ])
    expect(policies).toEqual([{
      name: 'Active members can read messages',
      tableName: 'messages'
    }])
  })

  it('defines cascade ownership, sender integrity, exact limits, and no message rewrite RPC', async () => {
    const constraints = await withDatabase(async (database) => (
      await database.query<{
        deleteAction: string
        definition: string
        name: string
        referencedTable: string | null
        tableName: string
      }>(`
        select
          constraint_row.conname as name,
          constraint_row.conrelid::regclass::text as "tableName",
          nullif(constraint_row.confrelid, 0)::regclass::text as "referencedTable",
          constraint_row.confdeltype::text as "deleteAction",
          pg_get_constraintdef(constraint_row.oid) as definition
        from pg_constraint as constraint_row
        where constraint_row.conrelid in (
          'public.messages'::regclass,
          'public.message_idempotency_keys'::regclass
        )
        order by constraint_row.conname
      `)
    ).rows)
    const forbiddenFunctions = await withDatabase(async (database) => (
      await database.query<{ name: string }>(`
        select proname as name
        from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname ilike '%message%'
          and (
            proname ilike '%delete%'
            or proname ilike '%edit%'
            or proname ilike '%update%'
          )
      `)
    ).rows)
    const byName = new Map(constraints.map((constraint) => [constraint.name, constraint]))

    expect(byName.get('messages_group_id_fkey')).toMatchObject({
      deleteAction: 'c',
      referencedTable: 'groups',
      tableName: 'messages'
    })
    expect(byName.get('message_idempotency_keys_group_id_fkey')).toMatchObject({
      deleteAction: 'c',
      referencedTable: 'groups',
      tableName: 'message_idempotency_keys'
    })
    expect(byName.get('message_idempotency_keys_group_message_fkey')).toMatchObject({
      deleteAction: 'c',
      referencedTable: 'messages'
    })
    expect(byName.get('messages_sender_principal_id_fkey')).toMatchObject({
      deleteAction: 'r',
      referencedTable: 'principals'
    })
    expect(byName.get('message_idempotency_keys_sender_principal_id_fkey')).toMatchObject({
      deleteAction: 'r',
      referencedTable: 'principals'
    })
    expect(byName.get('messages_text_length')?.definition).toContain(
      String(maximumMessageTextLength)
    )
    expect(byName.get('message_idempotency_keys_client_id_length')?.definition).toContain(
      String(maximumClientMessageIdLength)
    )
    expect(byName.get('messages_group_sequence_key')?.definition).toContain(
      'UNIQUE (group_id, sequence)'
    )
    expect(forbiddenFunctions).toEqual([])
  })
})
