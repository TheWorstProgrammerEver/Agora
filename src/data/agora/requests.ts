import { createCommandType, createQueryType } from '../../../lib/dispatch/dispatch'
import type { AgoraRequestParams, AgoraRequestResult } from '../../../common/agoraRequestContract'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'

type Params<TIdentifier extends keyof typeof agoraRequestIdentifiers> = AgoraRequestParams<TIdentifier>
type Result<TIdentifier extends keyof typeof agoraRequestIdentifiers> = AgoraRequestResult<TIdentifier>

export const ListGroupsQuery = createQueryType(agoraRequestIdentifiers.listGroups)<
  Result<'listGroups'>,
  Params<'listGroups'>
>()
export const GetGroupQuery = createQueryType(agoraRequestIdentifiers.getGroup)<
  Result<'getGroup'>,
  Params<'getGroup'>
>()
export const CreateGroupCommand = createCommandType(agoraRequestIdentifiers.createGroup)<
  Result<'createGroup'>,
  Params<'createGroup'>
>()
export const DeleteGroupCommand = createCommandType(agoraRequestIdentifiers.deleteGroup)<
  Result<'deleteGroup'>,
  Params<'deleteGroup'>
>()
export const ListPendingInvitationsQuery = createQueryType(
  agoraRequestIdentifiers.listPendingInvitations
)<Result<'listPendingInvitations'>, Params<'listPendingInvitations'>>()
export const InviteHumanCommand = createCommandType(agoraRequestIdentifiers.inviteHuman)<
  Result<'inviteHuman'>,
  Params<'inviteHuman'>
>()
export const AcceptInvitationCommand = createCommandType(agoraRequestIdentifiers.acceptInvitation)<
  Result<'acceptInvitation'>,
  Params<'acceptInvitation'>
>()
export const RejectInvitationCommand = createCommandType(agoraRequestIdentifiers.rejectInvitation)<
  Result<'rejectInvitation'>,
  Params<'rejectInvitation'>
>()
export const ListGroupMembersQuery = createQueryType(agoraRequestIdentifiers.listGroupMembers)<
  Result<'listGroupMembers'>,
  Params<'listGroupMembers'>
>()
export const AddAgentMemberCommand = createCommandType(agoraRequestIdentifiers.addAgentMember)<
  Result<'addAgentMember'>,
  Params<'addAgentMember'>
>()
export const RemoveMemberCommand = createCommandType(agoraRequestIdentifiers.removeMember)<
  Result<'removeMember'>,
  Params<'removeMember'>
>()
export const GetGroupMessagesQuery = createQueryType(agoraRequestIdentifiers.getGroupMessages)<
  Result<'getGroupMessages'>,
  Params<'getGroupMessages'>
>()
export const GetUnreadMessagesQuery = createQueryType(agoraRequestIdentifiers.getUnreadMessages)<
  Result<'getUnreadMessages'>,
  Params<'getUnreadMessages'>
>()
export const SendMessageCommand = createCommandType(agoraRequestIdentifiers.sendMessage)<
  Result<'sendMessage'>,
  Params<'sendMessage'>
>()
export const MarkGroupReadCommand = createCommandType(agoraRequestIdentifiers.markGroupRead)<
  Result<'markGroupRead'>,
  Params<'markGroupRead'>
>()
export const CreateRealtimeSessionCommand = createCommandType(
  agoraRequestIdentifiers.createRealtimeSession
)<Result<'createRealtimeSession'>, Params<'createRealtimeSession'>>()

export const agoraRequestTypes = [
  AcceptInvitationCommand,
  AddAgentMemberCommand,
  CreateGroupCommand,
  CreateRealtimeSessionCommand,
  DeleteGroupCommand,
  GetGroupQuery,
  GetGroupMessagesQuery,
  GetUnreadMessagesQuery,
  InviteHumanCommand,
  ListGroupMembersQuery,
  ListGroupsQuery,
  ListPendingInvitationsQuery,
  MarkGroupReadCommand,
  RejectInvitationCommand,
  RemoveMemberCommand,
  SendMessageCommand
]
