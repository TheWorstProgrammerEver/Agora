import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetCursor
} from '../shared/cursor.ts'

export type GroupCursor = KeysetCursor

export const encodeGroupCursor = encodeKeysetCursor
export const decodeGroupCursor = (cursor: string) => decodeKeysetCursor(cursor, 'Group')
