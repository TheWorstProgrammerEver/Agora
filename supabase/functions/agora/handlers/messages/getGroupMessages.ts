import { defaultMessagePageSize } from '../../../../../common/agoraMessageLimits.ts'
import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runMessageRpc } from './database.ts'
import { toMessagePage } from './page.ts'

export const getGroupMessagesHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.getGroupMessages,
  ({ database }) => async ({ params }) => {
    const rows = await runMessageRpc(database, 'get_agora_group_messages', {
      after_sequence_to_use: params.afterSequence,
      around_sequence_to_use: params.aroundSequence,
      before_sequence_to_use: params.beforeSequence,
      group_id_to_get: params.groupId,
      page_size: params.limit ?? defaultMessagePageSize
    })
    const direction = params.aroundSequence !== undefined
      ? 'around'
      : params.afterSequence !== undefined
        ? 'forward'
        : 'backward'

    return toMessagePage(rows, params.groupId, direction)
  }
)
