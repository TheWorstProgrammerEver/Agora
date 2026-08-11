import { defaultMemberListPageSize } from '../../../../../common/agoraGroupLimits.ts'
import { agoraRequestIdentifiers } from '../../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from '../factory.ts'
import { runGroupRpc } from '../groups/database.ts'
import {
  decodeKeysetCursor,
  encodeKeysetCursor
} from '../shared/cursor.ts'
import { requireString } from '../shared/databaseRow.ts'
import { toGroupMemberDto } from './dto.ts'

export const listGroupMembersHandlerFactory = createAgoraRequestHandlerFactory(
  agoraRequestIdentifiers.listGroupMembers,
  ({ database }) => async ({ params }) => {
    const cursor = params.cursor ? decodeKeysetCursor(params.cursor, 'Member') : undefined
    const rows = await runGroupRpc(database, 'list_agora_group_members', {
      cursor_created_at: cursor?.createdAt,
      cursor_membership_id: cursor?.id,
      group_id_to_list: params.groupId,
      page_size: params.limit ?? defaultMemberListPageSize
    })
    const items = rows.map(toGroupMemberDto)
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
          createdAt: items.at(-1)!.joinedAt,
          id: requireString(lastRow, 'membership_id')
        })
      } : {})
    }
  }
)
