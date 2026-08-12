import { expect, test } from '@playwright/test'
import type {
  GroupDto,
  GroupMemberDto,
  GroupSummaryDto,
  MessageDto
} from '../../common/agoraDtos'
import { AgoraFunctionMockError, routeAgoraFunction } from './agoraFunctionMock'
import { routeRuntimeConfig } from './runtimeConfig'
import { cleanupVisualAccounts, createVisualAccount } from './visualAccount'

const createdUserEmails = new Set<string>()
const groupId = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
const memberId = '33333333-3333-4333-8333-333333333333'
const createdAt = '2026-08-12T00:00:00Z'

const group: GroupDto = {
  createdAt,
  id: groupId,
  name: 'Conversation room',
  ownerPrincipalId: ownerId
}

const owner: GroupMemberDto = {
  groupId,
  joinedAt: createdAt,
  principal: { displayName: 'Human Owner', id: ownerId, kind: 'human' },
  role: 'owner'
}

const member: GroupMemberDto = {
  groupId,
  joinedAt: createdAt,
  principal: { displayName: 'Human Member', id: memberId, kind: 'human' },
  role: 'member'
}

const message = (sequence: number, text: string, sender = member.principal): MessageDto => ({
  createdAt: `2026-08-12T00:0${Math.min(sequence, 9)}:00Z`,
  groupId,
  id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
  sender,
  sequence: sequence.toString(),
  text
})

const createAccount = async (page: Parameters<typeof createVisualAccount>[0]) => {
  await createVisualAccount(page, createdUserEmails, 'conversation')
  await expect(page).toHaveURL('/')
}

test.beforeEach(async ({ page }) => {
  await routeRuntimeConfig(page)
})

test.afterEach(async () => {
  await cleanupVisualAccounts(createdUserEmails)
})

test('sends, paginates, acknowledges unread messages, and catches up after reconnect', async ({ page }) => {
  const summary: GroupSummaryDto = { ...group, unreadCount: 2 }
  const messages = [
    message(1, 'Earlier context'),
    message(2, 'Current context'),
    message(3, 'Unread persisted message')
  ]
  const sendClientIds: unknown[] = []
  let sendAttempts = 0
  let markedThrough: unknown

  await routeAgoraFunction(page, (identifier, params) => {
    if (identifier === 'listGroups') return { items: [summary] }
    if (identifier === 'listPendingInvitations') return { items: [] }
    if (identifier === 'getGroup') return { currentMember: owner, group }
    if (identifier === 'listGroupMembers') return { items: [owner, member] }
    if (identifier === 'getUnreadMessages') return { items: [messages[2]] }
    if (identifier === 'getGroupMessages') {
      if (params.beforeSequence === '2') {
        return { items: [messages[0]] }
      }

      if (typeof params.afterSequence === 'string') {
        return {
          items: messages.filter(({ sequence }) => BigInt(sequence) > BigInt(params.afterSequence as string))
        }
      }

      return { items: messages.slice(-2), nextCursor: '2' }
    }
    if (identifier === 'markGroupRead') {
      markedThrough = params.throughSequence
      return { groupId, sequence: params.throughSequence }
    }
    if (identifier === 'sendMessage') {
      sendAttempts += 1
      sendClientIds.push(params.clientMessageId)

      if (sendAttempts === 1) {
        throw new AgoraFunctionMockError('Message delivery is temporarily unavailable.', 503)
      }

      const sent = message(4, params.text as string, owner.principal)
      messages.push(sent)
      return sent
    }

    throw new Error(`Unexpected ${identifier} request`)
  })

  await createAccount(page)
  await expect(page.getByLabel('2 unread messages')).toBeVisible()
  await page.getByRole('link', { name: 'Open group' }).click()

  await expect(page.getByRole('heading', { name: 'Participants' })).toBeVisible()
  await expect(page.getByLabel(`${group.name} members`).getByText('Human Member', { exact: true })).toBeVisible()
  await expect(page.getByText('Unread persisted message')).toBeVisible()
  await expect(page.getByText('Unread', { exact: true })).toHaveCount(1)

  await page.getByRole('button', { name: 'Load earlier messages' }).click()
  await expect(page.getByText('Earlier context')).toBeVisible()

  await page.getByRole('button', { name: 'Mark as read' }).click()
  await expect.poll(() => markedThrough).toBe('3')
  await expect(page.getByText('Unread', { exact: true })).toHaveCount(0)

  await page.getByLabel('Message', { exact: true }).fill('Idempotent hello')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('alert')).toContainText('Your draft is safe')
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Idempotent hello')
  await page.getByRole('button', { name: 'Retry send' }).click()
  await expect(page.getByText('Idempotent hello', { exact: true })).toHaveCount(1)
  expect(sendClientIds).toHaveLength(2)
  expect(sendClientIds[0]).toBe(sendClientIds[1])

  messages.push(message(5, 'Recovered after reconnect'))
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('online'))
  })
  await expect(page.getByText('Recovered after reconnect')).toHaveCount(1)

  await page.setViewportSize({ width: 360, height: 780 })
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('removes protected conversation content when persisted catch-up denies access', async ({ page }) => {
  const protectedMessage = message(1, 'Protected conversation text')
  let removed = false

  await routeAgoraFunction(page, (identifier, params) => {
    if (identifier === 'listGroups') return { items: [{ ...group, unreadCount: 1 }] }
    if (identifier === 'listPendingInvitations') return { items: [] }
    if (identifier === 'getGroup') return { currentMember: member, group }
    if (identifier === 'listGroupMembers') return { items: [owner, member] }
    if (identifier === 'getUnreadMessages') return { items: [protectedMessage] }
    if (identifier === 'getGroupMessages') {
      if (removed && typeof params.afterSequence === 'string') {
        throw new AgoraFunctionMockError('This message operation is not permitted.', 403)
      }

      return { items: [protectedMessage] }
    }

    throw new Error(`Unexpected ${identifier} request`)
  })

  await createAccount(page)
  await page.getByRole('link', { name: 'Open group' }).click()
  await expect(page.getByText(protectedMessage.text)).toBeVisible()

  removed = true
  await page.evaluate(() => window.dispatchEvent(new Event('online')))

  await expect(page.getByRole('heading', { name: 'Group unavailable' })).toBeVisible()
  await expect(page.getByText('You no longer have access to this group.')).toBeVisible()
  await expect(page.getByText(protectedMessage.text)).not.toBeVisible()
})
