import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runGroupRpc } from '../groups/database.ts'
import { AgoraGroupRequestError } from '../groups/error.ts'

export const rejectInvitationHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.rejectInvitation,
  ({ database, principal }) => async ({ params }) => {
    if (principal.kind !== 'human') {
      throw new AgoraGroupRequestError('This group operation is not permitted.', 403)
    }

    const rows = await runGroupRpc(database, 'reject_agora_invitation', {
      invitation_id_to_reject: params.invitationId
    })

    if (rows.length !== 1
      || typeof rows[0].group_id !== 'string'
      || typeof rows[0].invitation_id !== 'string') {
      throw new Error('Agora group database response is invalid.')
    }

    return {
      groupId: rows[0].group_id,
      invitationId: rows[0].invitation_id
    }
  }
)
