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
  type GroupLifecycleFixtures
} from './groupLifecycleTestSupport'

let fixtures: GroupLifecycleFixtures | undefined

const requireFixtures = () => {
  if (!fixtures) {
    throw new Error('Message pagination concurrency fixtures were not created.')
  }

  return fixtures
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('message pagination concurrency', () => {
  it('catches up without duplicates when a message is appended during forward paging', async () => {
    const { member, owner } = requireFixtures()
    const group = await createGroup(owner, 'Concurrent pagination group')

    try {
      await insertMembership(group.id, member.principalId)

      for (const sequence of [1, 2]) {
        const sent = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: `pagination-seed-${sequence}`,
          groupId: group.id,
          text: `Pagination seed ${sequence}`
        })

        expect(sent.status).toBe(200)
      }

      const firstPage = await postHuman(member, agoraRequestIdentifiers.getGroupMessages, {
        afterSequence: '0',
        groupId: group.id,
        limit: 1
      })
      const [concurrentSend, secondPage] = await Promise.all([
        postHuman(owner, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: 'pagination-concurrent-3',
          groupId: group.id,
          text: 'Concurrent append'
        }),
        postHuman(member, agoraRequestIdentifiers.getGroupMessages, {
          afterSequence: '1',
          groupId: group.id,
          limit: 1
        })
      ])
      const catchUp = await postHuman(member, agoraRequestIdentifiers.getGroupMessages, {
        afterSequence: '2',
        groupId: group.id,
        limit: 1
      })
      const pages = [firstPage, secondPage, catchUp].map(({ body }) => (
        body as AgoraRequestResult<'getGroupMessages'>
      ))

      expect(concurrentSend).toMatchObject({ body: { sequence: '3' }, status: 200 })
      expect([firstPage.status, secondPage.status, catchUp.status]).toEqual([200, 200, 200])
      expect(pages.flatMap(({ items }) => items.map(({ sequence }) => sequence)))
        .toEqual(['1', '2', '3'])
    } finally {
      const { error } = await admin.from('groups').delete().eq('id', group.id)

      if (error) {
        throw error
      }
    }
  })
})
