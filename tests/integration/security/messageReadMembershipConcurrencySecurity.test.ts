import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'
import {
  cleanupGroupLifecycleFixtures,
  createGroup,
  createGroupLifecycleFixtures,
  groupLifecycleAdmin as admin,
  insertMembership,
  postHuman,
  type GroupLifecycleFixtures
} from './groupLifecycleTestSupport'
import { createDatabaseClient } from './localSupabase'

let fixtures: GroupLifecycleFixtures | undefined

const requireFixtures = () => {
  if (!fixtures) {
    throw new Error('Message read concurrency fixtures were not created.')
  }

  return fixtures
}

const waitForMessageReadLock = async (
  observer: ReturnType<typeof createDatabaseClient>
) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await observer.query<{ wait_event_type: string | null }>(
      `select wait_event_type
       from pg_catalog.pg_stat_activity
       where pid <> pg_backend_pid()
         and state = 'active'
         and query like '%get_agora_group_messages%'`
    )

    if (rows.some(({ wait_event_type }) => wait_event_type === 'Lock')) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error('The concurrent message read did not wait on the group lock.')
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('message read membership concurrency', () => {
  it('denies a context read that queued behind removal of the reader', async () => {
    const { member, owner } = requireFixtures()
    const group = await createGroup(owner, 'Concurrent message read removal group')
    const sessionSuffix = randomUUID().slice(0, 8)
    const removalSession = createDatabaseClient(`agora-read-removal-${sessionSuffix}`)
    const observerSession = createDatabaseClient(`agora-read-observer-${sessionSuffix}`)
    let removalTransactionOpen = false
    let read: ReturnType<typeof postHuman<'getGroupMessages'>> | undefined

    try {
      await insertMembership(group.id, member.principalId)
      const sent = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'message-before-reader-removal',
        groupId: group.id,
        text: 'This must not leak after removal'
      })

      expect(sent.status).toBe(200)
      await Promise.all([removalSession.connect(), observerSession.connect()])
      await removalSession.query('begin')
      removalTransactionOpen = true
      await removalSession.query(
        `select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ role: 'authenticated', sub: owner.userId })]
      )
      await removalSession.query('set local role authenticated')
      await removalSession.query(
        `select *
         from public.remove_agora_group_member($1, $2)`,
        [group.id, member.principalId]
      )

      read = postHuman(member, agoraRequestIdentifiers.getGroupMessages, {
        groupId: group.id
      })

      await waitForMessageReadLock(observerSession)
      await removalSession.query('commit')
      removalTransactionOpen = false

      await expect(read).resolves.toMatchObject({ status: 403 })
      const directRows = await member.client.from('messages').select('id')

      expect(directRows.error).toBeNull()
      expect(directRows.data).toEqual([])
    } finally {
      if (removalTransactionOpen) {
        await removalSession.query('rollback')
      }

      await read?.catch(() => undefined)
      await Promise.allSettled([removalSession.end(), observerSession.end()])
      const { error } = await admin.from('groups').delete().eq('id', group.id)

      if (error) {
        throw error
      }
    }
  })
})
