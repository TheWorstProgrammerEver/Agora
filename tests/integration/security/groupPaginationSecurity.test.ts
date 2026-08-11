import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgoraRequestResult } from '../../../common/agoraRequestContract'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'
import {
  createHumanFixture,
  deleteHumanFixtures,
  type HumanFixture
} from './humanFixture'
import {
  createGroup,
  groupLifecycleAdmin as admin,
  postHuman
} from './groupLifecycleTestSupport'

let owner: HumanFixture | undefined

const requireOwner = () => {
  if (!owner) {
    throw new Error('Group pagination fixture was not created.')
  }

  return owner
}

beforeAll(async () => {
  owner = await createHumanFixture('pagination-owner')
})

afterAll(async () => {
  if (!owner) {
    return
  }

  await deleteHumanFixtures([owner])
})

afterEach(async () => {
  if (owner) {
    const { error } = await admin
      .from('groups')
      .delete()
      .eq('owner_principal_id', owner.principalId)

    if (error) {
      throw error
    }
  }
})

describe('group-list cursor pagination', () => {
  it('bounds pages and keeps continuation stable when a newer group is created', async () => {
    const source = requireOwner()
    const initialGroups = []

    for (let index = 0; index < 5; index += 1) {
      initialGroups.push(await createGroup(source, `Pagination group ${index}`))
    }

    const firstPage = await postHuman(source, agoraRequestIdentifiers.listGroups, { limit: 2 })
    const firstBody = firstPage.body as AgoraRequestResult<'listGroups'>

    expect(firstPage.status).toBe(200)
    expect(firstBody.items).toHaveLength(2)
    expect(firstBody.nextCursor).toEqual(expect.any(String))

    const newerGroup = await createGroup(source, 'Concurrent newer group')
    const continuedIds = [...firstBody.items.map(({ id }) => id)]
    let cursor = firstBody.nextCursor

    while (cursor) {
      const page = await postHuman(source, agoraRequestIdentifiers.listGroups, {
        cursor,
        limit: 2
      })
      const body = page.body as AgoraRequestResult<'listGroups'>

      expect(page.status).toBe(200)
      continuedIds.push(...body.items.map(({ id }) => id))
      cursor = body.nextCursor
    }

    expect(continuedIds).toHaveLength(initialGroups.length)
    expect(new Set(continuedIds)).toEqual(new Set(initialGroups.map(({ id }) => id)))
    expect(continuedIds).not.toContain(newerGroup.id)

    const refreshed = await postHuman(source, agoraRequestIdentifiers.listGroups, { limit: 100 })
    const refreshedBody = refreshed.body as AgoraRequestResult<'listGroups'>

    expect(refreshedBody.items.map(({ id }) => id)).toContain(newerGroup.id)

    const overLimit = await postHuman(source, agoraRequestIdentifiers.listGroups, { limit: 101 })
    const malformedCursor = await postHuman(source, agoraRequestIdentifiers.listGroups, {
      cursor: 'not-a-valid-cursor'
    })
    const directOverLimit = await source.client.rpc('list_agora_groups', { page_size: 101 })
    const partialDirectCursor = await source.client.rpc('list_agora_groups', {
      cursor_created_at: new Date().toISOString(),
      page_size: 2
    })

    expect(overLimit.status).toBe(400)
    expect(malformedCursor.status).toBe(400)
    expect(directOverLimit.error?.code).toBe('22023')
    expect(partialDirectCursor.error?.code).toBe('22023')
  })

  it('uses the group id as a deterministic cursor tie-breaker', async () => {
    const source = requireOwner()
    const createdAt = '2026-08-12T00:00:00.000Z'
    const lowerId = '10000000-0000-4000-8000-000000000001'
    const higherId = '20000000-0000-4000-8000-000000000002'
    const insert = await admin.from('groups').insert([
      {
        created_at: createdAt,
        id: lowerId,
        name: 'Tied lower group',
        owner_principal_id: source.principalId
      },
      {
        created_at: createdAt,
        id: higherId,
        name: 'Tied higher group',
        owner_principal_id: source.principalId
      }
    ])

    expect(insert.error).toBeNull()

    const first = await postHuman(source, agoraRequestIdentifiers.listGroups, { limit: 1 })
    const firstBody = first.body as AgoraRequestResult<'listGroups'>
    const second = await postHuman(source, agoraRequestIdentifiers.listGroups, {
      cursor: firstBody.nextCursor,
      limit: 1
    })
    const secondBody = second.body as AgoraRequestResult<'listGroups'>

    expect(firstBody.items.map(({ id }) => id)).toEqual([higherId])
    expect(secondBody.items.map(({ id }) => id)).toEqual([lowerId])
    expect(secondBody.nextCursor).toBeUndefined()
  })
})
