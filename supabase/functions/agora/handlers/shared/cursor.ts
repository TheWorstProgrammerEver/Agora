import { AgoraGroupRequestError } from '../groups/error.ts'

export type KeysetCursor = {
  createdAt: string
  id: string
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

const invalidCursor = (subject: string) => new AgoraGroupRequestError(
  `${subject} cursor is invalid.`,
  400
)

export const encodeKeysetCursor = ({ createdAt, id }: KeysetCursor) => btoa(JSON.stringify({
  createdAt,
  id
})).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

export const decodeKeysetCursor = (cursor: string, subject: string): KeysetCursor => {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) {
    throw invalidCursor(subject)
  }

  try {
    const padded = cursor.replaceAll('-', '+').replaceAll('_', '/').padEnd(
      Math.ceil(cursor.length / 4) * 4,
      '='
    )
    const value = JSON.parse(atob(padded)) as Record<string, unknown>

    if (Object.keys(value).length !== 2
      || typeof value.createdAt !== 'string'
      || typeof value.id !== 'string'
      || !uuidPattern.test(value.id)
      || !timestampPattern.test(value.createdAt)
      || Number.isNaN(Date.parse(value.createdAt))) {
      throw invalidCursor(subject)
    }

    return { createdAt: value.createdAt, id: value.id }
  } catch (error) {
    if (error instanceof AgoraGroupRequestError) {
      throw error
    }

    throw invalidCursor(subject)
  }
}
