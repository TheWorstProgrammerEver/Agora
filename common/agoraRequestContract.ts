import type {
  AcceptInvitationParams,
  AddAgentMemberParams,
  CreateGroupParams,
  CreateRealtimeSessionParams,
  CursorPage,
  DeleteGroupParams,
  GetGroupMessagesParams,
  GetGroupParams,
  GetUnreadMessagesParams,
  GroupDto,
  GroupMemberDto,
  GroupSummaryDto,
  InvitationDto,
  InviteHumanParams,
  ListGroupMembersParams,
  ListGroupsParams,
  ListPendingInvitationsParams,
  MarkGroupReadParams,
  MessageDto,
  ReadWatermarkDto,
  RealtimeSessionDto,
  RejectInvitationParams,
  RemoveMemberParams,
  SendMessageParams
} from './agoraDtos.ts'
import type { AgoraRequestIdentifier } from './agoraRequestIdentifiers.ts'
import { agoraContractVersion } from './agoraRequestIdentifiers.ts'

export type AgoraRequestCatalog = {
  acceptInvitation: {
    params: AcceptInvitationParams
    result: { groupId: string, invitationId: string, member: GroupMemberDto }
  }
  addAgentMember: {
    params: AddAgentMemberParams
    result: { member: GroupMemberDto }
  }
  createGroup: {
    params: CreateGroupParams
    result: { group: GroupDto }
  }
  createRealtimeSession: {
    params: CreateRealtimeSessionParams
    result: RealtimeSessionDto
  }
  deleteGroup: {
    params: DeleteGroupParams
    result: { groupId: string }
  }
  getGroup: {
    params: GetGroupParams
    result: { currentMember: GroupMemberDto, group: GroupDto }
  }
  getGroupMessages: {
    params: GetGroupMessagesParams
    result: CursorPage<MessageDto>
  }
  getUnreadMessages: {
    params: GetUnreadMessagesParams
    result: CursorPage<MessageDto>
  }
  inviteHuman: {
    params: InviteHumanParams
    result: { invitation: InvitationDto }
  }
  listGroupMembers: {
    params: ListGroupMembersParams
    result: CursorPage<GroupMemberDto>
  }
  listGroups: {
    params: ListGroupsParams
    result: CursorPage<GroupSummaryDto>
  }
  listPendingInvitations: {
    params: ListPendingInvitationsParams
    result: CursorPage<InvitationDto>
  }
  markGroupRead: {
    params: MarkGroupReadParams
    result: ReadWatermarkDto
  }
  rejectInvitation: {
    params: RejectInvitationParams
    result: { groupId: string, invitationId: string }
  }
  removeMember: {
    params: RemoveMemberParams
    result: { groupId: string, principalId: string }
  }
  sendMessage: {
    params: SendMessageParams
    result: MessageDto
  }
}

type CatalogIdentifiers = keyof AgoraRequestCatalog
type MissingCatalogIdentifiers = Exclude<AgoraRequestIdentifier, CatalogIdentifiers>
type ExtraCatalogIdentifiers = Exclude<CatalogIdentifiers, AgoraRequestIdentifier>

export type AgoraCatalogIsComplete = [MissingCatalogIdentifiers, ExtraCatalogIdentifiers] extends [never, never]
  ? true
  : never

export type AgoraRequestParams<TIdentifier extends AgoraRequestIdentifier> = (
  AgoraRequestCatalog[TIdentifier]['params']
)

export type AgoraRequestResult<TIdentifier extends AgoraRequestIdentifier> = (
  AgoraRequestCatalog[TIdentifier]['result']
)

export type AgoraRequestEnvelope<TIdentifier extends AgoraRequestIdentifier = AgoraRequestIdentifier> = {
  identifier: TIdentifier
  params: AgoraRequestParams<TIdentifier>
  version: typeof agoraContractVersion
}

export type AnyAgoraRequestEnvelope = {
  [TIdentifier in AgoraRequestIdentifier]: AgoraRequestEnvelope<TIdentifier>
}[AgoraRequestIdentifier]
