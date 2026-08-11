import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupGroupSecurityFixture,
  createGroupSecurityFixture,
  type GroupSecurityFixture
} from './groupFixture'
import { createAdminClient, createAnonymousClient } from './localSupabase'

type IdRow = { id: string }

const admin = createAdminClient()
let fixture: GroupSecurityFixture | undefined

const requireFixture = () => {
  if (!fixture) {
    throw new Error('Group security fixture was not created.')
  }

  return fixture
}

const selectIds = async (client: SupabaseClient, table: string) => {
  const { data, error } = await client.from(table).select('id')

  if (error) {
    throw error
  }

  return ((data ?? []) as IdRow[]).map((row) => row.id)
}

const expectRowsMissing = async (table: string, column: string, value: string) => {
  const { count, error } = await admin
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(column, value)

  if (error) {
    throw error
  }

  expect(count).toBe(0)
}

beforeAll(async () => {
  fixture = await createGroupSecurityFixture()
})

afterAll(async () => {
  await cleanupGroupSecurityFixture(fixture)
})

describe('group-domain security', () => {
  it('creates and protects exactly one human owner membership', async () => {
    const source = requireFixture()
    const ownerMemberships = await admin
      .from('memberships')
      .select('id, principal_id, role')
      .eq('group_id', source.groups.visible)
      .eq('role', 'owner')

    expect(ownerMemberships.error).toBeNull()
    expect(ownerMemberships.data).toEqual([expect.objectContaining({
      principal_id: source.humans.owner.principalId,
      role: 'owner'
    })])

    const ownerMembershipId = ownerMemberships.data?.[0]?.id as string
    const secondOwner = await admin.from('memberships').insert({
      group_id: source.groups.visible,
      principal_id: source.humans.member.principalId,
      role: 'owner'
    })
    const demoteOwner = await admin
      .from('memberships')
      .update({ role: 'member' })
      .eq('id', ownerMembershipId)
    const deleteOwner = await admin.from('memberships').delete().eq('id', ownerMembershipId)
    const transferOwner = await admin
      .from('groups')
      .update({ owner_principal_id: source.humans.member.principalId })
      .eq('id', source.groups.visible)
    const convertOwnerToAgent = await admin
      .from('principals')
      .update({ auth_user_id: null, kind: 'agent' })
      .eq('id', source.humans.owner.principalId)

    expect(secondOwner.error?.code).toBe('23514')
    expect(demoteOwner.error?.code).toBe('23514')
    expect(deleteOwner.error?.code).toBe('23514')
    expect(transferOwner.error?.code).toBe('23514')
    expect(convertOwnerToAgent.error?.code).toBe('23514')
  })

  it('allows agents to be members but never group owners', async () => {
    const source = requireFixture()
    const agentId = randomUUID()
    const membershipId = randomUUID()
    const groupId = randomUUID()

    try {
      const agentResult = await admin.from('principals').insert({
        auth_user_id: null,
        display_name: 'Group fixture agent',
        id: agentId,
        kind: 'agent'
      })
      const memberResult = await admin.from('memberships').insert({
        group_id: source.groups.visible,
        id: membershipId,
        principal_id: agentId,
        role: 'member'
      })
      const ownerResult = await admin.from('groups').insert({
        id: groupId,
        name: 'Invalid agent-owned group',
        owner_principal_id: agentId
      })

      expect(agentResult.error).toBeNull()
      expect(memberResult.error).toBeNull()
      expect(ownerResult.error?.code).toBe('23514')
    } finally {
      await admin.from('memberships').delete().eq('id', membershipId)
      await admin.from('groups').delete().eq('id', groupId)
      await admin.from('principals').delete().eq('id', agentId)
    }
  })

  it('normalizes invitation email and derives its group name', async () => {
    const source = requireFixture()
    const { data, error } = await admin
      .from('invitations')
      .select('email, group_name')
      .eq('id', source.invitations.visible)
      .single()

    expect(error).toBeNull()
    expect(data).toEqual({
      email: source.humans.invitee.email,
      group_name: 'Visible security group'
    })
  })

  it('enforces valid pending invitation ownership and email constraints', async () => {
    const source = requireFixture()
    const wrongInviterId = randomUUID()
    const blankEmailId = randomUUID()
    const activeMemberEmailId = randomUUID()
    const wrongInviter = await admin.from('invitations').insert({
      email: `wrong-${randomUUID()}@example.test`,
      group_id: source.groups.visible,
      id: wrongInviterId,
      invited_by_principal_id: source.humans.member.principalId
    })
    const blankEmail = await admin.from('invitations').insert({
      email: '   ',
      group_id: source.groups.visible,
      id: blankEmailId,
      invited_by_principal_id: source.humans.owner.principalId
    })
    const activeMemberEmail = await admin.from('invitations').insert({
      email: source.humans.member.email,
      group_id: source.groups.visible,
      id: activeMemberEmailId,
      invited_by_principal_id: source.humans.owner.principalId
    })

    expect(wrongInviter.error?.code).toBe('23514')
    expect(blankEmail.error?.code).toBe('23514')
    expect(activeMemberEmail.error?.code).toBe('23514')
    await expectRowsMissing('invitations', 'id', wrongInviterId)
    await expectRowsMissing('invitations', 'id', blankEmailId)
    await expectRowsMissing('invitations', 'id', activeMemberEmailId)
  })

  it('lets active members read only their group and membership directory', async () => {
    const source = requireFixture()
    const ownerGroups = await selectIds(source.humans.owner.client, 'groups')
    const ownerMemberships = await selectIds(source.humans.owner.client, 'memberships')
    const ownerInvitations = await selectIds(source.humans.owner.client, 'invitations')
    const memberGroups = await selectIds(source.humans.member.client, 'groups')
    const memberMemberships = await selectIds(source.humans.member.client, 'memberships')
    const memberInvitations = await selectIds(source.humans.member.client, 'invitations')

    expect(ownerGroups).toEqual([source.groups.visible])
    expect(ownerMemberships).toHaveLength(2)
    expect(ownerInvitations).toEqual([source.invitations.visible])
    expect(memberGroups).toEqual([source.groups.visible])
    expect(memberMemberships).toHaveLength(2)
    expect(memberInvitations).toEqual([])
  })

  it('lets pending invitees read only their own invitation', async () => {
    const source = requireFixture()
    const groups = await selectIds(source.humans.invitee.client, 'groups')
    const memberships = await selectIds(source.humans.invitee.client, 'memberships')
    const invitations = await selectIds(source.humans.invitee.client, 'invitations')

    expect(groups).toEqual([])
    expect(memberships).toEqual([])
    expect(invitations).toEqual([source.invitations.visible])
  })

  it('isolates unrelated authenticated users from every group-domain row', async () => {
    const source = requireFixture()

    await expect(Promise.all([
      selectIds(source.humans.unrelated.client, 'groups'),
      selectIds(source.humans.unrelated.client, 'memberships'),
      selectIds(source.humans.unrelated.client, 'invitations')
    ])).resolves.toEqual([[], [], []])
  })

  it('denies anonymous table and helper access', async () => {
    const source = requireFixture()
    const anonymous = createAnonymousClient()
    const tableResults = await Promise.all([
      anonymous.from('groups').select('id'),
      anonymous.from('memberships').select('id'),
      anonymous.from('invitations').select('id')
    ])
    const helperResults = await Promise.all([
      anonymous.rpc('current_auth_email'),
      anonymous.rpc('current_principal_is_group_member', {
        group_id_to_check: source.groups.visible
      }),
      anonymous.rpc('current_principal_owns_group', {
        group_id_to_check: source.groups.visible
      })
    ])

    for (const result of [...tableResults, ...helperResults]) {
      expect(result.error).not.toBeNull()
    }
  })

  it('denies direct group-domain mutations to authenticated callers', async () => {
    const source = requireFixture()
    const insertedGroupId = randomUUID()
    const insertedMembershipId = randomUUID()
    const insertedInvitationId = randomUUID()
    const insertGroup = await source.humans.owner.client.from('groups').insert({
      id: insertedGroupId,
      name: 'Direct group',
      owner_principal_id: source.humans.owner.principalId
    })
    const insertMembership = await source.humans.owner.client.from('memberships').insert({
      group_id: source.groups.visible,
      id: insertedMembershipId,
      principal_id: source.humans.unrelated.principalId,
      role: 'member'
    })
    const insertInvitation = await source.humans.owner.client.from('invitations').insert({
      email: source.humans.unrelated.email,
      group_id: source.groups.visible,
      id: insertedInvitationId,
      invited_by_principal_id: source.humans.owner.principalId
    })
    const updateGroup = await source.humans.owner.client
      .from('groups')
      .update({ name: 'Direct rename' })
      .eq('id', source.groups.visible)
    const deleteMembership = await source.humans.owner.client
      .from('memberships')
      .delete()
      .eq('id', source.memberMembershipId)

    for (const result of [
      insertGroup,
      insertMembership,
      insertInvitation,
      updateGroup,
      deleteMembership
    ]) {
      expect(result.error).not.toBeNull()
    }

    await expectRowsMissing('groups', 'id', insertedGroupId)
    await expectRowsMissing('memberships', 'id', insertedMembershipId)
    await expectRowsMissing('invitations', 'id', insertedInvitationId)
  })

  it('cascades memberships and invitations when a group is deleted', async () => {
    const source = requireFixture()
    const groupId = randomUUID()
    const invitationId = randomUUID()
    const groupResult = await admin.from('groups').insert({
      id: groupId,
      name: 'Cascade validation group',
      owner_principal_id: source.humans.owner.principalId
    })
    const invitationResult = await admin.from('invitations').insert({
      email: source.humans.unrelated.email,
      group_id: groupId,
      id: invitationId,
      invited_by_principal_id: source.humans.owner.principalId
    })
    const deleteResult = await admin.from('groups').delete().eq('id', groupId)

    expect(groupResult.error).toBeNull()
    expect(invitationResult.error).toBeNull()
    expect(deleteResult.error).toBeNull()
    await expectRowsMissing('groups', 'id', groupId)
    await expectRowsMissing('memberships', 'group_id', groupId)
    await expectRowsMissing('invitations', 'group_id', groupId)
  })
})
