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
  selectCount,
  type GroupLifecycleFixtures
} from './groupLifecycleTestSupport'
import { createDatabaseClient } from './localSupabase'

let fixtures: GroupLifecycleFixtures | undefined

const requireFixtures = () => {
  if (!fixtures) {
    throw new Error('Message membership concurrency fixtures were not created.')
  }

  return fixtures
}

const waitForMessageSendLock = async (
  observer: ReturnType<typeof createDatabaseClient>
) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await observer.query<{ wait_event_type: string | null }>(
      `select wait_event_type
       from pg_catalog.pg_stat_activity
       where pid <> pg_backend_pid()
         and state = 'active'
         and query like '%send_agora_message%'`
    )

    if (rows.some(({ wait_event_type }) => wait_event_type === 'Lock')) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error('The concurrent message send did not wait on the group lock.')
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('message membership concurrency', () => {
  it('denies a send that queued behind removal of the sender', async () => {
    const { member, owner } = requireFixtures()
    const group = await createGroup(owner, 'Concurrent member removal group')
    const sessionSuffix = randomUUID().slice(0, 8)
    const removalSession = createDatabaseClient(`agora-member-removal-${sessionSuffix}`)
    const observerSession = createDatabaseClient(`agora-send-observer-${sessionSuffix}`)
    let removalTransactionOpen = false
    let send: ReturnType<typeof postHuman<'sendMessage'>> | undefined

    try {
      await insertMembership(group.id, member.principalId)
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

      send = postHuman(member, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'send-queued-behind-removal',
        groupId: group.id,
        text: 'Must be denied after removal'
      })

      await waitForMessageSendLock(observerSession)
      await removalSession.query('commit')
      removalTransactionOpen = false

      await expect(send).resolves.toMatchObject({ status: 403 })
      await expect(Promise.all([
        selectCount('messages', 'group_id', group.id),
        selectCount('message_idempotency_keys', 'group_id', group.id, 'message_id')
      ])).resolves.toEqual([0, 0])

      const groupState = await admin
        .from('groups')
        .select('last_message_sequence')
        .eq('id', group.id)
        .single()

      expect(groupState.error).toBeNull()
      expect(groupState.data?.last_message_sequence).toBe(0)
    } finally {
      if (removalTransactionOpen) {
        await removalSession.query('rollback')
      }

      await send?.catch(() => undefined)
      await Promise.allSettled([removalSession.end(), observerSession.end()])
      const { error } = await admin.from('groups').delete().eq('id', group.id)

      if (error) {
        throw error
      }
    }
  })
})
