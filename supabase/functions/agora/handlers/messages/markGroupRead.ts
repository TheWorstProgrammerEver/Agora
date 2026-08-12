import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runMessageRpc } from './database.ts'
import { toReadWatermarkDto } from './page.ts'

export const markGroupReadHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.markGroupRead,
  ({ database }) => async ({ params }) => {
    const rows = await runMessageRpc(database, 'mark_agora_group_read', {
      group_id_to_mark: params.groupId,
      through_sequence_to_use: params.throughSequence
    })

    if (rows.length !== 1) {
      throw new Error('Agora message database response is invalid.')
    }

    return toReadWatermarkDto(rows[0], params.groupId)
  }
)
