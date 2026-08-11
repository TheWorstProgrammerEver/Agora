import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runGroupRpc } from './database.ts'
import { toGroupDto } from './dto.ts'
import { AgoraGroupRequestError } from './error.ts'

export const createGroupHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.createGroup,
  ({ database, principal }) => async ({ params }) => {
    if (principal.kind !== 'human') {
      throw new AgoraGroupRequestError('This group operation is not permitted.', 403)
    }

    const rows = await runGroupRpc(database, 'create_agora_group', {
      name_to_use: params.name
    })

    if (rows.length !== 1) {
      throw new Error('Agora group database response is invalid.')
    }

    return { group: toGroupDto(rows[0]) }
  }
)
