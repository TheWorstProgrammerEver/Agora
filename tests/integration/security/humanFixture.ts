import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { expect } from 'vitest'
import { createAdminClient, createAnonymousClient } from './localSupabase'

export type HumanFixture = {
  client: SupabaseClient
  email: string
  principalId: string
  userId: string
}

const password = 'Agora-security-password-1'

export const createHumanFixture = async (label: string): Promise<HumanFixture> => {
  const client = createAnonymousClient()
  const email = `agora-${label}-${randomUUID()}@example.test`
  const displayName = `Agora ${label}`
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } }
  })

  if (error || !data.user) {
    throw error ?? new Error(`Public signup did not create an authenticated ${label} fixture.`)
  }

  if (!data.session) {
    await createAdminClient().auth.admin.deleteUser(data.user.id)
    throw new Error(`Public signup did not create an authenticated ${label} fixture.`)
  }

  const principalResult = await createAdminClient()
    .from('principals')
    .select('id, kind, auth_user_id, display_name')
    .eq('auth_user_id', data.user.id)
    .single()

  if (principalResult.error) {
    await createAdminClient().auth.admin.deleteUser(data.user.id)
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

export const signInHumanFixture = async (email: string) => {
  const client = createAnonymousClient()
  const { data, error } = await client.auth.signInWithPassword({ email, password })

  if (error || !data.session) {
    throw error ?? new Error('Human fixture sign-in did not return a session.')
  }

  return client
}

export const createHumanFixtures = async (labels: string[]) => {
  const fixtures: HumanFixture[] = []

  try {
    for (const label of labels) {
      fixtures.push(await createHumanFixture(label))
    }

    return fixtures
  } catch (error) {
    await deleteHumanFixtures(fixtures)
    throw error
  }
}

export const deleteHumanFixtures = async (fixtures: HumanFixture[]) => {
  const userIds = fixtures.map((fixture) => fixture.userId)

  if (userIds.length === 0) {
    return
  }

  const admin = createAdminClient()
  const deleteResults = await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)))
  const deleteError = deleteResults.find((result) => result.error)?.error

  if (deleteError) {
    throw deleteError
  }

  const { count, error } = await admin
    .from('principals')
    .select('id', { count: 'exact', head: true })
    .in('auth_user_id', userIds)

  if (error) {
    throw error
  }

  expect(count).toBe(0)
}
