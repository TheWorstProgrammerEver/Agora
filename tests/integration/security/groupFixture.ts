import { randomUUID } from 'node:crypto'
import { createHumanFixtures, deleteHumanFixtures, type HumanFixture } from './humanFixture'
import { createAdminClient } from './localSupabase'

export type GroupSecurityFixture = {
  groups: {
    hidden: string
    visible: string
  }
  humans: {
    hiddenInvitee: HumanFixture
    invitee: HumanFixture
    member: HumanFixture
    outsider: HumanFixture
    owner: HumanFixture
    unrelated: HumanFixture
  }
  invitations: {
    hidden: string
    visible: string
  }
  memberMembershipId: string
}

const insertRows = async (table: string, rows: unknown[]) => {
  const { error } = await createAdminClient().from(table).insert(rows)

  if (error) {
    throw error
  }
}

export const createGroupSecurityFixture = async (): Promise<GroupSecurityFixture> => {
  const humans = await createHumanFixtures([
    'group-owner',
    'group-member',
    'group-invitee',
    'group-outsider',
    'group-unrelated',
    'group-hidden-invitee'
  ])
  const [owner, member, invitee, outsider, unrelated, hiddenInvitee] = humans
  const fixture = {
    groups: {
      hidden: randomUUID(),
      visible: randomUUID()
    },
    humans: {
      hiddenInvitee,
      invitee,
      member,
      outsider,
      owner,
      unrelated
    },
    invitations: {
      hidden: randomUUID(),
      visible: randomUUID()
    },
    memberMembershipId: randomUUID()
  }

  try {
    await insertRows('groups', [
      {
        id: fixture.groups.visible,
        name: 'Visible security group',
        owner_principal_id: owner.principalId
      },
      {
        id: fixture.groups.hidden,
        name: 'Hidden security group',
        owner_principal_id: outsider.principalId
      }
    ])

    await insertRows('memberships', [{
      group_id: fixture.groups.visible,
      id: fixture.memberMembershipId,
      principal_id: member.principalId,
      role: 'member'
    }])

    await insertRows('invitations', [
      {
        email: ` ${invitee.email.toUpperCase()} `,
        group_id: fixture.groups.visible,
        id: fixture.invitations.visible,
        invited_by_principal_id: owner.principalId
      },
      {
        email: hiddenInvitee.email,
        group_id: fixture.groups.hidden,
        id: fixture.invitations.hidden,
        invited_by_principal_id: outsider.principalId
      }
    ])

    return fixture
  } catch (error) {
    await cleanupGroupSecurityFixture(fixture)
    throw error
  }
}

export const cleanupGroupSecurityFixture = async (fixture: GroupSecurityFixture | undefined) => {
  if (!fixture) {
    return
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('groups')
    .delete()
    .in('id', Object.values(fixture.groups))

  if (error) {
    throw error
  }

  await deleteHumanFixtures(Object.values(fixture.humans))
}
