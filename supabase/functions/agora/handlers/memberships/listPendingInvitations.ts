import {
  defaultInvitationListPageSize
} from '../../../../../common/agoraGroupLimits.ts'
import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runGroupRpc } from '../groups/database.ts'
import { AgoraGroupRequestError } from '../groups/error.ts'
import {
  decodeKeysetCursor,
  encodeKeysetCursor
} from '../shared/cursor.ts'
import { requireString } from '../shared/databaseRow.ts'
import { toInvitationDto } from './dto.ts'

export const listPendingInvitationsHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.listPendingInvitations,
  ({ database, principal }) => async ({ params }) => {
    if (principal.kind !== 'human') {
      throw new AgoraGroupRequestError('This group operation is not permitted.', 403)
    }

    const cursor = params.cursor
      ? decodeKeysetCursor(params.cursor, 'Invitation')
      : undefined
    const rows = await runGroupRpc(database, 'list_agora_pending_invitations', {
      cursor_created_at: cursor?.createdAt,
      cursor_invitation_id: cursor?.id,
      page_size: params.limit ?? defaultInvitationListPageSize
    })
    const items = rows.map(toInvitationDto)
    const lastRow = rows.at(-1)
    const hasMore = rows.length > 0 ? rows[0].has_more : false

    if (typeof hasMore !== 'boolean'
      || rows.some((row) => row.has_more !== hasMore)) {
      throw new Error('Agora group database response is invalid.')
    }

    return {
      items,
      ...(hasMore && lastRow ? {
        nextCursor: encodeKeysetCursor({
          createdAt: items.at(-1)!.createdAt,
          id: requireString(lastRow, 'invitation_id')
        })
      } : {})
    }
  }
)
