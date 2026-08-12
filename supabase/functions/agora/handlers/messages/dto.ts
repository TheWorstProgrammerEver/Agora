import type { MessageDto } from '../../../../../common/agoraDtos.ts'
import {
  type DatabaseRow,
  requirePrincipalKind,
  requireString,
  requireTimestamp
} from '../shared/databaseRow.ts'

export const toMessageDto = (row: DatabaseRow): MessageDto => ({
  createdAt: requireTimestamp(row, 'message_created_at'),
  groupId: requireString(row, 'message_group_id'),
  id: requireString(row, 'message_id'),
  sender: {
    displayName: requireString(row, 'sender_display_name'),
    id: requireString(row, 'sender_principal_id'),
    kind: requirePrincipalKind(row, 'sender_kind')
  },
  sequence: requireString(row, 'message_sequence'),
  text: requireString(row, 'message_text')
})
