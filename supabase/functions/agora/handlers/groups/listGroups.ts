import {
  defaultGroupListPageSize
} from '../../../../../common/agoraGroupLimits.ts'
import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { decodeGroupCursor, encodeGroupCursor } from './cursor.ts'
import { runGroupRpc } from './database.ts'
import { toGroupSummaryDto } from './dto.ts'

export const listGroupsHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.listGroups,
  ({ database }) => async ({ params }) => {
    const cursor = params.cursor ? decodeGroupCursor(params.cursor) : undefined
    const rows = await runGroupRpc(database, 'list_agora_groups', {
      cursor_created_at: cursor?.createdAt,
      cursor_group_id: cursor?.id,
      page_size: params.limit ?? defaultGroupListPageSize
    })
    const items = rows.map(toGroupSummaryDto)
    const last = items.at(-1)
    const hasMore = rows.length > 0 ? rows[0].has_more : false

    if (typeof hasMore !== 'boolean'
      || rows.some((row) => row.has_more !== hasMore)) {
      throw new Error('Agora group database response is invalid.')
    }

    return {
      items,
      ...(hasMore && last ? {
        nextCursor: encodeGroupCursor({ createdAt: last.createdAt, id: last.id })
      } : {})
    }
  }
)
