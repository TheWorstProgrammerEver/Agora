export type PrincipalKind = 'agent' | 'human'

export type PrincipalDto = {
  id: string
  displayName: string
  kind: PrincipalKind
}

export type GroupRole = 'member' | 'owner'

export type GroupDto = {
  id: string
  createdAt: string
  name: string
  ownerPrincipalId: string
}

export type GroupSummaryDto = GroupDto & {
  unreadCount: number
}

export type GroupMemberDto = {
  groupId: string
  joinedAt: string
  principal: PrincipalDto
  role: GroupRole
}

export type InvitationDto = {
  id: string
  createdAt: string
  email: string
  group: Pick<GroupDto, 'id' | 'name'>
  invitedBy: PrincipalDto
}

export type MessageSequence = string

export type MessageDto = {
  id: string
  createdAt: string
  groupId: string
  sender: PrincipalDto
  sequence: MessageSequence
  text: string
}

export type ReadWatermarkDto = {
  groupId: string
  sequence: MessageSequence
}

export type CursorPageParams = {
  cursor?: string
  limit?: number
}

export type CursorPage<TItem> = {
  items: TItem[]
  nextCursor?: string
}

export type GroupIdParams = {
  groupId: string
}

export type InvitationIdParams = {
  invitationId: string
}

export type ListGroupsParams = CursorPageParams

export type GetGroupParams = GroupIdParams

export type CreateGroupParams = {
  name: string
}

export type DeleteGroupParams = GroupIdParams

export type ListPendingInvitationsParams = CursorPageParams

export type InviteHumanParams = GroupIdParams & {
  email: string
}

export type AcceptInvitationParams = InvitationIdParams

export type RejectInvitationParams = InvitationIdParams

export type ListGroupMembersParams = GroupIdParams & CursorPageParams

export type AddAgentMemberParams = GroupIdParams & {
  agentPrincipalId: string
}

export type RemoveMemberParams = GroupIdParams & {
  principalId: string
}

type InitialMessageWindow = {
  afterSequence?: never
  aroundSequence?: never
  beforeSequence?: never
}

type AfterMessageWindow = {
  afterSequence: MessageSequence
  aroundSequence?: never
  beforeSequence?: never
}

type AroundMessageWindow = {
  afterSequence?: never
  aroundSequence: MessageSequence
  beforeSequence?: never
}

type BeforeMessageWindow = {
  afterSequence?: never
  aroundSequence?: never
  beforeSequence: MessageSequence
}

export type GetGroupMessagesParams = GroupIdParams & {
  limit?: number
} & (InitialMessageWindow | AfterMessageWindow | AroundMessageWindow | BeforeMessageWindow)

export type GetUnreadMessagesParams = GroupIdParams & {
  afterSequence?: MessageSequence
  limit?: number
}

export type SendMessageParams = GroupIdParams & {
  clientMessageId: string
  text: string
}

export type MarkGroupReadParams = GroupIdParams & {
  throughSequence: MessageSequence
}

export type CreateRealtimeSessionParams = {
  groupIds: string[]
}

export type RealtimeTopicDto = {
  groupId: string
  highWatermarkSequence: MessageSequence
  topic: string
}

export type RealtimeSessionDto = {
  accessToken: string
  expiresAt: string
  refreshAfter: string
  topics: RealtimeTopicDto[]
}
