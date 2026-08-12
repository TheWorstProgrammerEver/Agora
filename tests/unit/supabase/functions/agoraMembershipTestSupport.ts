import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'

export const membershipCreatedAt = '2026-08-12T00:00:00.654321+00:00'

export const createMembershipContext = (
  kind: 'agent' | 'human',
  responses: Array<{ data: unknown, error: unknown }>
) => {
  const rpc = vi.fn(async (
    _name: string,
    _params?: Record<string, unknown>
  ) => responses.shift() ?? { data: [], error: null })

  return {
    context: {
      database: { rpc },
      principal: { kind, principalId: randomUUID() }
    },
    rpc
  }
}

export const invitationRow = (overrides: Record<string, unknown> = {}) => ({
  group_id: randomUUID(),
  group_name: 'Invited group',
  has_more: false,
  invitation_created_at: membershipCreatedAt,
  invitation_email: 'invitee@example.test',
  invitation_id: randomUUID(),
  invited_by_display_name: 'Group owner',
  invited_by_kind: 'human',
  invited_by_principal_id: randomUUID(),
  ...overrides
})

export const memberRow = (overrides: Record<string, unknown> = {}) => ({
  group_id: randomUUID(),
  has_more: false,
  membership_created_at: membershipCreatedAt,
  membership_id: randomUUID(),
  membership_role: 'member',
  principal_display_name: 'Group member',
  principal_id: randomUUID(),
  principal_kind: 'human',
  ...overrides
})
