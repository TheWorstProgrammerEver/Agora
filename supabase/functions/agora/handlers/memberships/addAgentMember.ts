import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runGroupRpc } from '../groups/database.ts'
import { AgoraGroupRequestError } from '../groups/error.ts'
import { toGroupMemberDto } from './dto.ts'

export const addAgentMemberHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.addAgentMember,
  ({ database, principal }) => async ({ params }) => {
    if (principal.kind !== 'human') {
      throw new AgoraGroupRequestError('This group operation is not permitted.', 403)
    }

    const rows = await runGroupRpc(database, 'add_agora_agent_member', {
      agent_principal_id_to_add: params.agentPrincipalId,
      group_id_to_update: params.groupId
    })

    if (rows.length !== 1) {
      throw new Error('Agora group database response is invalid.')
    }

    return { member: toGroupMemberDto(rows[0]) }
  }
)
