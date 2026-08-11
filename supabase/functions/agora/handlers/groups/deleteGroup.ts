import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { AgoraGroupRequestError } from './error.ts'
import { runGroupRpc } from './database.ts'

export const deleteGroupHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.deleteGroup,
  ({ database, principal }) => async ({ params }) => {
    if (principal.kind !== 'human') {
      throw new AgoraGroupRequestError('This group operation is not permitted.', 403)
    }

    const rows = await runGroupRpc(database, 'delete_agora_group', {
      group_id_to_delete: params.groupId
    })

    if (rows.length !== 1 || typeof rows[0].group_id !== 'string') {
      throw new Error('Agora group database response is invalid.')
    }

    return { groupId: rows[0].group_id }
  }
)
