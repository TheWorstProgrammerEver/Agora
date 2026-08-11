import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgoraRequestResult } from '../../../common/agoraRequestContract'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'
import {
  createHumanFixtures,
  deleteHumanFixtures,
  type HumanFixture
} from './humanFixture'
import {
  createGroup,
  groupLifecycleAdmin as admin,
  postHuman
} from './groupLifecycleTestSupport'

let humans: HumanFixture[] = []

const requireHumans = () => {
  if (humans.length !== 3) {
    throw new Error('Invitation pagination fixtures were not created.')
  }

  return { invitee: humans[1], outsider: humans[2], owner: humans[0] }
}

beforeAll(async () => {
  humans = await createHumanFixtures([
    'invitation-pagination-owner',
    'invitation-pagination-invitee',
    'invitation-pagination-outsider'
  ])
})

afterEach(async () => {
  if (humans[0]) {
    const { error } = await admin.from('groups').delete().eq(
      'owner_principal_id',
      humans[0].principalId
    )

    if (error) {
      throw error
    }
  }
})

afterAll(async () => {
  await deleteHumanFixtures(humans)
})

describe('pending invitation cursor pagination', () => {
  it('bounds pages and excludes a concurrently created leading invitation', async () => {
    const { invitee, outsider, owner } = requireHumans()
    const initialInvitations = []

    for (let index = 0; index < 5; index += 1) {
      const group = await createGroup(owner, `Invitation page group ${index}`)
      const result = await postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
        email: invitee.email,
        groupId: group.id
      })

      initialInvitations.push((result.body as AgoraRequestResult<'inviteHuman'>).invitation)
    }

    const firstPage = await postHuman(
      invitee,
      agoraRequestIdentifiers.listPendingInvitations,
      { limit: 2 }
    )
    const firstBody = firstPage.body as AgoraRequestResult<'listPendingInvitations'>

    expect(firstPage.status).toBe(200)
    expect(firstBody.items).toHaveLength(2)
    expect(firstBody.nextCursor).toEqual(expect.any(String))

    const newerGroup = await createGroup(owner, 'Concurrent newer invitation group')
    const newerResult = await postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
      email: invitee.email,
      groupId: newerGroup.id
    })
    const newerInvitation = (newerResult.body as AgoraRequestResult<'inviteHuman'>).invitation
    const continuedIds = firstBody.items.map(({ id }) => id)
    let cursor = firstBody.nextCursor

    while (cursor) {
      const page = await postHuman(invitee, agoraRequestIdentifiers.listPendingInvitations, {
        cursor,
        limit: 2
      })
      const body = page.body as AgoraRequestResult<'listPendingInvitations'>

      expect(page.status).toBe(200)
      continuedIds.push(...body.items.map(({ id }) => id))
      cursor = body.nextCursor
    }

    expect(continuedIds).toHaveLength(initialInvitations.length)
    expect(new Set(continuedIds)).toEqual(new Set(initialInvitations.map(({ id }) => id)))
    expect(continuedIds).not.toContain(newerInvitation.id)

    const refreshed = await postHuman(
      invitee,
      agoraRequestIdentifiers.listPendingInvitations,
      { limit: 100 }
    )
    const outsiderPage = await postHuman(
      outsider,
      agoraRequestIdentifiers.listPendingInvitations,
      { limit: 100 }
    )

    expect((refreshed.body as AgoraRequestResult<'listPendingInvitations'>).items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: newerInvitation.id })]))
    expect(outsiderPage).toEqual({ body: { items: [] }, status: 200 })

    const overLimit = await postHuman(
      invitee,
      agoraRequestIdentifiers.listPendingInvitations,
      { limit: 101 }
    )
    const malformedCursor = await postHuman(
      invitee,
      agoraRequestIdentifiers.listPendingInvitations,
      { cursor: 'not-a-valid-cursor' }
    )
    const directOverLimit = await invitee.client.rpc('list_agora_pending_invitations', {
      page_size: 101
    })
    const directPartialCursor = await invitee.client.rpc('list_agora_pending_invitations', {
      cursor_created_at: new Date().toISOString(),
      page_size: 2
    })

    expect(overLimit.status).toBe(400)
    expect(malformedCursor.status).toBe(400)
    expect(directOverLimit.error?.code).toBe('22023')
    expect(directPartialCursor.error?.code).toBe('22023')
  })

  it('uses invitation id as the deterministic equal-timestamp tie-breaker', async () => {
    const { invitee, owner } = requireHumans()
    const lowerId = '10000000-0000-4000-8000-000000000011'
    const higherId = '20000000-0000-4000-8000-000000000022'
    const createdAt = '2026-08-12T00:00:00.123456Z'
    const [lowerGroup, higherGroup] = await Promise.all([
      createGroup(owner, 'Tied lower invitation'),
      createGroup(owner, 'Tied higher invitation')
    ])
    const insert = await admin.from('invitations').insert([
      {
        created_at: createdAt,
        email: invitee.email,
        group_id: lowerGroup.id,
        id: lowerId,
        invited_by_principal_id: owner.principalId
      },
      {
        created_at: createdAt,
        email: invitee.email,
        group_id: higherGroup.id,
        id: higherId,
        invited_by_principal_id: owner.principalId
      }
    ])

    expect(insert.error).toBeNull()

    const first = await postHuman(
      invitee,
      agoraRequestIdentifiers.listPendingInvitations,
      { limit: 1 }
    )
    const firstBody = first.body as AgoraRequestResult<'listPendingInvitations'>
    const second = await postHuman(invitee, agoraRequestIdentifiers.listPendingInvitations, {
      cursor: firstBody.nextCursor,
      limit: 1
    })
    const secondBody = second.body as AgoraRequestResult<'listPendingInvitations'>

    expect(firstBody.items.map(({ id }) => id)).toEqual([higherId])
    expect(secondBody.items.map(({ id }) => id)).toEqual([lowerId])
  })
})
