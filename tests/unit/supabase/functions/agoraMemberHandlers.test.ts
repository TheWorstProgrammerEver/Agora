import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { agoraRequestIdentifiers } from '../../../../common/agoraRequestIdentifiers'
import { createAgoraDispatcher } from '../../../../supabase/functions/agora/dispatcher'
import { decodeKeysetCursor } from '../../../../supabase/functions/agora/handlers/shared/cursor'
import {
  createMembershipContext,
  memberRow,
  membershipCreatedAt
} from './agoraMembershipTestSupport'

describe('Agora active-member handlers', () => {
  it('lists members with a stable hidden membership cursor and minimal mutation results', async () => {
    const member = memberRow({ has_more: true, principal_kind: 'agent' })
    const { context, rpc } = createMembershipContext('human', [
      { data: [member], error: null },
      { data: [member], error: null },
      {
        data: [{ group_id: member.group_id, principal_id: member.principal_id }],
        error: null
      }
    ])
    const dispatcher = createAgoraDispatcher(context)
    const page = await dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.listGroupMembers,
      params: { groupId: String(member.group_id), limit: 1 }
    }) as { items: unknown[], nextCursor?: string }

    expect(page.items).toEqual([expect.objectContaining({
      groupId: member.group_id,
      joinedAt: membershipCreatedAt,
      principal: expect.objectContaining({ id: member.principal_id, kind: 'agent' })
    })])
    expect(decodeKeysetCursor(page.nextCursor ?? '', 'Member')).toEqual({
      createdAt: membershipCreatedAt,
      id: member.membership_id
    })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.addAgentMember,
      params: {
        agentPrincipalId: String(member.principal_id),
        groupId: String(member.group_id)
      }
    })).resolves.toEqual({ member: expect.objectContaining({ groupId: member.group_id }) })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.removeMember,
      params: {
        groupId: String(member.group_id),
        principalId: String(member.principal_id)
      }
    })).resolves.toEqual({
      groupId: member.group_id,
      principalId: member.principal_id
    })
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'list_agora_group_members',
      'add_agora_agent_member',
      'remove_agora_group_member'
    ])
  })

  it('allows an active agent member query but denies agent management', async () => {
    const member = memberRow({ principal_kind: 'agent' })
    const { context, rpc } = createMembershipContext('agent', [{ data: [member], error: null }])
    const dispatcher = createAgoraDispatcher(context)

    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.listGroupMembers,
      params: { groupId: String(member.group_id) }
    })).resolves.toEqual({ items: [expect.objectContaining({ groupId: member.group_id })] })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.addAgentMember,
      params: { agentPrincipalId: randomUUID(), groupId: String(member.group_id) }
    })).rejects.toMatchObject({ status: 403 })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.removeMember,
      params: { groupId: String(member.group_id), principalId: randomUUID() }
    })).rejects.toMatchObject({ status: 403 })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed member cursors before database access', async () => {
    const { context, rpc } = createMembershipContext('human', [])

    await expect(createAgoraDispatcher(context).dispatch({
      identifier: agoraRequestIdentifiers.listGroupMembers,
      params: { cursor: 'not-a-valid-cursor', groupId: randomUUID() }
    })).rejects.toMatchObject({ status: 400 })
    expect(rpc).not.toHaveBeenCalled()
  })
})
