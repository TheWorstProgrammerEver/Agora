import { defaultMessagePageSize } from '../../../../../common/agoraMessageLimits.ts'
import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runMessageRpc } from './database.ts'
import { toMessagePage } from './page.ts'

export const getUnreadMessagesHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.getUnreadMessages,
  ({ database }) => async ({ params }) => {
    const rows = await runMessageRpc(database, 'get_agora_unread_messages', {
      after_sequence_to_use: params.afterSequence,
      group_id_to_get: params.groupId,
      page_size: params.limit ?? defaultMessagePageSize
    })

    return toMessagePage(rows, params.groupId, 'forward')
  }
)
