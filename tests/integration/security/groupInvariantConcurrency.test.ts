import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { createHumanFixture, deleteHumanFixtures } from './humanFixture'
import { createAdminClient, createDatabaseClient } from './localSupabase'

const admin = createAdminClient()

const waitForDatabaseLock = async (observer: Client, applicationName: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await observer.query<{ wait_event_type: string | null }>(
      `select wait_event_type
       from pg_catalog.pg_stat_activity
       where application_name = $1 and state = 'active'`,
      [applicationName]
    )

    if (rows.some(({ wait_event_type }) => wait_event_type === 'Lock')) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(`Database session ${applicationName} did not wait on the owner invariant lock.`)
}

const expectGroupMissing = async (groupId: string) => {
  const { count, error } = await admin
    .from('groups')
    .select('id', { count: 'exact', head: true })
    .eq('id', groupId)

  if (error) {
    throw error
  }

  expect(count).toBe(0)
}

describe('group-domain concurrent invariants', () => {
  it('serializes principal conversion against concurrent group creation', async () => {
    const human = await createHumanFixture('owner-race')
    const groupId = randomUUID()
    const sessionSuffix = randomUUID().slice(0, 8)
    const conversionSession = createDatabaseClient(`agora-owner-conversion-${sessionSuffix}`)
    const creationApplicationName = `agora-group-creation-${sessionSuffix}`
    const creationSession = createDatabaseClient(creationApplicationName)
    let conversionTransactionOpen = false
    let groupInsertion: Promise<unknown> | undefined

    try {
      await Promise.all([conversionSession.connect(), creationSession.connect()])
      await conversionSession.query('begin')
      conversionTransactionOpen = true
      await conversionSession.query(
        `update public.principals
         set auth_user_id = null, kind = 'agent'::public.principal_kind
         where id = $1`,
        [human.principalId]
      )

      let groupInsertionSettled = false
      groupInsertion = creationSession.query(
        `insert into public.groups (id, name, owner_principal_id)
         values ($1, $2, $3)`,
        [groupId, 'Concurrent owner validation group', human.principalId]
      ).then(
        () => {
          groupInsertionSettled = true
          return undefined
        },
        (error: unknown) => {
          groupInsertionSettled = true
          return error
        }
      )

      await waitForDatabaseLock(conversionSession, creationApplicationName)
      expect(groupInsertionSettled).toBe(false)
      await conversionSession.query('commit')
      conversionTransactionOpen = false

      await expect(groupInsertion).resolves.toMatchObject({ code: '23514' })
      await expectGroupMissing(groupId)
    } finally {
      if (conversionTransactionOpen) {
        await conversionSession.query('rollback')
      }

      await groupInsertion
      await Promise.allSettled([conversionSession.end(), creationSession.end()])
      await admin.from('groups').delete().eq('id', groupId)
      const restoreResult = await admin
        .from('principals')
        .update({ auth_user_id: human.userId, kind: 'human' })
        .eq('id', human.principalId)

      if (restoreResult.error) {
        throw restoreResult.error
      }

      await deleteHumanFixtures([human])
    }
  })
})
