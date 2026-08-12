import { agoraDispatcher } from './agoraDispatcher'
import {
  AcceptInvitationCommand,
  AddAgentMemberCommand,
  CreateGroupCommand,
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
} from './requests'

export const listGroups = (params: ConstructorParameters<typeof ListGroupsQuery>[0]) => (
  agoraDispatcher.dispatch(new ListGroupsQuery(params))
)

export const getGroup = (params: ConstructorParameters<typeof GetGroupQuery>[0]) => (
  agoraDispatcher.dispatch(new GetGroupQuery(params))
)

export const createGroup = (params: ConstructorParameters<typeof CreateGroupCommand>[0]) => (
  agoraDispatcher.dispatch(new CreateGroupCommand(params))
)

export const deleteGroup = (params: ConstructorParameters<typeof DeleteGroupCommand>[0]) => (
  agoraDispatcher.dispatch(new DeleteGroupCommand(params))
)

export const listPendingInvitations = (
  params: ConstructorParameters<typeof ListPendingInvitationsQuery>[0]
) => agoraDispatcher.dispatch(new ListPendingInvitationsQuery(params))

export const inviteHuman = (params: ConstructorParameters<typeof InviteHumanCommand>[0]) => (
  agoraDispatcher.dispatch(new InviteHumanCommand(params))
)

export const acceptInvitation = (
  params: ConstructorParameters<typeof AcceptInvitationCommand>[0]
) => agoraDispatcher.dispatch(new AcceptInvitationCommand(params))

export const rejectInvitation = (
  params: ConstructorParameters<typeof RejectInvitationCommand>[0]
) => agoraDispatcher.dispatch(new RejectInvitationCommand(params))

export const listGroupMembers = (
  params: ConstructorParameters<typeof ListGroupMembersQuery>[0]
) => agoraDispatcher.dispatch(new ListGroupMembersQuery(params))

export const addAgentMember = (
  params: ConstructorParameters<typeof AddAgentMemberCommand>[0]
) => agoraDispatcher.dispatch(new AddAgentMemberCommand(params))

export const removeMember = (params: ConstructorParameters<typeof RemoveMemberCommand>[0]) => (
  agoraDispatcher.dispatch(new RemoveMemberCommand(params))
)

export const getGroupMessages = (
  params: ConstructorParameters<typeof GetGroupMessagesQuery>[0]
) => agoraDispatcher.dispatch(new GetGroupMessagesQuery(params))

export const getUnreadMessages = (
  params: ConstructorParameters<typeof GetUnreadMessagesQuery>[0]
) => agoraDispatcher.dispatch(new GetUnreadMessagesQuery(params))

export const sendMessage = (params: ConstructorParameters<typeof SendMessageCommand>[0]) => (
  agoraDispatcher.dispatch(new SendMessageCommand(params))
)

export const markGroupRead = (
  params: ConstructorParameters<typeof MarkGroupReadCommand>[0]
) => agoraDispatcher.dispatch(new MarkGroupReadCommand(params))
