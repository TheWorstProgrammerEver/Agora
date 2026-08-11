import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { agoraRequestIdentifiers } from '../../../../common/agoraRequestIdentifiers'
import { createAgoraDispatcher } from '../../../../supabase/functions/agora/dispatcher'
import { decodeKeysetCursor } from '../../../../supabase/functions/agora/handlers/shared/cursor'
import {
  createMembershipContext,
  invitationRow,
  memberRow,
  membershipCreatedAt
} from './agoraMembershipTestSupport'

describe('Agora invitation handlers', () => {
  it('runs invite, list, accept, and reject through only the in-app database boundary', async () => {
    const invitation = invitationRow()
    const member = memberRow({ group_id: invitation.group_id })
    const { context, rpc } = createMembershipContext('human', [
      { data: [invitation], error: null },
      { data: [{ ...invitation, has_more: true }], error: null },
      {
        data: [{ ...member, invitation_id: invitation.invitation_id }],
        error: null
      },
      {
        data: [{
          group_id: invitation.group_id,
          invitation_id: invitation.invitation_id
        }],
        error: null
      }
    ])
    const dispatcher = createAgoraDispatcher(context)

    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.inviteHuman,
      params: { email: ' INVITEE@example.test ', groupId: String(invitation.group_id) }
    })).resolves.toEqual({
      invitation: {
        createdAt: membershipCreatedAt,
        email: invitation.invitation_email,
        group: { id: invitation.group_id, name: invitation.group_name },
        id: invitation.invitation_id,
        invitedBy: {
          displayName: invitation.invited_by_display_name,
          id: invitation.invited_by_principal_id,
          kind: 'human'
        }
      }
    })

    const page = await dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.listPendingInvitations,
      params: { limit: 1 }
    }) as { items: unknown[], nextCursor?: string }

    expect(page.items).toHaveLength(1)
    expect(decodeKeysetCursor(page.nextCursor ?? '', 'Invitation')).toEqual({
      createdAt: membershipCreatedAt,
      id: invitation.invitation_id
    })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.acceptInvitation,
      params: { invitationId: String(invitation.invitation_id) }
    })).resolves.toMatchObject({
      groupId: invitation.group_id,
      invitationId: invitation.invitation_id,
      member: { groupId: invitation.group_id }
    })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.rejectInvitation,
      params: { invitationId: String(invitation.invitation_id) }
    })).resolves.toEqual({
      groupId: invitation.group_id,
      invitationId: invitation.invitation_id
    })

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'invite_agora_human',
      'list_agora_pending_invitations',
      'accept_agora_invitation',
      'reject_agora_invitation'
    ])
  })

  it('rejects malformed invitation cursors before database access', async () => {
    const { context, rpc } = createMembershipContext('human', [])

    await expect(createAgoraDispatcher(context).dispatch({
      identifier: agoraRequestIdentifiers.listPendingInvitations,
      params: { cursor: 'not-a-valid-cursor' }
    })).rejects.toMatchObject({ status: 400 })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('denies every human invitation transition to agents before database access', async () => {
    const { context, rpc } = createMembershipContext('agent', [])
    const dispatcher = createAgoraDispatcher(context)
    const invitationId = randomUUID()
    const groupId = randomUUID()

    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.inviteHuman,
      params: { email: 'invitee@example.test', groupId }
    })).rejects.toMatchObject({ status: 403 })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.listPendingInvitations,
      params: {}
    })).rejects.toMatchObject({ status: 403 })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.acceptInvitation,
      params: { invitationId }
    })).rejects.toMatchObject({ status: 403 })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.rejectInvitation,
      params: { invitationId }
    })).rejects.toMatchObject({ status: 403 })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('maps resolved and conflicting invitation states to recoverable errors', async () => {
    const invitationId = randomUUID()
    const { context } = createMembershipContext('human', [
      { data: null, error: { code: 'P0002', message: 'private detail' } },
      { data: null, error: { code: '55000', message: 'private detail' } }
    ])
    const dispatcher = createAgoraDispatcher(context)

    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.acceptInvitation,
      params: { invitationId }
    })).rejects.toMatchObject({ status: 404 })
    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.inviteHuman,
      params: { email: 'active@example.test', groupId: randomUUID() }
    })).rejects.toMatchObject({ status: 409 })
  })
})
