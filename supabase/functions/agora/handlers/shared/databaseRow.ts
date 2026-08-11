import type {
  GroupRole,
  PrincipalKind
} from '../../../../../common/agoraDtos.ts'

export type DatabaseRow = Record<string, unknown>

export const requireString = (row: DatabaseRow, key: string) => {
  const value = row[key]

  if (typeof value !== 'string') {
    throw new Error('Agora group database response is invalid.')
  }

  return value
}

export const requirePrincipalKind = (row: DatabaseRow, key: string): PrincipalKind => {
  const value = requireString(row, key)

  if (value !== 'agent' && value !== 'human') {
    throw new Error('Agora group database response is invalid.')
  }

  return value
}

export const requireRole = (row: DatabaseRow, key: string): GroupRole => {
  const value = requireString(row, key)

  if (value !== 'member' && value !== 'owner') {
    throw new Error('Agora group database response is invalid.')
  }

  return value
}

export const requireTimestamp = (row: DatabaseRow, key: string) => {
  const value = requireString(row, key)

  if (Number.isNaN(Date.parse(value))) {
    throw new Error('Agora group database response is invalid.')
  }

  return value
}
