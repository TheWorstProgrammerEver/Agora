import type { MessageDto, MessageSequence } from '../../common/agoraDtos'

export const compareMessageSequences = (left: MessageSequence, right: MessageSequence) => (
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
)

export const mergeMessages = (current: MessageDto[], incoming: MessageDto[]) => {
  const bySequence = new Map(current.map((message) => [message.sequence, message]))

  incoming.forEach((message) => bySequence.set(message.sequence, message))

  return [...bySequence.values()].sort((left, right) => (
    compareMessageSequences(left.sequence, right.sequence)
  ))
}

export const earliestMessageSequence = (messages: MessageDto[]) => messages[0]?.sequence
export const latestMessageSequence = (messages: MessageDto[]) => messages.at(-1)?.sequence

export const sequenceBefore = (sequence: MessageSequence): MessageSequence => (
  (BigInt(sequence) - 1n).toString()
)

export const laterSequence = (left: MessageSequence, right: MessageSequence) => (
  compareMessageSequences(left, right) >= 0 ? left : right
)

export const isMessageUnread = (message: MessageDto, readThroughSequence: MessageSequence) => (
  compareMessageSequences(message.sequence, readThroughSequence) > 0
)
