import { describe, expect, it } from 'vitest'
import type { GroupDto, GroupMemberDto, GroupSummaryDto, InvitationDto } from '../../../common/agoraDtos'
import {
  appendMemberPage,
  appendPageById,
  prependById,
  removeById,
  removeMemberByPrincipalId,
  summarizeGroup,
  upsertMember
} from '../../../src/state/groupStateUpdates'

const group: GroupDto = {
  createdAt: '2026-08-12T00:00:00Z',
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Launch room',
  ownerPrincipalId: '22222222-2222-4222-8222-222222222222'
}

const invitation: InvitationDto = {
  createdAt: '2026-08-12T00:00:00Z',
  email: 'human@example.test',
  group: { id: group.id, name: group.name },
  id: '33333333-3333-4333-8333-333333333333',
  invitedBy: {
    displayName: 'Owner',
    id: group.ownerPrincipalId,
    kind: 'human'
  }
}

const member = (id: string, displayName: string): GroupMemberDto => ({
  groupId: group.id,
  joinedAt: '2026-08-12T00:00:00Z',
  principal: { displayName, id, kind: 'agent' },
  role: 'member'
})

describe('group UI state updates', () => {
  it('reconciles an accepted invitation with one targeted group result', () => {
    const existingGroup: GroupSummaryDto = {
      ...group,
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Existing',
      unreadCount: 2
    }
    expect(prependById([existingGroup], summarizeGroup(group))).toEqual([
      summarizeGroup(group),
      existingGroup
    ])
    expect(removeById([invitation], invitation.id)).toEqual([])
  })

  it('deduplicates paginated results while preserving the newest DTO', () => {
    const original = { ...summarizeGroup(group), name: 'Old name' }
    const updated = { ...summarizeGroup(group), name: 'New name' }

    expect(appendPageById([original], [updated])).toEqual([updated])
  })

  it('reconciles minimal add and remove member command results', () => {
    const first = member('55555555-5555-4555-8555-555555555555', 'Agent One')
    const updated = { ...first, principal: { ...first.principal, displayName: 'Agent Updated' } }
    const second = member('66666666-6666-4666-8666-666666666666', 'Agent Two')

    expect(upsertMember([first], updated)).toEqual([updated])
    expect(appendMemberPage([updated], [updated, second])).toEqual([updated, second])
    expect(removeMemberByPrincipalId([updated, second], updated.principal.id)).toEqual([second])
  })
})
