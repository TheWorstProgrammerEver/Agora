import type { AgoraRequestHandlerFactory } from '../factory.ts'
import { acceptInvitationHandlerFactory } from './acceptInvitation.ts'
import { addAgentMemberHandlerFactory } from './addAgentMember.ts'
import { inviteHumanHandlerFactory } from './inviteHuman.ts'
import { listGroupMembersHandlerFactory } from './listGroupMembers.ts'
import { listPendingInvitationsHandlerFactory } from './listPendingInvitations.ts'
import { rejectInvitationHandlerFactory } from './rejectInvitation.ts'
import { removeMemberHandlerFactory } from './removeMember.ts'

export const membershipHandlerFactories: AgoraRequestHandlerFactory[] = [
  acceptInvitationHandlerFactory,
  addAgentMemberHandlerFactory,
  inviteHumanHandlerFactory,
  listGroupMembersHandlerFactory,
  listPendingInvitationsHandlerFactory,
  rejectInvitationHandlerFactory,
  removeMemberHandlerFactory
]
