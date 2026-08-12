import { maximumGroupPages } from './constants.mjs'
import {
  compareSequences,
  nextSequence,
  sequenceRangeLength
} from './value-validation.mjs'

export const listAllGroups = async (api, signal) => {
  const groups = []
  const seenCursors = new Set()
  let cursor

  for (let pageNumber = 0; pageNumber < maximumGroupPages; pageNumber += 1) {
    const page = await api.invoke('listGroups', {
      ...(cursor ? { cursor } : {}),
      limit: 100
    }, { signal })
    groups.push(...page.items)

    if (!page.nextCursor) return groups
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('Agora group pagination repeated a cursor.')
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error('Agora group pagination exceeded its safety bound.')
}

export const getAgentPrincipalId = async (api, groupId, signal) => {
  const result = await api.invoke('getGroup', { groupId }, { signal })

  if (result.currentMember.principal.kind !== 'agent') {
    throw new Error('Agora runner credential did not resolve to an agent principal.')
  }

  return result.currentMember.principal.id
}

export const createRealtimeSessions = async (api, groupIds, signal) => {
  const sessions = []

  for (let index = 0; index < groupIds.length; index += 32) {
    const requested = groupIds.slice(index, index + 32)
    const session = await api.invoke('createRealtimeSession', { groupIds: requested }, { signal })
    const returned = new Set(session.topics.map(({ groupId }) => groupId))

    if (returned.size !== requested.length || requested.some((groupId) => !returned.has(groupId))) {
      throw new Error('Agora Realtime session omitted an authorized group.')
    }

    sessions.push(session)
  }

  return sessions
}

export const reconcileSnapshot = async (api, signal) => {
  const summaries = await listAllGroups(api, signal)

  if (summaries.length === 0) {
    return { groups: [], principalId: undefined, sessions: [] }
  }

  const principalId = await getAgentPrincipalId(api, summaries[0].id, signal)
  const sessions = await createRealtimeSessions(
    api,
    summaries.map(({ id }) => id),
    signal
  )
  const highWatermarks = new Map(sessions.flatMap(({ topics }) => (
    topics.map(({ groupId, highWatermarkSequence }) => [groupId, highWatermarkSequence])
  )))
  const groups = summaries.map(({ id, unreadCount }) => {
    const highWatermarkSequence = highWatermarks.get(id)
    if (highWatermarkSequence === undefined) {
      throw new Error('Agora Realtime snapshot is incomplete.')
    }
    return { highWatermarkSequence, id, unreadCount }
  })

  return { groups, principalId, sessions }
}

export const fetchExactChunk = async (api, groupId, lease, signal) => {
  const expectedLength = sequenceRangeLength(lease.fromExclusive, lease.through)
  const page = await api.invoke('getGroupMessages', {
    afterSequence: lease.fromExclusive,
    groupId,
    limit: expectedLength
  }, { signal })

  if (page.items.length !== expectedLength) {
    throw new Error('Agora leased message range is unavailable.')
  }

  let expected = nextSequence(lease.fromExclusive)
  for (const message of page.items) {
    if (message.groupId !== groupId || message.sequence !== expected) {
      throw new Error('Agora leased message range is invalid.')
    }
    expected = nextSequence(expected)
  }

  if (page.items.at(-1)?.sequence !== lease.through) {
    throw new Error('Agora leased message range is incomplete.')
  }

  return page.items
}

export const sendPlannedMessages = async (
  api,
  { chunkId, groupId, messages, principalId },
  signal
) => {
  for (const [index, message] of messages.entries()) {
    const clientMessageId = `agora-runner-v1-${chunkId}-${index + 1}`
    const sent = await api.invoke('sendMessage', {
      clientMessageId,
      groupId,
      text: message.text
    }, { signal })

    if (sent.groupId !== groupId
      || sent.sender.id !== principalId
      || sent.sender.kind !== 'agent'
      || sent.text !== message.text) {
      throw new Error('Agora idempotent send response is invalid.')
    }
  }
}

export const acknowledgeRange = async (api, groupId, through, signal) => {
  const watermark = await api.invoke('markGroupRead', {
    groupId,
    throughSequence: through
  }, { signal })

  if (watermark.groupId !== groupId || compareSequences(watermark.sequence, through) < 0) {
    throw new Error('Agora read acknowledgement response is invalid.')
  }

  return watermark
}
