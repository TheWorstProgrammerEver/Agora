import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgoraRequestResult } from '../../../common/agoraRequestContract'
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

let fixtures: GroupLifecycleFixtures | undefined

const requireFixtures = () => {
  if (!fixtures) {
    throw new Error('Message concurrency fixtures were not created.')
  }

  return fixtures
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('message sequence and idempotency concurrency', () => {
  it('serializes every authorized send and coalesces simultaneous retries', async () => {
    const { member, owner } = requireFixtures()
    const group = await createGroup(owner, 'Concurrent message group')
    const secondGroup = await createGroup(owner, 'Concurrent key scope group')

    try {
      await insertMembership(group.id, member.principalId)

      const concurrentSends = await Promise.all(Array.from({ length: 12 }, (_, index) => (
        postHuman(owner, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: `concurrent-${index}`,
          groupId: group.id,
          text: `Concurrent message ${index}`
        })
      )))

      expect(concurrentSends.every(({ status }) => status === 200)).toBe(true)
      const allocatedSequences = concurrentSends
        .map(({ body }) => BigInt((body as AgoraRequestResult<'sendMessage'>).sequence))
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)

      expect(allocatedSequences).toEqual(Array.from(
        { length: 12 },
        (_, index) => BigInt(index + 1)
      ))

      const simultaneousRetries = await Promise.all(Array.from({ length: 8 }, () => (
        postHuman(owner, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: 'simultaneous-retry',
          groupId: group.id,
          text: 'One durable outcome'
        })
      )))
      const retryBodies = simultaneousRetries.map(({ body }) => body)

      expect(simultaneousRetries.every(({ status }) => status === 200)).toBe(true)
      expect(retryBodies).toEqual(Array.from({ length: 8 }, () => retryBodies[0]))
      expect((retryBodies[0] as AgoraRequestResult<'sendMessage'>).sequence).toBe('13')

      const [ownerScoped, memberScoped, groupScoped] = await Promise.all([
        postHuman(owner, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: 'same-key-new-scope',
          groupId: group.id,
          text: 'Owner-scoped message'
        }),
        postHuman(member, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: 'same-key-new-scope',
          groupId: group.id,
          text: 'Member-scoped message'
        }),
        postHuman(owner, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: 'same-key-new-scope',
          groupId: secondGroup.id,
          text: 'Group-scoped message'
        })
      ])
      const scopedMessages = [ownerScoped, memberScoped, groupScoped].map(({ body }) => (
        body as AgoraRequestResult<'sendMessage'>
      ))

      expect([ownerScoped.status, memberScoped.status, groupScoped.status]).toEqual([200, 200, 200])
      expect(new Set(scopedMessages.map(({ id }) => id)).size).toBe(3)
      expect(new Set(scopedMessages.slice(0, 2).map(({ sender }) => sender.id))).toEqual(
        new Set([owner.principalId, member.principalId])
      )
      expect(scopedMessages[2].sequence).toBe('1')

      const stored = await admin
        .from('messages')
        .select('id, sequence')
        .eq('group_id', group.id)
        .order('sequence')

      expect(stored.error).toBeNull()
      expect(stored.data?.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: 15 }, (_, index) => index + 1)
      )
      expect(new Set(stored.data?.map(({ id }) => id)).size).toBe(15)
      await expect(Promise.all([
        selectCount('messages', 'group_id', group.id),
        selectCount('message_idempotency_keys', 'group_id', group.id, 'message_id')
      ])).resolves.toEqual([15, 15])
    } finally {
      const { error } = await admin.from('groups').delete().in('id', [group.id, secondGroup.id])

      if (error) {
        throw error
      }
    }
  })
})
