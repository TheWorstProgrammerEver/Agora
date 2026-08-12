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

let fixtures: GroupLifecycleFixtures | undefined

const requireFixtures = () => {
  if (!fixtures) {
    throw new Error('Message watermark concurrency fixtures were not created.')
  }

  return fixtures
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('message watermark concurrency', () => {
  it('never regresses when acknowledgements arrive concurrently or out of order', async () => {
    const { member, owner } = requireFixtures()
    const group = await createGroup(owner, 'Concurrent watermark group')

    try {
      await insertMembership(group.id, member.principalId)

      for (const sequence of [1, 2, 3, 4, 5]) {
        const sent = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: `watermark-seed-${sequence}`,
          groupId: group.id,
          text: `Watermark seed ${sequence}`
        })

        expect(sent.status).toBe(200)
      }

      const marks = await Promise.all([1, 5, 3, 2, 4].map((sequence) => (
        postHuman(member, agoraRequestIdentifiers.markGroupRead, {
          groupId: group.id,
          throughSequence: String(sequence)
        })
      )))
      const finalMark = await postHuman(member, agoraRequestIdentifiers.markGroupRead, {
        groupId: group.id,
        throughSequence: '1'
      })
      const unread = await postHuman(member, agoraRequestIdentifiers.getUnreadMessages, {
        groupId: group.id
      })

      expect(marks.every(({ status }) => status === 200)).toBe(true)
      expect(finalMark).toEqual({ body: { groupId: group.id, sequence: '5' }, status: 200 })
      expect(unread).toEqual({ body: { items: [] }, status: 200 })
    } finally {
      const { error } = await admin.from('groups').delete().eq('id', group.id)

      if (error) {
        throw error
      }
    }
  })
})
