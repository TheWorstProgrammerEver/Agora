import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgoraRequestResult } from '../../../common/agoraRequestContract'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'
import {
  cleanupGroupLifecycleFixtures,
  createGroup,
  createGroupLifecycleFixtures,
  groupLifecycleAdmin as admin,
  postAgent,
  postHuman,
  selectCount,
  type GroupLifecycleFixtures
} from './groupLifecycleTestSupport'

let fixtures: GroupLifecycleFixtures | undefined

const requireFixtures = () => {
  if (!fixtures) {
    throw new Error('Invitation command fixtures were not created.')
  }

  return fixtures
}

const mailpitMessageCount = async () => {
  const response = await fetch('http://127.0.0.1:54324/api/v1/messages')
  const body = await response.json() as { total?: unknown }

  if (!response.ok || typeof body.total !== 'number') {
    throw new Error('Local Mailpit did not return a message count.')
  }

  return body.total
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('human invitation command and RLS boundary', () => {
  it('normalizes and idempotently exposes an in-app invitation before acceptance', async () => {
    const { member: invitee, outsider, owner } = requireFixtures()
    const group = await createGroup(owner, 'Invitation acceptance group')

    try {
      const emailCountBefore = await mailpitMessageCount()
      const directInvitation = await owner.client.rpc('invite_agora_human', {
        email_to_invite: invitee.email,
        group_id_to_invite: group.id
      })

      expect(directInvitation.error).toBeNull()
      const first = await postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
        email: ` ${invitee.email.toUpperCase()} `,
        groupId: group.id
      })
      const second = await postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
        email: invitee.email,
        groupId: group.id
      })
      const firstInvitation = (first.body as AgoraRequestResult<'inviteHuman'>).invitation
      const secondInvitation = (second.body as AgoraRequestResult<'inviteHuman'>).invitation

      expect(first).toMatchObject({
        body: { invitation: { email: invitee.email, group: { id: group.id } } },
        status: 200
      })
      expect(second.status).toBe(200)
      expect(secondInvitation).toEqual(firstInvitation)
      expect(await mailpitMessageCount()).toBe(emailCountBefore)
      expect(await selectCount('invitations', 'group_id', group.id)).toBe(1)

      const [pending, outsiderPending, pendingGet, pendingMembers, pendingGroups] = await Promise.all([
        postHuman(invitee, agoraRequestIdentifiers.listPendingInvitations, {}),
        postHuman(outsider, agoraRequestIdentifiers.listPendingInvitations, {}),
        postHuman(invitee, agoraRequestIdentifiers.getGroup, { groupId: group.id }),
        postHuman(invitee, agoraRequestIdentifiers.listGroupMembers, { groupId: group.id }),
        postHuman(invitee, agoraRequestIdentifiers.listGroups, {})
      ])

      expect(pending).toMatchObject({
        body: { items: [{ id: firstInvitation.id, group: { id: group.id } }] },
        status: 200
      })
      expect(outsiderPending).toEqual({ body: { items: [] }, status: 200 })
      expect(pendingGet.status).toBe(404)
      expect(pendingMembers.status).toBe(404)
      expect(pendingGroups).toEqual({ body: { items: [] }, status: 200 })

      const [directInvitations, directGroups, directMembers] = await Promise.all([
        invitee.client.from('invitations').select('id, group_id'),
        invitee.client.from('groups').select('id'),
        invitee.client.from('memberships').select('id')
      ])

      expect(directInvitations.data).toEqual([{ id: firstInvitation.id, group_id: group.id }])
      expect(directGroups.data).toEqual([])
      expect(directMembers.data).toEqual([])

      const wrongPrincipal = await postHuman(
        outsider,
        agoraRequestIdentifiers.acceptInvitation,
        { invitationId: firstInvitation.id }
      )
      const acceptance = await postHuman(
        invitee,
        agoraRequestIdentifiers.acceptInvitation,
        { invitationId: firstInvitation.id }
      )
      const repeatedAcceptance = await postHuman(
        invitee,
        agoraRequestIdentifiers.acceptInvitation,
        { invitationId: firstInvitation.id }
      )

      expect(wrongPrincipal.status).toBe(404)
      expect(acceptance).toMatchObject({
        body: {
          groupId: group.id,
          invitationId: firstInvitation.id,
          member: { principal: { id: invitee.principalId }, role: 'member' }
        },
        status: 200
      })
      expect(repeatedAcceptance.status).toBe(404)
      expect(await selectCount('invitations', 'group_id', group.id)).toBe(0)
      expect(await selectCount('memberships', 'principal_id', invitee.principalId)).toBe(1)

      const [activeGet, activeInvite, selfInvite] = await Promise.all([
        postHuman(invitee, agoraRequestIdentifiers.getGroup, { groupId: group.id }),
        postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
          email: invitee.email,
          groupId: group.id
        }),
        postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
          email: owner.email,
          groupId: group.id
        })
      ])

      expect(activeGet.status).toBe(200)
      expect(activeInvite.status).toBe(409)
      expect(selfInvite.status).toBe(400)
    } finally {
      await postHuman(owner, agoraRequestIdentifiers.deleteGroup, { groupId: group.id })
    }
  })

  it('consumes rejection and denies owner actions to non-owners and agents', async () => {
    const { agent, member, outsider, owner } = requireFixtures()
    const group = await createGroup(owner, 'Invitation rejection group')

    try {
      const invitationResult = await postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
        email: outsider.email,
        groupId: group.id
      })
      const invitation = (invitationResult.body as AgoraRequestResult<'inviteHuman'>).invitation
      const [memberInvite, agentInvite, agentAccept, directAgentInvite] = await Promise.all([
        postHuman(member, agoraRequestIdentifiers.inviteHuman, {
          email: outsider.email,
          groupId: group.id
        }),
        postAgent(agent, agoraRequestIdentifiers.inviteHuman, {
          email: outsider.email,
          groupId: group.id
        }),
        postAgent(agent, agoraRequestIdentifiers.acceptInvitation, {
          invitationId: invitation.id
        }),
        agent.client.rpc('invite_agora_human', {
          email_to_invite: outsider.email,
          group_id_to_invite: group.id
        })
      ])

      expect(memberInvite.status).toBe(403)
      expect(agentInvite.status).toBe(403)
      expect(agentAccept.status).toBe(403)
      expect(directAgentInvite.error).not.toBeNull()

      const rejection = await postHuman(
        outsider,
        agoraRequestIdentifiers.rejectInvitation,
        { invitationId: invitation.id }
      )
      const repeatedRejection = await postHuman(
        outsider,
        agoraRequestIdentifiers.rejectInvitation,
        { invitationId: invitation.id }
      )

      expect(rejection).toEqual({
        body: { groupId: group.id, invitationId: invitation.id },
        status: 200
      })
      expect(repeatedRejection.status).toBe(404)
      expect(await selectCount('invitations', 'id', invitation.id)).toBe(0)
      expect(await selectCount('memberships', 'principal_id', outsider.principalId)).toBe(0)
    } finally {
      await postHuman(owner, agoraRequestIdentifiers.deleteGroup, { groupId: group.id })
    }
  })
})
