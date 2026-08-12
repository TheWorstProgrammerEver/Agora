import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgoraRequestResult } from '../../../common/agoraRequestContract'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'
import {
  cleanupGroupLifecycleFixtures,
  createGroup,
  createGroupLifecycleFixtures,
  groupLifecycleAdmin as admin,
  insertMembership,
  postAgent,
  postHuman,
  selectCount,
  type GroupLifecycleFixtures
} from './groupLifecycleTestSupport'

let fixtures: GroupLifecycleFixtures | undefined

const requireFixtures = () => {
  if (!fixtures) {
    throw new Error('Message read fixtures were not created.')
  }

  return fixtures
}

const sendMessages = async (
  owner: GroupLifecycleFixtures['owner'],
  groupId: string,
  sequences: number[]
) => {
  for (const sequence of sequences) {
    const result = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
      clientMessageId: `read-message-${sequence}`,
      groupId,
      text: `Read message ${sequence}`
    })

    expect(result.status).toBe(200)
    expect((result.body as AgoraRequestResult<'sendMessage'>).sequence).toBe(String(sequence))
  }
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('message context and read watermarks', () => {
  it('provides stable latest, forward, backward, and centered sequence windows', async () => {
    const { member, outsider, owner } = requireFixtures()
    const group = await createGroup(owner, 'Message context group')

    try {
      await insertMembership(group.id, member.principalId)
      await sendMessages(owner, group.id, [1, 2, 3, 4, 5])

      const latest = await postHuman(member, agoraRequestIdentifiers.getGroupMessages, {
        groupId: group.id,
        limit: 2
      })
      const older = await postHuman(member, agoraRequestIdentifiers.getGroupMessages, {
        beforeSequence: '4',
        groupId: group.id,
        limit: 2
      })
      const forward = await postHuman(member, agoraRequestIdentifiers.getGroupMessages, {
        afterSequence: '1',
        groupId: group.id,
        limit: 2
      })
      const around = await postHuman(member, agoraRequestIdentifiers.getGroupMessages, {
        aroundSequence: '3',
        groupId: group.id,
        limit: 1
      })

      expect(latest).toMatchObject({
        body: { items: [{ sequence: '4' }, { sequence: '5' }], nextCursor: '4' },
        status: 200
      })
      expect(older).toMatchObject({
        body: { items: [{ sequence: '2' }, { sequence: '3' }], nextCursor: '2' },
        status: 200
      })
      expect(forward).toMatchObject({
        body: { items: [{ sequence: '2' }, { sequence: '3' }], nextCursor: '3' },
        status: 200
      })
      expect(around).toMatchObject({
        body: { items: [{ sequence: '2' }, { sequence: '3' }, { sequence: '4' }] },
        status: 200
      })
      expect(around.body).not.toHaveProperty('nextCursor')

      const [outsiderRead, futureWindow, wrongContext] = await Promise.all([
        postHuman(outsider, agoraRequestIdentifiers.getGroupMessages, {
          groupId: group.id
        }),
        postHuman(member, agoraRequestIdentifiers.getGroupMessages, {
          afterSequence: '6',
          groupId: group.id
        }),
        postHuman(member, agoraRequestIdentifiers.getGroupMessages, {
          aroundSequence: '6',
          groupId: group.id
        })
      ])

      expect(outsiderRead.status).toBe(403)
      expect(futureWindow.status).toBe(400)
      expect(wrongContext.status).toBe(400)
    } finally {
      const { error } = await admin.from('groups').delete().eq('id', group.id)

      if (error) {
        throw error
      }
    }
  })

  it('keeps unread results exact across pagination, reconnect catch-up, and idempotent marks', async () => {
    const { agent, member, owner } = requireFixtures()
    const group = await createGroup(owner, 'Unread watermark group')

    try {
      await Promise.all([
        insertMembership(group.id, member.principalId),
        insertMembership(group.id, agent.principalId)
      ])
      await sendMessages(owner, group.id, [1, 2, 3, 4])

      const [ownerUnread, memberUnread, agentUnread, groupList] = await Promise.all([
        postHuman(owner, agoraRequestIdentifiers.getUnreadMessages, { groupId: group.id }),
        postHuman(member, agoraRequestIdentifiers.getUnreadMessages, {
          groupId: group.id,
          limit: 2
        }),
        postAgent(agent, agoraRequestIdentifiers.getUnreadMessages, { groupId: group.id }),
        postHuman(member, agoraRequestIdentifiers.listGroups, {})
      ])

      expect(ownerUnread).toEqual({ body: { items: [] }, status: 200 })
      expect(memberUnread).toMatchObject({
        body: { items: [{ sequence: '1' }, { sequence: '2' }], nextCursor: '2' },
        status: 200
      })
      expect(agentUnread).toMatchObject({
        body: { items: [
          { sequence: '1' },
          { sequence: '2' },
          { sequence: '3' },
          { sequence: '4' }
        ] },
        status: 200
      })
      expect(groupList).toMatchObject({
        body: { items: [expect.objectContaining({ id: group.id, unreadCount: 4 })] },
        status: 200
      })

      await sendMessages(owner, group.id, [5])
      const catchUp = await postHuman(member, agoraRequestIdentifiers.getUnreadMessages, {
        afterSequence: '2',
        groupId: group.id,
        limit: 10
      })

      expect(catchUp).toMatchObject({
        body: { items: [{ sequence: '3' }, { sequence: '4' }, { sequence: '5' }] },
        status: 200
      })

      const advanced = await postHuman(member, agoraRequestIdentifiers.markGroupRead, {
        groupId: group.id,
        throughSequence: '4'
      })
      const repeated = await postHuman(member, agoraRequestIdentifiers.markGroupRead, {
        groupId: group.id,
        throughSequence: '2'
      })
      const [remainingUnread, updatedGroups, agentMark] = await Promise.all([
        postHuman(member, agoraRequestIdentifiers.getUnreadMessages, {
          afterSequence: '2',
          groupId: group.id
        }),
        postHuman(member, agoraRequestIdentifiers.listGroups, {}),
        postAgent(agent, agoraRequestIdentifiers.markGroupRead, {
          groupId: group.id,
          throughSequence: '5'
        })
      ])

      expect(advanced).toEqual({ body: { groupId: group.id, sequence: '4' }, status: 200 })
      expect(repeated).toEqual({ body: { groupId: group.id, sequence: '4' }, status: 200 })
      expect(remainingUnread).toMatchObject({
        body: { items: [{ sequence: '5' }] },
        status: 200
      })
      expect(updatedGroups).toMatchObject({
        body: { items: [expect.objectContaining({ id: group.id, unreadCount: 1 })] },
        status: 200
      })
      expect(agentMark).toEqual({ body: { groupId: group.id, sequence: '5' }, status: 200 })

      const memberSend = await postHuman(member, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'member-sender-advance',
        groupId: group.id,
        text: 'Sender catches up through this message'
      })
      const memberAfterSend = await postHuman(
        member,
        agoraRequestIdentifiers.getUnreadMessages,
        { groupId: group.id }
      )

      expect(memberSend).toMatchObject({ body: { sequence: '6' }, status: 200 })
      expect(memberAfterSend).toEqual({ body: { items: [] }, status: 200 })
    } finally {
      const { error } = await admin.from('groups').delete().eq('id', group.id)

      if (error) {
        throw error
      }
    }
  })

  it('cascades membership and group watermarks and denies stale read state', async () => {
    const { member, outsider, owner } = requireFixtures()
    const group = await createGroup(owner, 'Watermark cascade group')
    let groupDeleted = false

    try {
      await insertMembership(group.id, member.principalId)
      await sendMessages(owner, group.id, [1, 2])
      const mark = await postHuman(member, agoraRequestIdentifiers.markGroupRead, {
        groupId: group.id,
        throughSequence: '1'
      })
      const memberships = await admin
        .from('memberships')
        .select('id, principal_id')
        .eq('group_id', group.id)
      const memberMembershipId = memberships.data?.find(
        ({ principal_id }) => principal_id === member.principalId
      )?.id
      const ownerMembershipId = memberships.data?.find(
        ({ principal_id }) => principal_id === owner.principalId
      )?.id

      expect(mark.status).toBe(200)
      expect(memberships.error).toBeNull()
      expect(memberMembershipId).toBeTypeOf('string')
      expect(ownerMembershipId).toBeTypeOf('string')

      const [memberRows, ownerRows, outsiderRows] = await Promise.all([
        member.client.from('membership_read_watermarks').select('membership_id, sequence'),
        owner.client.from('membership_read_watermarks').select('membership_id, sequence'),
        outsider.client.from('membership_read_watermarks').select('membership_id, sequence')
      ])

      expect(memberRows.error).toBeNull()
      expect(memberRows.data).toEqual([{ membership_id: memberMembershipId, sequence: 1 }])
      expect(ownerRows.data).toEqual([{ membership_id: ownerMembershipId, sequence: 2 }])
      expect(outsiderRows.data).toEqual([])

      const removal = await postHuman(owner, agoraRequestIdentifiers.removeMember, {
        groupId: group.id,
        principalId: member.principalId
      })
      const [removedRead, removedMark] = await Promise.all([
        postHuman(member, agoraRequestIdentifiers.getUnreadMessages, { groupId: group.id }),
        postHuman(member, agoraRequestIdentifiers.markGroupRead, {
          groupId: group.id,
          throughSequence: '2'
        })
      ])

      expect(removal.status).toBe(200)
      expect(removedRead.status).toBe(403)
      expect(removedMark.status).toBe(403)
      await expect(selectCount(
        'membership_read_watermarks',
        'membership_id',
        memberMembershipId!,
        'membership_id'
      )).resolves.toBe(0)

      const deletion = await postHuman(owner, agoraRequestIdentifiers.deleteGroup, {
        groupId: group.id
      })

      expect(deletion).toEqual({ body: { groupId: group.id }, status: 200 })
      groupDeleted = true
      await expect(selectCount(
        'membership_read_watermarks',
        'membership_id',
        ownerMembershipId!,
        'membership_id'
      )).resolves.toBe(0)
    } finally {
      if (!groupDeleted) {
        const { error } = await admin.from('groups').delete().eq('id', group.id)

        if (error) {
          throw error
        }
      }
    }
  })
})
