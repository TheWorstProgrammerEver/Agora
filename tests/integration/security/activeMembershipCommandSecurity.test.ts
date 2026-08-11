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
    throw new Error('Active membership command fixtures were not created.')
  }

  return fixtures
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('active membership command and RLS boundary', () => {
  it('adds only provisioned agents and immediately revokes removed principals', async () => {
    const { agent, member, outsider, owner } = requireFixtures()
    const group = await createGroup(owner, 'Active membership group')

    try {
      const invitation = await postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
        email: member.email,
        groupId: group.id
      })
      await postHuman(member, agoraRequestIdentifiers.acceptInvitation, {
        invitationId: (invitation.body as AgoraRequestResult<'inviteHuman'>).invitation.id
      })

      const firstAdd = await postHuman(owner, agoraRequestIdentifiers.addAgentMember, {
        agentPrincipalId: agent.principalId,
        groupId: group.id
      })
      const repeatedAdd = await postHuman(owner, agoraRequestIdentifiers.addAgentMember, {
        agentPrincipalId: agent.principalId,
        groupId: group.id
      })
      const humanAsAgent = await postHuman(owner, agoraRequestIdentifiers.addAgentMember, {
        agentPrincipalId: member.principalId,
        groupId: group.id
      })

      expect(firstAdd).toMatchObject({
        body: { member: { principal: { id: agent.principalId, kind: 'agent' } } },
        status: 200
      })
      expect(repeatedAdd).toEqual(firstAdd)
      expect(humanAsAgent.status).toBe(404)
      expect(await selectCount('memberships', 'principal_id', agent.principalId)).toBe(1)

      const [ownerMembers, memberMembers, agentMembers, outsiderMembers] = await Promise.all([
        postHuman(owner, agoraRequestIdentifiers.listGroupMembers, { groupId: group.id }),
        postHuman(member, agoraRequestIdentifiers.listGroupMembers, { groupId: group.id }),
        postAgent(agent, agoraRequestIdentifiers.listGroupMembers, { groupId: group.id }),
        postHuman(outsider, agoraRequestIdentifiers.listGroupMembers, { groupId: group.id })
      ])

      for (const result of [ownerMembers, memberMembers, agentMembers]) {
        expect(result).toMatchObject({ body: { items: expect.any(Array) }, status: 200 })
        expect((result.body as AgoraRequestResult<'listGroupMembers'>).items).toHaveLength(3)
      }
      expect(outsiderMembers.status).toBe(404)

      const [memberRemoval, repeatedRemoval, agentRemoval] = await Promise.all([
        postHuman(owner, agoraRequestIdentifiers.removeMember, {
          groupId: group.id,
          principalId: member.principalId
        }),
        postHuman(owner, agoraRequestIdentifiers.removeMember, {
          groupId: group.id,
          principalId: outsider.principalId
        }),
        postHuman(owner, agoraRequestIdentifiers.removeMember, {
          groupId: group.id,
          principalId: agent.principalId
        })
      ])

      expect(memberRemoval.status).toBe(200)
      expect(repeatedRemoval.status).toBe(200)
      expect(agentRemoval.status).toBe(200)

      const idempotentMemberRemoval = await postHuman(
        owner,
        agoraRequestIdentifiers.removeMember,
        { groupId: group.id, principalId: member.principalId }
      )
      const [removedHumanGet, removedAgentGet, removedAgentMembers] = await Promise.all([
        postHuman(member, agoraRequestIdentifiers.getGroup, { groupId: group.id }),
        postAgent(agent, agoraRequestIdentifiers.getGroup, { groupId: group.id }),
        postAgent(agent, agoraRequestIdentifiers.listGroupMembers, { groupId: group.id })
      ])

      expect(idempotentMemberRemoval.status).toBe(200)
      expect(removedHumanGet.status).toBe(404)
      expect(removedAgentGet.status).toBe(404)
      expect(removedAgentMembers.status).toBe(404)

      const [humanGroups, humanMemberships, agentGroups, agentMemberships] = await Promise.all([
        member.client.from('groups').select('id').eq('id', group.id),
        member.client.from('memberships').select('id').eq('group_id', group.id),
        agent.client.from('groups').select('id').eq('id', group.id),
        agent.client.from('memberships').select('id').eq('group_id', group.id)
      ])

      expect(humanGroups.data).toEqual([])
      expect(humanMemberships.data).toEqual([])
      expect(agentGroups.data).toEqual([])
      expect(agentMemberships.data).toEqual([])
    } finally {
      await postHuman(owner, agoraRequestIdentifiers.deleteGroup, { groupId: group.id })
    }
  })

  it('permits only the human owner to manage membership and preserves the owner', async () => {
    const { agent, member, outsider, owner } = requireFixtures()
    const group = await createGroup(owner, 'Membership authorization group')

    try {
      const [memberAdd, outsiderRemove, agentAdd, agentRemove, ownerRemoval] = await Promise.all([
        postHuman(member, agoraRequestIdentifiers.addAgentMember, {
          agentPrincipalId: agent.principalId,
          groupId: group.id
        }),
        postHuman(outsider, agoraRequestIdentifiers.removeMember, {
          groupId: group.id,
          principalId: member.principalId
        }),
        postAgent(agent, agoraRequestIdentifiers.addAgentMember, {
          agentPrincipalId: agent.principalId,
          groupId: group.id
        }),
        postAgent(agent, agoraRequestIdentifiers.removeMember, {
          groupId: group.id,
          principalId: member.principalId
        }),
        postHuman(owner, agoraRequestIdentifiers.removeMember, {
          groupId: group.id,
          principalId: owner.principalId
        })
      ])

      expect(memberAdd.status).toBe(403)
      expect(outsiderRemove.status).toBe(403)
      expect(agentAdd.status).toBe(403)
      expect(agentRemove.status).toBe(403)
      expect(ownerRemoval.status).toBe(409)

      const directHumanMutation = await owner.client.from('memberships').delete().eq(
        'group_id',
        group.id
      )
      const directAgentManagement = await agent.client.rpc('add_agora_agent_member', {
        agent_principal_id_to_add: agent.principalId,
        group_id_to_update: group.id
      })
      const ownerRows = await admin
        .from('memberships')
        .select('principal_id, role')
        .eq('group_id', group.id)

      expect(directHumanMutation.error).not.toBeNull()
      expect(directAgentManagement.error).not.toBeNull()
      expect(ownerRows.data).toEqual([{ principal_id: owner.principalId, role: 'owner' }])
    } finally {
      await postHuman(owner, agoraRequestIdentifiers.deleteGroup, { groupId: group.id })
    }
  })
})
