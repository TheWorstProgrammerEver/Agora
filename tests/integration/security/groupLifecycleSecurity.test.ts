import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
    throw new Error('Group lifecycle fixtures were not created.')
  }

  return fixtures
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('group lifecycle dispatcher and RLS boundary', () => {
  it('derives one human owner and rejects agent ownership through dispatcher and direct RPC', async () => {
    const { agent, owner } = requireFixtures()
    const group = await createGroup(owner, '  Human-owned group  ')

    try {
      const memberships = await admin
        .from('memberships')
        .select('principal_id, role')
        .eq('group_id', group.id)

      expect(memberships.error).toBeNull()
      expect(memberships.data).toEqual([{
        principal_id: owner.principalId,
        role: 'owner'
      }])

      const dispatcherDenial = await postAgent(
        agent,
        agoraRequestIdentifiers.createGroup,
        { name: 'Agent-owned group' }
      )
      const rpcDenial = await agent.client.rpc('create_agora_group', {
        name_to_use: 'Agent-owned group'
      })

      expect(dispatcherDenial).toEqual({
        body: { error: 'This group operation is not permitted.' },
        status: 403
      })
      expect(rpcDenial.error?.code).toBe('42501')
      expect(await selectCount('groups', 'owner_principal_id', agent.principalId)).toBe(0)
    } finally {
      await postHuman(owner, agoraRequestIdentifiers.deleteGroup, { groupId: group.id })
    }
  })

  it('returns group and explicit membership state only to active human and agent members', async () => {
    const { agent, member, outsider, owner } = requireFixtures()
    const group = await createGroup(owner, 'DM owner and member')

    try {
      await insertMembership(group.id, member.principalId)

      const [ownerGet, memberGet, outsiderGet] = await Promise.all([
        postHuman(owner, agoraRequestIdentifiers.getGroup, { groupId: group.id }),
        postHuman(member, agoraRequestIdentifiers.getGroup, { groupId: group.id }),
        postHuman(outsider, agoraRequestIdentifiers.getGroup, { groupId: group.id })
      ])

      expect(ownerGet).toMatchObject({
        body: { currentMember: { role: 'owner' }, group: { id: group.id } },
        status: 200
      })
      expect(memberGet).toMatchObject({
        body: { currentMember: { principal: { kind: 'human' }, role: 'member' } },
        status: 200
      })
      expect(outsiderGet.status).toBe(404)

      await insertMembership(group.id, agent.principalId)
      const agentGet = await postAgent(agent, agoraRequestIdentifiers.getGroup, {
        groupId: group.id
      })

      expect(agentGet).toMatchObject({
        body: { currentMember: { principal: { kind: 'agent' }, role: 'member' } },
        status: 200
      })

      const [ownerList, memberList, agentList, outsiderList] = await Promise.all([
        postHuman(owner, agoraRequestIdentifiers.listGroups, {}),
        postHuman(member, agoraRequestIdentifiers.listGroups, {}),
        postAgent(agent, agoraRequestIdentifiers.listGroups, {}),
        postHuman(outsider, agoraRequestIdentifiers.listGroups, {})
      ])

      for (const result of [ownerList, memberList, agentList]) {
        expect(result).toMatchObject({
          body: { items: [expect.objectContaining({ id: group.id, unreadCount: 0 })] },
          status: 200
        })
      }
      expect(outsiderList).toEqual({ body: { items: [] }, status: 200 })

      const directAgentGroups = await agent.client.from('groups').select('id')
      const directAgentMutation = await agent.client
        .from('groups')
        .update({ name: 'Agent rename' })
        .eq('id', group.id)

      expect(directAgentGroups.error).toBeNull()
      expect(directAgentGroups.data).toEqual([{ id: group.id }])
      expect(directAgentMutation.error).not.toBeNull()
    } finally {
      await postHuman(owner, agoraRequestIdentifiers.deleteGroup, { groupId: group.id })
    }
  })

  it('permits only the owner to hard-delete and cascades core access rows', async () => {
    const { agent, member, outsider, owner } = requireFixtures()
    const group = await createGroup(owner, 'Cascade lifecycle group')
    const invitationId = randomUUID()

    await insertMembership(group.id, member.principalId)
    await insertMembership(group.id, agent.principalId)
    const invitation = await admin.from('invitations').insert({
      email: outsider.email,
      group_id: group.id,
      id: invitationId,
      invited_by_principal_id: owner.principalId
    })

    expect(invitation.error).toBeNull()

    const [memberDenial, outsiderDenial, agentDenial, directAgentDenial] = await Promise.all([
      postHuman(member, agoraRequestIdentifiers.deleteGroup, { groupId: group.id }),
      postHuman(outsider, agoraRequestIdentifiers.deleteGroup, { groupId: group.id }),
      postAgent(agent, agoraRequestIdentifiers.deleteGroup, { groupId: group.id }),
      agent.client.rpc('delete_agora_group', { group_id_to_delete: group.id })
    ])

    expect(memberDenial.status).toBe(403)
    expect(outsiderDenial.status).toBe(403)
    expect(agentDenial.status).toBe(403)
    expect(directAgentDenial.error?.code).toBe('42501')
    expect(await selectCount('groups', 'id', group.id)).toBe(1)

    const deletion = await postHuman(owner, agoraRequestIdentifiers.deleteGroup, {
      groupId: group.id
    })

    expect(deletion).toEqual({ body: { groupId: group.id }, status: 200 })
    await expect(Promise.all([
      selectCount('groups', 'id', group.id),
      selectCount('memberships', 'group_id', group.id),
      selectCount('invitations', 'group_id', group.id)
    ])).resolves.toEqual([0, 0, 0])

    const [memberGet, agentGet, outsiderInvitations] = await Promise.all([
      postHuman(member, agoraRequestIdentifiers.getGroup, { groupId: group.id }),
      postAgent(agent, agoraRequestIdentifiers.getGroup, { groupId: group.id }),
      outsider.client.from('invitations').select('id').eq('id', invitationId)
    ])

    expect(memberGet.status).toBe(404)
    expect(agentGet.status).toBe(404)
    expect(outsiderInvitations.error).toBeNull()
    expect(outsiderInvitations.data).toEqual([])
  })
})
