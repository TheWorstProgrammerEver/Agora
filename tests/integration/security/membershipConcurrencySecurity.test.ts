import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgoraRequestResult } from '../../../common/agoraRequestContract'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'
import {
  cleanupGroupLifecycleFixtures,
  createGroup,
  createGroupLifecycleFixtures,
  postHuman,
  selectCount,
  type GroupLifecycleFixtures
} from './groupLifecycleTestSupport'

let fixtures: GroupLifecycleFixtures | undefined

const requireFixtures = () => {
  if (!fixtures) {
    throw new Error('Membership concurrency fixtures were not created.')
  }

  return fixtures
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('membership transition concurrency', () => {
  it('coalesces concurrent duplicate invites and agent additions', async () => {
    const { agent, member, owner } = requireFixtures()
    const group = await createGroup(owner, 'Concurrent idempotency group')

    try {
      const invitations = await Promise.all([
        postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
          email: member.email,
          groupId: group.id
        }),
        postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
          email: ` ${member.email.toUpperCase()} `,
          groupId: group.id
        })
      ])
      const invitationIds = invitations.map((result) => (
        result.body as AgoraRequestResult<'inviteHuman'>
      ).invitation.id)

      expect(invitations.map(({ status }) => status)).toEqual([200, 200])
      expect(new Set(invitationIds).size).toBe(1)
      expect(await selectCount('invitations', 'group_id', group.id)).toBe(1)

      const additions = await Promise.all([
        postHuman(owner, agoraRequestIdentifiers.addAgentMember, {
          agentPrincipalId: agent.principalId,
          groupId: group.id
        }),
        postHuman(owner, agoraRequestIdentifiers.addAgentMember, {
          agentPrincipalId: agent.principalId,
          groupId: group.id
        })
      ])

      expect(additions.map(({ status }) => status)).toEqual([200, 200])
      expect(additions[0].body).toEqual(additions[1].body)
      expect(await selectCount('memberships', 'principal_id', agent.principalId)).toBe(1)
    } finally {
      await postHuman(owner, agoraRequestIdentifiers.deleteGroup, { groupId: group.id })
    }
  })

  it('serializes concurrent accept and reject into one terminal state', async () => {
    const { member: invitee, owner } = requireFixtures()
    const group = await createGroup(owner, 'Concurrent resolution group')

    try {
      const invited = await postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
        email: invitee.email,
        groupId: group.id
      })
      const invitationId = (invited.body as AgoraRequestResult<'inviteHuman'>).invitation.id
      const outcomes = await Promise.all([
        postHuman(invitee, agoraRequestIdentifiers.acceptInvitation, { invitationId }),
        postHuman(invitee, agoraRequestIdentifiers.rejectInvitation, { invitationId })
      ])
      const statuses = outcomes.map(({ status }) => status).sort()
      const membershipCount = await selectCount('memberships', 'principal_id', invitee.principalId)

      expect(statuses).toEqual([200, 404])
      expect(await selectCount('invitations', 'id', invitationId)).toBe(0)
      expect([0, 1]).toContain(membershipCount)
      expect(membershipCount).toBe(outcomes[0].status === 200 ? 1 : 0)
    } finally {
      await postHuman(owner, agoraRequestIdentifiers.deleteGroup, { groupId: group.id })
    }
  })
})
