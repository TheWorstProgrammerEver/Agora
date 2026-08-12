import type { RealtimeTopicDto } from '../../../../../common/agoraDtos.ts'
import { formatAgoraRealtimeTopic } from '../../../../../common/agoraRealtime.ts'

const requireString = (row: Record<string, unknown>, key: string) => {
  const value = row[key]

  if (typeof value !== 'string') {
    throw new Error('Agora Realtime database response is invalid.')
  }

  return value
}

export const toRealtimeTopicDto = (row: Record<string, unknown>): RealtimeTopicDto => {
  const groupId = requireString(row, 'topic_group_id')
  const highWatermarkSequence = requireString(row, 'high_watermark_sequence')

  if (!/^(?:0|[1-9]\d*)$/.test(highWatermarkSequence)) {
    throw new Error('Agora Realtime database response is invalid.')
  }

  return {
    groupId,
    highWatermarkSequence,
    topic: formatAgoraRealtimeTopic(groupId)
  }
}
