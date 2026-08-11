import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runGroupRpc } from './database.ts'
import { toGetGroupResult } from './dto.ts'
import { AgoraGroupRequestError } from './error.ts'

export const getGroupHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.getGroup,
  ({ database }) => async ({ params }) => {
    const rows = await runGroupRpc(database, 'get_agora_group', {
      group_id_to_get: params.groupId
    })

    if (rows.length === 0) {
      throw new AgoraGroupRequestError('Group was not found or is unavailable.', 404)
    }

    if (rows.length !== 1) {
      throw new Error('Agora group database response is invalid.')
    }

    return toGetGroupResult(rows[0])
  }
)
