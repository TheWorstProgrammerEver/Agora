import type { MessageSequence } from '../../../common/agoraDtos'

export type GroupAvailabilityHint = {
  groupId: string
  highWatermarkSequence: MessageSequence
}

export const parseGroupAvailabilityHint = (value: unknown): GroupAvailabilityHint | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const { groupId, highWatermarkSequence } = value as Record<string, unknown>

  if (typeof groupId !== 'string'
    || typeof highWatermarkSequence !== 'string'
    || !/^(?:0|[1-9]\d*)$/.test(highWatermarkSequence)) {
    return undefined
  }

  return { groupId, highWatermarkSequence }
}
