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
  if (humans.length !== 6) {
    throw new Error('Member pagination fixtures were not created.')
  }

  return { members: humans.slice(1), owner: humans[0] }
}

beforeAll(async () => {
  humans = await createHumanFixtures([
    'member-pagination-owner',
    'member-pagination-one',
    'member-pagination-two',
    'member-pagination-three',
    'member-pagination-four',
    'member-pagination-five'
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

describe('active member cursor pagination', () => {
  it('bounds pages and excludes a concurrently added leading membership', async () => {
    const { members, owner } = requireHumans()
    const group = await createGroup(owner, 'Member page group')
    const initialMembers = members.slice(0, 4)
    const insert = await admin.from('memberships').insert(initialMembers.map((member, index) => ({
      created_at: `2098-08-12T00:00:0${index}.000000Z`,
      group_id: group.id,
      principal_id: member.principalId,
      role: 'member'
    })))

    expect(insert.error).toBeNull()

    const firstPage = await postHuman(owner, agoraRequestIdentifiers.listGroupMembers, {
      groupId: group.id,
      limit: 2
    })
    const firstBody = firstPage.body as AgoraRequestResult<'listGroupMembers'>

    expect(firstPage.status).toBe(200)
    expect(firstBody.items).toHaveLength(2)
    expect(firstBody.nextCursor).toEqual(expect.any(String))

    const newerMember = members[4]
    const newerInsert = await admin.from('memberships').insert({
      created_at: '2099-08-12T00:00:00.000000Z',
      group_id: group.id,
      principal_id: newerMember.principalId,
      role: 'member'
    })

    expect(newerInsert.error).toBeNull()

    const continuedPrincipalIds = firstBody.items.map(({ principal }) => principal.id)
    let cursor = firstBody.nextCursor

    while (cursor) {
      const page = await postHuman(owner, agoraRequestIdentifiers.listGroupMembers, {
        cursor,
        groupId: group.id,
        limit: 2
      })
      const body = page.body as AgoraRequestResult<'listGroupMembers'>

      expect(page.status).toBe(200)
      continuedPrincipalIds.push(...body.items.map(({ principal }) => principal.id))
      cursor = body.nextCursor
    }

    const initialPrincipalIds = [owner, ...initialMembers].map(({ principalId }) => principalId)

    expect(continuedPrincipalIds).toHaveLength(initialPrincipalIds.length)
    expect(new Set(continuedPrincipalIds)).toEqual(new Set(initialPrincipalIds))
    expect(continuedPrincipalIds).not.toContain(newerMember.principalId)

    const refreshed = await postHuman(owner, agoraRequestIdentifiers.listGroupMembers, {
      groupId: group.id,
      limit: 100
    })

    expect((refreshed.body as AgoraRequestResult<'listGroupMembers'>).items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ principal: expect.objectContaining({ id: newerMember.principalId }) })
      ]))

    const overLimit = await postHuman(owner, agoraRequestIdentifiers.listGroupMembers, {
      groupId: group.id,
      limit: 101
    })
    const malformedCursor = await postHuman(owner, agoraRequestIdentifiers.listGroupMembers, {
      cursor: 'not-a-valid-cursor',
      groupId: group.id
    })
    const directOverLimit = await owner.client.rpc('list_agora_group_members', {
      group_id_to_list: group.id,
      page_size: 101
    })
    const directPartialCursor = await owner.client.rpc('list_agora_group_members', {
      cursor_created_at: new Date().toISOString(),
      group_id_to_list: group.id,
      page_size: 2
    })

    expect(overLimit.status).toBe(400)
    expect(malformedCursor.status).toBe(400)
    expect(directOverLimit.error?.code).toBe('22023')
    expect(directPartialCursor.error?.code).toBe('22023')
  })

  it('uses membership id as the deterministic equal-timestamp tie-breaker', async () => {
    const { members, owner } = requireHumans()
    const group = await createGroup(owner, 'Tied member group')
    const lowerId = '10000000-0000-4000-8000-000000000033'
    const higherId = '20000000-0000-4000-8000-000000000044'
    const createdAt = '2099-08-12T00:00:00.123456Z'
    const insert = await admin.from('memberships').insert([
      {
        created_at: createdAt,
        group_id: group.id,
        id: lowerId,
        principal_id: members[0].principalId,
        role: 'member'
      },
      {
        created_at: createdAt,
        group_id: group.id,
        id: higherId,
        principal_id: members[1].principalId,
        role: 'member'
      }
    ])

    expect(insert.error).toBeNull()

    const first = await postHuman(owner, agoraRequestIdentifiers.listGroupMembers, {
      groupId: group.id,
      limit: 1
    })
    const firstBody = first.body as AgoraRequestResult<'listGroupMembers'>
    const second = await postHuman(owner, agoraRequestIdentifiers.listGroupMembers, {
      cursor: firstBody.nextCursor,
      groupId: group.id,
      limit: 1
    })
    const secondBody = second.body as AgoraRequestResult<'listGroupMembers'>

    expect(firstBody.items.map(({ principal }) => principal.id)).toEqual([
      members[1].principalId
    ])
    expect(secondBody.items.map(({ principal }) => principal.id)).toEqual([
      members[0].principalId
    ])
  })
})
