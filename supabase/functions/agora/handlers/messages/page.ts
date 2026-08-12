import type { CursorPage, MessageDto } from '../../../../../common/agoraDtos.ts'
import { requireString } from '../shared/databaseRow.ts'
import { toMessageDto } from './dto.ts'

type MessagePageDirection = 'backward' | 'forward' | 'around'

const requireSequence = (sequence: string) => {
  if (!/^[1-9]\d*$/.test(sequence)) {
    throw new Error('Agora message database response is invalid.')
  }

  return BigInt(sequence)
}

export const toMessagePage = (
  rows: Record<string, unknown>[],
  groupId: string,
  direction: MessagePageDirection
): CursorPage<MessageDto> => {
  const items = rows.map(toMessageDto)
  const hasMore = rows.length > 0 ? rows[0].has_more : false

  if (typeof hasMore !== 'boolean'
    || rows.some((row) => row.has_more !== hasMore)
    || items.some((message) => message.groupId !== groupId)) {
    throw new Error('Agora message database response is invalid.')
  }

  const sequences = items.map(({ sequence }) => requireSequence(sequence))

  if (sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1])) {
    throw new Error('Agora message database response is invalid.')
  }

  const cursorItem = direction === 'backward' ? items[0] : items.at(-1)

  return {
    items,
    ...(direction !== 'around' && hasMore && cursorItem ? {
      nextCursor: cursorItem.sequence
    } : {})
  }
}

export const toReadWatermarkDto = (row: Record<string, unknown>, groupId: string) => {
  const watermarkGroupId = requireString(row, 'watermark_group_id')
  const sequence = requireString(row, 'watermark_sequence')

  if (watermarkGroupId !== groupId || !/^[1-9]\d*$/.test(sequence)) {
    throw new Error('Agora message database response is invalid.')
  }

  return { groupId: watermarkGroupId, sequence }
}
