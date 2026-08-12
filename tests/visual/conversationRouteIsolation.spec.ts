import { expect, test } from '@playwright/test'
import type { GroupDto, GroupMemberDto, MessageDto } from '../../common/agoraDtos'
import { AgoraFunctionMockError, routeAgoraFunction } from './agoraFunctionMock'
import { routeAgoraRealtime } from './agoraRealtimeMock'
import { routeRuntimeConfig } from './runtimeConfig'
import { cleanupVisualAccounts, createVisualAccount } from './visualAccount'

const createdUserEmails = new Set<string>()
const firstGroup: GroupDto = {
  createdAt: '2026-08-12T00:00:00Z',
  id: '11111111-1111-4111-8111-111111111111',
  name: 'First conversation room',
  ownerPrincipalId: '22222222-2222-4222-8222-222222222222'
}
const secondGroup: GroupDto = {
  ...firstGroup,
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Second conversation room'
}
const owner: GroupMemberDto = {
  groupId: firstGroup.id,
  joinedAt: firstGroup.createdAt,
  principal: {
    displayName: 'Human Owner',
    id: firstGroup.ownerPrincipalId,
    kind: 'human'
  },
  role: 'owner'
}
const message = (groupId: string, sequence: number, text: string): MessageDto => ({
  createdAt: `2026-08-12T00:0${Math.min(sequence, 9)}:00Z`,
  groupId,
  id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
  sender: owner.principal,
  sequence: sequence.toString(),
  text
})

const navigateToGroup = (groupId: string) => {
  window.history.pushState(null, '', `/groups/${groupId}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const waitForAgoraResponse = (
  page: Parameters<typeof createVisualAccount>[0],
  identifier: string,
  matchesParams: (params: Record<string, unknown>) => boolean
) => page.waitForResponse((response) => {
  if (!response.url().endsWith('/functions/v1/agora')) return false

  const request = JSON.parse(response.request().postData() ?? '{}') as {
    identifier?: string
    params?: Record<string, unknown>
  }
  return request.identifier === identifier && matchesParams(request.params ?? {})
})

const waitForRender = (page: Parameters<typeof createVisualAccount>[0]) => page.evaluate(() => (
  new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
  })
))

test.beforeEach(async ({ page }) => {
  await routeRuntimeConfig(page)
})

test.afterEach(async () => {
  await cleanupVisualAccounts(createdUserEmails)
})

test('keeps delayed conversation responses scoped to their issuing group', async ({ page }) => {
  const firstCurrent = message(firstGroup.id, 3, 'First group current')
  const firstEarlier = message(firstGroup.id, 2, 'First group delayed history')
  const secondCurrent = message(secondGroup.id, 7, 'Second group unread')
  let resolveEarlier: (value: { items: MessageDto[] }) => void = () => undefined
  let resolveRead: (value: { groupId: string, sequence: string }) => void = () => undefined
  let rejectSend: (reason: unknown) => void = () => undefined
  const delayedEarlier = new Promise<{ items: MessageDto[] }>((resolve) => {
    resolveEarlier = resolve
  })
  const delayedRead = new Promise<{ groupId: string, sequence: string }>((resolve) => {
    resolveRead = resolve
  })
  const delayedSend = new Promise<MessageDto>((_, reject) => {
    rejectSend = reject
  })

  await routeAgoraRealtime(page)
  await routeAgoraFunction(page, (identifier, params) => {
    const groupId = params.groupId

    if (identifier === 'listGroups') {
      return { items: [
        { ...firstGroup, unreadCount: 1 },
        { ...secondGroup, unreadCount: 1 }
      ] }
    }
    if (identifier === 'listPendingInvitations') return { items: [] }
    if (identifier === 'getGroup') {
      const group = groupId === secondGroup.id ? secondGroup : firstGroup
      return { currentMember: { ...owner, groupId: group.id }, group }
    }
    if (identifier === 'listGroupMembers') {
      return { items: [{ ...owner, groupId: groupId as string }] }
    }
    if (identifier === 'getUnreadMessages') {
      return { items: [groupId === secondGroup.id ? secondCurrent : firstCurrent] }
    }
    if (identifier === 'getGroupMessages') {
      if (groupId === firstGroup.id && params.beforeSequence === '3') return delayedEarlier

      const current = groupId === secondGroup.id ? secondCurrent : firstCurrent
      return { items: [current], nextCursor: groupId === firstGroup.id ? '3' : undefined }
    }
    if (identifier === 'markGroupRead' && groupId === firstGroup.id) return delayedRead
    if (identifier === 'sendMessage' && groupId === firstGroup.id) return delayedSend

    throw new Error(`Unexpected ${identifier} request`)
  })

  await createVisualAccount(page, createdUserEmails, 'conversation-isolation')
  await page.getByRole('link', { name: 'Open group' }).first().click()
  await expect(page.getByText(firstCurrent.text)).toBeVisible()
  await page.getByRole('button', { name: 'Load earlier messages' }).click()
  await page.getByRole('button', { name: 'Mark as read' }).click()

  await page.evaluate(navigateToGroup, secondGroup.id)
  await expect(page.getByRole('heading', { name: secondGroup.name })).toBeVisible()
  await expect(page.getByText(secondCurrent.text)).toBeVisible()

  const earlierResponse = waitForAgoraResponse(page, 'getGroupMessages', (params) => (
    params.groupId === firstGroup.id && params.beforeSequence === '3'
  ))
  const readResponse = waitForAgoraResponse(page, 'markGroupRead', (params) => (
    params.groupId === firstGroup.id
  ))
  resolveEarlier({ items: [firstEarlier] })
  resolveRead({ groupId: firstGroup.id, sequence: firstCurrent.sequence })
  await Promise.all([earlierResponse, readResponse])
  await waitForRender(page)

  await expect(page.getByText(firstEarlier.text)).not.toBeVisible()
  await expect(page.getByText(firstCurrent.text)).not.toBeVisible()
  await expect(page.getByText('Unread', { exact: true })).toHaveCount(1)

  await page.evaluate(navigateToGroup, firstGroup.id)
  await expect(page.getByText(firstCurrent.text)).toBeVisible()
  await page.getByLabel('Message', { exact: true }).fill('First group delayed failure')
  await page.getByRole('button', { name: 'Send message' }).click()

  await page.evaluate(navigateToGroup, secondGroup.id)
  await expect(page.getByRole('heading', { name: secondGroup.name })).toBeVisible()

  const sendResponse = waitForAgoraResponse(page, 'sendMessage', (params) => (
    params.groupId === firstGroup.id
  ))
  rejectSend(new AgoraFunctionMockError('First group send failed.', 503))
  await sendResponse
  await waitForRender(page)

  await expect(page.getByText(secondCurrent.text)).toBeVisible()
  await expect(page.getByText('Unread', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
