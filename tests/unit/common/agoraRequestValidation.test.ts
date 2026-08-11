import { describe, expect, it } from 'vitest'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'
import { isAgoraRequestParams } from '../../../common/agoraRequestValidation'

const firstId = '10000000-0000-4000-8000-000000000001'
const secondId = '20000000-0000-4000-8000-000000000002'

const validParams = {
  acceptInvitation: { invitationId: firstId },
  addAgentMember: { agentPrincipalId: secondId, groupId: firstId },
  createGroup: { name: 'Group' },
  createRealtimeSession: { groupIds: [firstId] },
  deleteGroup: { groupId: firstId },
  getGroup: { groupId: firstId },
  getGroupMessages: { aroundSequence: '12', groupId: firstId, limit: 20 },
  getUnreadMessages: { afterSequence: '12', groupId: firstId, limit: 20 },
  inviteHuman: { email: 'member@example.test', groupId: firstId },
  listGroupMembers: { cursor: 'cursor', groupId: firstId, limit: 20 },
  listGroups: { cursor: 'cursor', limit: 20 },
  listPendingInvitations: {},
  markGroupRead: { groupId: firstId, throughSequence: '12' },
  rejectInvitation: { invitationId: firstId },
  removeMember: { groupId: firstId, principalId: secondId },
  sendMessage: { clientMessageId: 'attempt-1', groupId: firstId, text: 'Hello' }
}

describe('Agora request parameter validation', () => {
  it('keeps one runtime validator for every shared identifier', () => {
    for (const identifier of Object.values(agoraRequestIdentifiers)) {
      expect(isAgoraRequestParams(identifier, validParams[identifier])).toBe(true)
    }
  })

  it('rejects invalid discriminated windows and unexpected fields', () => {
    expect(isAgoraRequestParams(agoraRequestIdentifiers.getGroupMessages, {
      afterSequence: '1',
      aroundSequence: '2',
      groupId: firstId
    })).toBe(false)
    expect(isAgoraRequestParams(agoraRequestIdentifiers.sendMessage, {
      ...validParams.sendMessage,
      senderPrincipalId: secondId
    })).toBe(false)
    expect(isAgoraRequestParams(agoraRequestIdentifiers.listGroups, {
      limit: 0
    })).toBe(false)
    expect(isAgoraRequestParams(agoraRequestIdentifiers.listGroups, {
      limit: 101
    })).toBe(false)
    expect(isAgoraRequestParams(agoraRequestIdentifiers.createGroup, {
      name: 'x'.repeat(121)
    })).toBe(false)
  })
})
