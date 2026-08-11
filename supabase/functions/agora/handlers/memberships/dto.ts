import type {
  GroupMemberDto,
  InvitationDto,
  PrincipalDto
} from '../../../../../common/agoraDtos.ts'
import {
  type DatabaseRow,
  requirePrincipalKind,
  requireRole,
  requireString,
  requireTimestamp
} from '../shared/databaseRow.ts'

const toPrincipalDto = (
  row: DatabaseRow,
  prefix: 'invited_by' | 'principal'
): PrincipalDto => ({
  displayName: requireString(row, `${prefix}_display_name`),
  id: requireString(row, prefix === 'principal' ? 'principal_id' : 'invited_by_principal_id'),
  kind: requirePrincipalKind(row, `${prefix}_kind`)
})

export const toInvitationDto = (row: DatabaseRow): InvitationDto => ({
  createdAt: requireTimestamp(row, 'invitation_created_at'),
  email: requireString(row, 'invitation_email'),
  group: {
    id: requireString(row, 'group_id'),
    name: requireString(row, 'group_name')
  },
  id: requireString(row, 'invitation_id'),
  invitedBy: toPrincipalDto(row, 'invited_by')
})

export const toGroupMemberDto = (row: DatabaseRow): GroupMemberDto => ({
  groupId: requireString(row, 'group_id'),
  joinedAt: requireTimestamp(row, 'membership_created_at'),
  principal: toPrincipalDto(row, 'principal'),
  role: requireRole(row, 'membership_role')
})
