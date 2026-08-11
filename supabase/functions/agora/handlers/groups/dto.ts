import type {
  GroupDto,
  GroupMemberDto,
  GroupSummaryDto,
  PrincipalKind
} from '../../../../../common/agoraDtos.ts'

type DatabaseRow = Record<string, unknown>

const requireString = (row: DatabaseRow, key: string) => {
  const value = row[key]

  if (typeof value !== 'string') {
    throw new Error('Agora group database response is invalid.')
  }

  return value
}

const requirePrincipalKind = (row: DatabaseRow, key: string): PrincipalKind => {
  const value = requireString(row, key)

  if (value !== 'agent' && value !== 'human') {
    throw new Error('Agora group database response is invalid.')
  }

  return value
}

const requireRole = (row: DatabaseRow, key: string) => {
  const value = requireString(row, key)

  if (value !== 'member' && value !== 'owner') {
    throw new Error('Agora group database response is invalid.')
  }

  return value
}

const timestamp = (row: DatabaseRow, key: string) => {
  const value = requireString(row, key)

  if (Number.isNaN(Date.parse(value))) {
    throw new Error('Agora group database response is invalid.')
  }

  return value
}

export const toGroupDto = (row: DatabaseRow): GroupDto => ({
  createdAt: timestamp(row, 'created_at'),
  id: requireString(row, 'id'),
  name: requireString(row, 'name'),
  ownerPrincipalId: requireString(row, 'owner_principal_id')
})

export const toGroupSummaryDto = (row: DatabaseRow): GroupSummaryDto => {
  const unreadCount = row.unread_count

  if (typeof unreadCount !== 'number' || !Number.isSafeInteger(unreadCount) || unreadCount < 0) {
    throw new Error('Agora group database response is invalid.')
  }

  return { ...toGroupDto(row), unreadCount }
}

export const toGetGroupResult = (row: DatabaseRow) => {
  const group = {
    createdAt: timestamp(row, 'group_created_at'),
    id: requireString(row, 'group_id'),
    name: requireString(row, 'group_name'),
    ownerPrincipalId: requireString(row, 'owner_principal_id')
  }
  const currentMember: GroupMemberDto = {
    groupId: group.id,
    joinedAt: timestamp(row, 'membership_created_at'),
    principal: {
      displayName: requireString(row, 'principal_display_name'),
      id: requireString(row, 'principal_id'),
      kind: requirePrincipalKind(row, 'principal_kind')
    },
    role: requireRole(row, 'membership_role')
  }

  return { currentMember, group }
}
