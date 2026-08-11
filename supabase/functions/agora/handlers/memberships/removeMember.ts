import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runGroupRpc } from '../groups/database.ts'
import { AgoraGroupRequestError } from '../groups/error.ts'

export const removeMemberHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.removeMember,
  ({ database, principal }) => async ({ params }) => {
    if (principal.kind !== 'human') {
      throw new AgoraGroupRequestError('This group operation is not permitted.', 403)
    }

    const rows = await runGroupRpc(database, 'remove_agora_group_member', {
      group_id_to_update: params.groupId,
      principal_id_to_remove: params.principalId
    })

    if (rows.length !== 1
      || typeof rows[0].group_id !== 'string'
      || typeof rows[0].principal_id !== 'string') {
      throw new Error('Agora group database response is invalid.')
    }

    return {
      groupId: rows[0].group_id,
      principalId: rows[0].principal_id
    }
  }
)
