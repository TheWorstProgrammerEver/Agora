import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runGroupRpc } from '../groups/database.ts'
import { AgoraGroupRequestError } from '../groups/error.ts'
import { toInvitationDto } from './dto.ts'

export const inviteHumanHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.inviteHuman,
  ({ database, principal }) => async ({ params }) => {
    if (principal.kind !== 'human') {
      throw new AgoraGroupRequestError('This group operation is not permitted.', 403)
    }

    const rows = await runGroupRpc(database, 'invite_agora_human', {
      email_to_invite: params.email,
      group_id_to_invite: params.groupId
    })

    if (rows.length !== 1) {
      throw new Error('Agora group database response is invalid.')
    }

    return { invitation: toInvitationDto(rows[0]) }
  }
)
