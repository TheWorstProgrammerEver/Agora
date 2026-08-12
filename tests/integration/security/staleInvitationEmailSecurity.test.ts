import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgoraRequestResult } from '../../../common/agoraRequestContract'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'
import {
  cleanupGroupLifecycleFixtures,
  createGroup,
  createGroupLifecycleFixtures,
  groupLifecycleAdmin as admin,
  postHuman,
  selectCount,
  type GroupLifecycleFixtures
} from './groupLifecycleTestSupport'
import { signInHumanFixture } from './humanFixture'

let fixtures: GroupLifecycleFixtures | undefined

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('invitation email authorization freshness', () => {
  it('uses current Auth email when the access token email is stale', async () => {
    if (!fixtures) {
      throw new Error('Stale invitation email fixtures were not created.')
    }

    const { member: invitee, owner } = fixtures
    const formerEmail = invitee.email
    const currentEmail = `agora-current-email-${randomUUID()}@example.test`
    const staleSession = await invitee.client.auth.getSession()
    const staleAccessToken = staleSession.data.session?.access_token
    const groups = await Promise.all([
      createGroup(owner, 'Former email invitation group'),
      createGroup(owner, 'Current email acceptance group'),
      createGroup(owner, 'Current email rejection group')
    ])
    const [formerEmailGroup, currentAcceptGroup, currentRejectGroup] = groups

    try {
      expect(staleSession.error).toBeNull()
      expect(staleAccessToken).toEqual(expect.any(String))
      const staleClaims = JSON.parse(Buffer.from(
        (staleAccessToken as string).split('.')[1],
        'base64url'
      ).toString('utf8')) as { email?: unknown }
      expect(staleClaims.email).toBe(formerEmail)

      const emailUpdate = await admin.auth.admin.updateUserById(invitee.userId, {
        email: currentEmail,
        email_confirm: true
      })

      if (emailUpdate.error || !emailUpdate.data.user) {
        throw emailUpdate.error ?? new Error('Auth email update did not return a user.')
      }

      expect(emailUpdate.data.user.email).toBe(currentEmail)
      expect((await invitee.client.auth.getSession()).data.session?.access_token)
        .toBe(staleAccessToken)

      const currentClient = await signInHumanFixture(currentEmail)
      const currentSession = await currentClient.auth.getSession()

      expect(currentSession.error).toBeNull()
      expect(currentSession.data.session?.user.email).toBe(currentEmail)
      const currentInvitee = { ...invitee, client: currentClient, email: currentEmail }
      const invitationResults = await Promise.all([
        postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
          email: formerEmail,
          groupId: formerEmailGroup.id
        }),
        postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
          email: currentEmail,
          groupId: currentAcceptGroup.id
        }),
        postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
          email: currentEmail,
          groupId: currentRejectGroup.id
        })
      ])
      const [formerInvitation, currentAcceptInvitation, currentRejectInvitation] =
        invitationResults.map(({ body }) => (
          body as AgoraRequestResult<'inviteHuman'>
        ).invitation)

      expect(invitationResults.every(({ status }) => status === 200)).toBe(true)
      const [stalePending, currentPending, staleDirect, currentDirect] = await Promise.all([
        postHuman(invitee, agoraRequestIdentifiers.listPendingInvitations, {}),
        postHuman(currentInvitee, agoraRequestIdentifiers.listPendingInvitations, {}),
        invitee.client.from('invitations').select('id'),
        currentClient.from('invitations').select('id')
      ])
      const currentInvitationIds = [currentAcceptInvitation.id, currentRejectInvitation.id].sort()
      const pendingIds = (result: typeof stalePending) => (
        result.body as AgoraRequestResult<'listPendingInvitations'>
      ).items.map(({ id }) => id).sort()

      expect(stalePending.status).toBe(200)
      expect(currentPending.status).toBe(200)
      expect(pendingIds(stalePending)).toEqual(currentInvitationIds)
      expect(pendingIds(currentPending)).toEqual(currentInvitationIds)
      expect(staleDirect.error).toBeNull()
      expect(currentDirect.error).toBeNull()
      expect(staleDirect.data?.map(({ id }) => id).sort()).toEqual(currentInvitationIds)
      expect(currentDirect.data?.map(({ id }) => id).sort()).toEqual(currentInvitationIds)

      const [staleAccept, staleReject] = await Promise.all([
        postHuman(invitee, agoraRequestIdentifiers.acceptInvitation, {
          invitationId: formerInvitation.id
        }),
        postHuman(invitee, agoraRequestIdentifiers.rejectInvitation, {
          invitationId: formerInvitation.id
        })
      ])

      expect(staleAccept.status).toBe(404)
      expect(staleReject.status).toBe(404)

      const currentAccept = await postHuman(
        currentInvitee,
        agoraRequestIdentifiers.acceptInvitation,
        { invitationId: currentAcceptInvitation.id }
      )
      const currentReject = await postHuman(
        currentInvitee,
        agoraRequestIdentifiers.rejectInvitation,
        { invitationId: currentRejectInvitation.id }
      )

      expect(currentAccept.status).toBe(200)
      expect(currentReject.status).toBe(200)
      expect(await selectCount('invitations', 'id', formerInvitation.id)).toBe(1)
    } finally {
      for (const group of groups) {
        await postHuman(owner, agoraRequestIdentifiers.deleteGroup, { groupId: group.id })
      }
    }
  })
})
