import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runGroupRpc } from '../groups/database.ts'
import { AgoraGroupRequestError } from '../groups/error.ts'
import { requireString } from '../shared/databaseRow.ts'
import { toGroupMemberDto } from './dto.ts'

export const acceptInvitationHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.acceptInvitation,
  ({ database, principal }) => async ({ params }) => {
    if (principal.kind !== 'human') {
      throw new AgoraGroupRequestError('This group operation is not permitted.', 403)
    }

    const rows = await runGroupRpc(database, 'accept_agora_invitation', {
      invitation_id_to_accept: params.invitationId
    })

    if (rows.length !== 1) {
      throw new Error('Agora group database response is invalid.')
    }

    return {
      groupId: requireString(rows[0], 'group_id'),
      invitationId: requireString(rows[0], 'invitation_id'),
      member: toGroupMemberDto(rows[0])
    }
  }
)
