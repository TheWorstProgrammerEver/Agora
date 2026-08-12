import {
  positiveSequencePattern,
  sequencePattern,
  uuidPattern
} from './constants.mjs'

export const isObject = (value) => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

export const hasExactKeys = (value, required, optional = []) => {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)

  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key))
}

export const isUuid = (value) => typeof value === 'string' && uuidPattern.test(value)
export const isSequence = (value) => (
  typeof value === 'string' && sequencePattern.test(value)
)
export const isPositiveSequence = (value) => (
  typeof value === 'string' && positiveSequencePattern.test(value)
)
export const isIsoTimestamp = (value) => (
  typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value))
)

export const compareSequences = (left, right) => (
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
)

export const maximumSequence = (left, right) => (
  compareSequences(left, right) >= 0 ? left : right
)

export const nextSequence = (sequence) => (BigInt(sequence) + 1n).toString()

export const boundedChunkEnd = (cursor, highWatermark, chunkSize) => {
  const maximum = BigInt(cursor) + BigInt(chunkSize)
  const high = BigInt(highWatermark)

  return (maximum < high ? maximum : high).toString()
}

export const sequenceRangeLength = (fromExclusive, through) => {
  const length = BigInt(through) - BigInt(fromExclusive)

  if (length < 1n || length > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Agora runner sequence range is invalid.')
  }

  return Number(length)
}
