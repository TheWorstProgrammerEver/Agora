import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAdminClient, createAnonymousClient } from './localSupabase'

type HumanFixture = {
  client: SupabaseClient
  email: string
  principalId: string
  userId: string
}

const password = 'Agora-security-password-1'
const admin = createAdminClient()
const transientPrincipalIds: string[] = []
const createdUserIds: string[] = []

const createHuman = async (label: string): Promise<HumanFixture> => {
  const client = createAnonymousClient()
  const email = `agora-${label}-${randomUUID()}@example.test`
  const displayName = `Agora ${label}`
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } }
  })

  if (error || !data.user || !data.session) {
    throw error ?? new Error(`Public signup did not create an authenticated ${label} fixture.`)
  }

  createdUserIds.push(data.user.id)
  const principalResult = await admin
    .from('principals')
    .select('id, kind, auth_user_id, display_name')
    .eq('auth_user_id', data.user.id)
    .single()

  if (principalResult.error) {
    throw principalResult.error
  }

  expect(principalResult.data).toMatchObject({
    auth_user_id: data.user.id,
    display_name: displayName,
    kind: 'human'
  })

  return {
    client,
    email,
    principalId: principalResult.data.id as string,
    userId: data.user.id
  }
}

describe('human principal security', () => {
  let first: HumanFixture
  let second: HumanFixture

  beforeAll(async () => {
    [first, second] = await Promise.all([
      createHuman('first'),
      createHuman('second')
    ])
  })

  afterEach(async () => {
    const ids = transientPrincipalIds.splice(0)

    if (ids.length === 0) {
      return
    }

    const { error } = await admin.from('principals').delete().in('id', ids)

    if (error) {
      throw error
    }
  })

  afterAll(async () => {
    const deleteResults = await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)))
    const deleteError = deleteResults.find((result) => result.error)?.error

    if (deleteError) {
      throw deleteError
    }

    const { count, error } = await admin
      .from('principals')
      .select('id', { count: 'exact', head: true })
      .in('auth_user_id', createdUserIds)

    if (error) {
      throw error
    }

    expect(count).toBe(0)
  })

  it('creates one server-controlled human principal for each public signup', () => {
    expect(first.email).toContain('agora-first-')
    expect(first.principalId).not.toBe(first.userId)
    expect(second.principalId).not.toBe(first.principalId)
  })

  it('lets a memberless account read only its own principal', async () => {
    const ownResult = await first.client
      .from('principals')
      .select('id, kind, auth_user_id, display_name')
    const crossResult = await first.client
      .from('principals')
      .select('id')
      .eq('id', second.principalId)

    expect(ownResult.error).toBeNull()
    expect(ownResult.data).toEqual([expect.objectContaining({
      auth_user_id: first.userId,
      id: first.principalId,
      kind: 'human'
    })])
    expect(crossResult.error).toBeNull()
    expect(crossResult.data).toEqual([])
  })

  it('denies anonymous, forged, update, and delete access', async () => {
    const forgedId = randomUUID()
    transientPrincipalIds.push(forgedId)
    const anonymousResult = await createAnonymousClient().from('principals').select('id')
    const forgedResult = await first.client.from('principals').insert({
      auth_user_id: second.userId,
      display_name: 'Forged principal',
      id: forgedId,
      kind: 'human'
    })
    const updateResult = await first.client
      .from('principals')
      .update({ display_name: 'Forged rename' })
      .eq('id', first.principalId)
    const deleteResult = await first.client
      .from('principals')
      .delete()
      .eq('id', first.principalId)

    expect(anonymousResult.error).not.toBeNull()
    expect(forgedResult.error).not.toBeNull()
    expect(updateResult.error).not.toBeNull()
    expect(deleteResult.error).not.toBeNull()

    const { data, error } = await admin
      .from('principals')
      .select('id, display_name')
      .in('id', [forgedId, first.principalId])

    expect(error).toBeNull()
    expect(data).toEqual([{ id: first.principalId, display_name: 'Agora first' }])
  })

  it('enforces unique human linkage and principal-kind constraints', async () => {
    const attemptedIds = Array.from({ length: 4 }, () => randomUUID())
    transientPrincipalIds.push(...attemptedIds)
    const duplicate = await admin.from('principals').insert({
      auth_user_id: first.userId,
      display_name: 'Duplicate human',
      id: attemptedIds[0],
      kind: 'human'
    })
    const unlinkedHuman = await admin.from('principals').insert({
      auth_user_id: null,
      display_name: 'Unlinked human',
      id: attemptedIds[1],
      kind: 'human'
    })
    const linkedAgent = await admin.from('principals').insert({
      auth_user_id: first.userId,
      display_name: 'Linked agent',
      id: attemptedIds[2],
      kind: 'agent'
    })
    const unknownKind = await admin.from('principals').insert({
      auth_user_id: null,
      display_name: 'Unknown kind',
      id: attemptedIds[3],
      kind: 'robot'
    })

    expect(duplicate.error?.code).toBe('23505')
    expect(unlinkedHuman.error?.code).toBe('23514')
    expect(linkedAgent.error?.code).toBe('23514')
    expect(unknownKind.error?.code).toBe('22P02')
  })

  it('supports the agent kind without provisioning agent credentials', async () => {
    const agentId = randomUUID()
    transientPrincipalIds.push(agentId)
    const insertResult = await admin.from('principals').insert({
      auth_user_id: null,
      display_name: 'Schema validation agent',
      id: agentId,
      kind: 'agent'
    })

    expect(insertResult.error).toBeNull()

    const humanView = await first.client.from('principals').select('id').eq('id', agentId)

    expect(humanView.error).toBeNull()
    expect(humanView.data).toEqual([])
  })
})
