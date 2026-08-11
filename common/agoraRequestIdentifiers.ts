export const agoraContractVersion = 1 as const

export const agoraRequestIdentifiers = {
  acceptInvitation: 'acceptInvitation',
  addAgentMember: 'addAgentMember',
  createGroup: 'createGroup',
  createRealtimeSession: 'createRealtimeSession',
  deleteGroup: 'deleteGroup',
  getGroup: 'getGroup',
  getGroupMessages: 'getGroupMessages',
  getUnreadMessages: 'getUnreadMessages',
  inviteHuman: 'inviteHuman',
  listGroupMembers: 'listGroupMembers',
  listGroups: 'listGroups',
  listPendingInvitations: 'listPendingInvitations',
  markGroupRead: 'markGroupRead',
  rejectInvitation: 'rejectInvitation',
  removeMember: 'removeMember',
  sendMessage: 'sendMessage'
} as const

export const agoraRequestNames = Object.values(agoraRequestIdentifiers)

export type AgoraRequestIdentifier = typeof agoraRequestNames[number]

const agoraRequestNameSet = new Set<string>(agoraRequestNames)

export const isAgoraRequestIdentifier = (value: unknown): value is AgoraRequestIdentifier => (
  typeof value === 'string' && agoraRequestNameSet.has(value)
)
