import { expect, test, type Page } from '@playwright/test'
import type {
  GroupDto,
  GroupMemberDto,
  GroupSummaryDto,
  InvitationDto
} from '../../common/agoraDtos'
import { routeAgoraFunction } from './agoraFunctionMock'
import { routeRuntimeConfig } from './runtimeConfig'
import { deleteSupabaseUsersByEmail } from './supabaseTestAuth'

const createdUserEmails = new Set<string>()
const groupId = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
const agentId = '33333333-3333-4333-8333-333333333333'
const invitationOneId = '44444444-4444-4444-8444-444444444444'
const invitationTwoId = '55555555-5555-4555-8555-555555555555'
const createdAt = '2026-08-12T00:00:00Z'

const group: GroupDto = {
  createdAt,
  id: groupId,
  name: 'Launch room',
  ownerPrincipalId: ownerId
}

const owner: GroupMemberDto = {
  groupId,
  joinedAt: createdAt,
  principal: { displayName: 'Human Owner', id: ownerId, kind: 'human' },
  role: 'owner'
}

const agent: GroupMemberDto = {
  groupId,
  joinedAt: createdAt,
  principal: { displayName: 'Agent Orion', id: agentId, kind: 'agent' },
  role: 'member'
}

const invitation = (id: string, name: string): InvitationDto => ({
  createdAt,
  email: 'invited@example.test',
  group: { id: groupId, name },
  id,
  invitedBy: owner.principal
})

const createAccount = async (page: Page) => {
  const email = `agora.groups@visual-${Date.now()}-${Math.random().toString(36).slice(2)}.example.com`
  createdUserEmails.add(email)

  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL('/')

  return email
}

test.beforeEach(async ({ page }) => {
  await routeRuntimeConfig(page)
})

test.afterEach(async () => {
  const emails = [...createdUserEmails]
  await deleteSupabaseUsersByEmail(emails)
  emails.forEach((email) => createdUserEmails.delete(email))
})

test('lets an owner create and administer a group with confirmed deletion', async ({ page }) => {
  let groups: GroupSummaryDto[] = []
  let members = [owner]
  let deleteCalls = 0

  await routeAgoraFunction(page, (identifier, params) => {
    if (identifier === 'listGroups') {
      return { items: groups }
    }
    if (identifier === 'listPendingInvitations') {
      return { items: [] }
    }
    if (identifier === 'createGroup') {
      groups = [{ ...group, unreadCount: 0 }]
      return { group }
    }
    if (identifier === 'getGroup') {
      return { currentMember: owner, group }
    }
    if (identifier === 'listGroupMembers') {
      return { items: members }
    }
    if (identifier === 'inviteHuman') {
      return { invitation: { ...invitation(invitationOneId, group.name), email: params.email } }
    }
    if (identifier === 'addAgentMember') {
      members = [owner, agent]
      return { member: agent }
    }
    if (identifier === 'removeMember') {
      members = members.filter(({ principal }) => principal.id !== params.principalId)
      return { groupId, principalId: params.principalId }
    }
    if (identifier === 'deleteGroup') {
      deleteCalls += 1
      groups = []
      return { groupId }
    }

    throw new Error(`Unexpected ${identifier} request`)
  })

  await createAccount(page)
  await expect(page.getByText('No pending invitations.')).toBeVisible()
  await page.getByRole('button', { name: 'Create group' }).click()
  await page.getByLabel('Group name').fill(group.name)
  await page.getByRole('dialog').getByRole('button', { name: 'Create group' }).click()
  await expect(page.getByText(`${group.name} created.`)).toBeVisible()
  await page.getByRole('link', { name: 'Open group' }).click()

  await expect(page.getByRole('heading', { name: group.name })).toBeVisible()
  await expect(page.getByText('Human · Owner')).toBeVisible()
  await expect(page.getByText('This creates an in-app invitation only.')).toBeVisible()

  await page.getByLabel('Email', { exact: true }).fill('New.Member@Example.test')
  await page.getByRole('button', { name: 'Create invitation' }).click()
  await expect(page.getByRole('status')).toContainText('Coordinate with them out of band.')

  await page.getByLabel('Agent principal ID').fill(agentId)
  await page.getByRole('button', { name: 'Add agent' }).click()
  await expect(page.getByText('Agent · Member')).toBeVisible()
  await page.getByRole('button', { name: 'Remove Agent Orion' }).click()
  await expect(page.getByText('Agent Orion', { exact: true })).not.toBeVisible()

  await page.getByRole('button', { name: 'Delete group' }).click()
  await expect(page.getByRole('dialog', { name: `Delete ${group.name}?` })).toBeVisible()
  expect(deleteCalls).toBe(0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  expect(deleteCalls).toBe(0)

  await page.getByRole('button', { name: 'Delete group' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete group' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByText('You do not belong to any groups yet.')).toBeVisible()
  expect(deleteCalls).toBe(1)
})

test('accepts and rejects pending invitations in app', async ({ page }) => {
  const acceptedGroup = { ...group, name: 'Accepted group' }
  let pending = [
    invitation(invitationOneId, acceptedGroup.name),
    invitation(invitationTwoId, 'Declined group')
  ]

  await routeAgoraFunction(page, (identifier, params) => {
    if (identifier === 'listGroups') {
      return { items: [] }
    }
    if (identifier === 'listPendingInvitations') {
      return { items: pending }
    }
    if (identifier === 'acceptInvitation') {
      pending = pending.filter(({ id }) => id !== params.invitationId)
      return { groupId, invitationId: params.invitationId, member: owner }
    }
    if (identifier === 'getGroup') {
      return { currentMember: owner, group: acceptedGroup }
    }
    if (identifier === 'rejectInvitation') {
      pending = pending.filter(({ id }) => id !== params.invitationId)
      return { groupId, invitationId: params.invitationId }
    }

    throw new Error(`Unexpected ${identifier} request`)
  })

  await createAccount(page)
  await page.getByRole('button', { name: `Accept invitation to ${acceptedGroup.name}` }).click()
  await expect(page.getByRole('status')).toHaveText(`Joined ${acceptedGroup.name}.`)
  await expect(page.getByText(acceptedGroup.name, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Reject invitation to Declined group' }).click()
  await expect(page.getByRole('status')).toHaveText('Invitation rejected.')
  await expect(page.getByText('No pending invitations.')).toBeVisible()
})

test('does not expose owner controls to an ordinary member', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  const summary = { ...group, unreadCount: 0 }
  const ordinaryMember: GroupMemberDto = {
    ...owner,
    principal: {
      displayName: 'Ordinary Member',
      id: '66666666-6666-4666-8666-666666666666',
      kind: 'human'
    },
    role: 'member'
  }

  await routeAgoraFunction(page, (identifier) => {
    if (identifier === 'listGroups') {
      return { items: [summary] }
    }
    if (identifier === 'listPendingInvitations') {
      return { items: [] }
    }
    if (identifier === 'getGroup') {
      return { currentMember: ordinaryMember, group }
    }
    if (identifier === 'listGroupMembers') {
      return { items: [owner, ordinaryMember, agent] }
    }

    throw new Error(`Unexpected ${identifier} request`)
  })

  await createAccount(page)
  await page.getByRole('link', { name: 'Open group' }).click()
  await expect(page.getByText('Member', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete group' })).not.toBeVisible()
  await expect(page.getByRole('heading', { name: 'Invite a person' })).not.toBeVisible()
  await expect(page.getByRole('heading', { name: 'Add an agent' })).not.toBeVisible()
  await expect(page.getByRole('button', { name: /Remove/ })).not.toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})
