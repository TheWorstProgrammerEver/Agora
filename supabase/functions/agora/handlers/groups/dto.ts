import type {
  GroupDto,
  GroupMemberDto,
  GroupSummaryDto
} from '../../../../../common/agoraDtos.ts'
import {
  type DatabaseRow,
  requirePrincipalKind,
  requireRole,
  requireString,
  requireTimestamp
} from '../shared/databaseRow.ts'

export const toGroupDto = (row: DatabaseRow): GroupDto => ({
  createdAt: requireTimestamp(row, 'created_at'),
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
    createdAt: requireTimestamp(row, 'group_created_at'),
    id: requireString(row, 'group_id'),
    name: requireString(row, 'group_name'),
    ownerPrincipalId: requireString(row, 'owner_principal_id')
  }
  const currentMember: GroupMemberDto = {
    groupId: group.id,
    joinedAt: requireTimestamp(row, 'membership_created_at'),
    principal: {
      displayName: requireString(row, 'principal_display_name'),
      id: requireString(row, 'principal_id'),
      kind: requirePrincipalKind(row, 'principal_kind')
    },
    role: requireRole(row, 'membership_role')
  }

  return { currentMember, group }
}
