import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runMessageRpc } from './database.ts'
import { toMessageDto } from './dto.ts'

export const sendMessageHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.sendMessage,
  ({ database, principal }) => async ({ params }) => {
    const rows = await runMessageRpc(database, 'send_agora_message', {
      client_message_id_to_use: params.clientMessageId,
      group_id_to_use: params.groupId,
      message_text_to_use: params.text
    })

    if (rows.length !== 1) {
      throw new Error('Agora message database response is invalid.')
    }

    const message = toMessageDto(rows[0])

    if (message.groupId !== params.groupId || message.sender.id !== principal.principalId) {
      throw new Error('Agora message database response is invalid.')
    }

    return message
  }
)
