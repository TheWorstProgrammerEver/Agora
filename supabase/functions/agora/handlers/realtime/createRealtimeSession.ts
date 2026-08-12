import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { authorizeRealtimeTopics } from './database.ts'
import {
  issueRealtimeCredential,
  type RealtimeCredentialIssuer
} from './credential.ts'
import { toRealtimeTopicDto } from './dto.ts'
import { AgoraRealtimeRequestError } from './error.ts'

export const createRealtimeSessionHandlerFactory = (
  issueCredential: RealtimeCredentialIssuer = issueRealtimeCredential
) => createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.createRealtimeSession,
  ({ database, principal }) => async ({ params }) => {
    if (principal.kind !== 'agent') {
      throw new AgoraRealtimeRequestError(
        'Agent Realtime sessions require an Agora agent key.',
        403
      )
    }

    const rows = await authorizeRealtimeTopics(database, params.groupIds)
    const topics = rows.map(toRealtimeTopicDto)
    const authorizedGroupIds = topics.map(({ groupId }) => groupId)

    if (topics.length !== params.groupIds.length
      || new Set(authorizedGroupIds).size !== authorizedGroupIds.length
      || authorizedGroupIds.some((groupId) => !params.groupIds.includes(groupId))) {
      throw new Error('Agora Realtime database response is invalid.')
    }

    const credential = await issueCredential({
      groupIds: authorizedGroupIds,
      principalId: principal.principalId
    })

    return { ...credential, topics }
  }
)

export const createRealtimeSessionHandlerFactoryDefault = (
  createRealtimeSessionHandlerFactory()
)
