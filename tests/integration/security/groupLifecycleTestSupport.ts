import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { AgoraRequestIdentifier } from '../../../common/agoraRequestIdentifiers'
import {
  agoraContractVersion,
  agoraRequestIdentifiers
} from '../../../common/agoraRequestIdentifiers'
import type {
  AgoraRequestParams,
  AgoraRequestResult
} from '../../../common/agoraRequestContract'
import {
  deleteAgentFixtures,
  provisionAgentFixture,
  type AgentFixture
} from './agentFixture'
import {
  createHumanFixtures,
  deleteHumanFixtures,
  type HumanFixture
} from './humanFixture'
import { createAdminClient } from './localSupabase'

export const groupLifecycleAdmin = createAdminClient()
const agoraFunctionUrl = 'http://127.0.0.1:54321/functions/v1/agora'

export type GroupLifecycleFixtures = {
  agent: AgentFixture
  member: HumanFixture
  outsider: HumanFixture
  owner: HumanFixture
}

const humanHeaders = async (human: HumanFixture) => {
  const { data, error } = await human.client.auth.getSession()
  const accessToken = data.session?.access_token

  if (error || !accessToken) {
    throw error ?? new Error('Human lifecycle fixture has no session.')
  }

  return { authorization: `Bearer ${accessToken}` }
}

const postAgora = async <TIdentifier extends AgoraRequestIdentifier>(
  identifier: TIdentifier,
  params: AgoraRequestParams<TIdentifier>,
  headers: Record<string, string>
) => {
  const response = await fetch(agoraFunctionUrl, {
    body: JSON.stringify({ identifier, params, version: agoraContractVersion }),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST'
  })

  return {
    body: await response.json() as AgoraRequestResult<TIdentifier> | { error: string },
    status: response.status
  }
}

export const postHuman = async <TIdentifier extends AgoraRequestIdentifier>(
  human: HumanFixture,
  identifier: TIdentifier,
  params: AgoraRequestParams<TIdentifier>
) => postAgora(identifier, params, await humanHeaders(human))

export const postAgent = <TIdentifier extends AgoraRequestIdentifier>(
  agent: AgentFixture,
  identifier: TIdentifier,
  params: AgoraRequestParams<TIdentifier>
) => postAgora(identifier, params, { 'x-agora-agent-key': agent.applicationKey })

export const createGroup = async (owner: HumanFixture, name: string) => {
  const result = await postHuman(owner, agoraRequestIdentifiers.createGroup, { name })

  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({
    group: {
      name: name.trim(),
      ownerPrincipalId: owner.principalId
    }
  })

  return (result.body as AgoraRequestResult<'createGroup'>).group
}

export const createGroupLifecycleFixtures = async (): Promise<GroupLifecycleFixtures> => {
  const humans = await createHumanFixtures([
    'lifecycle-owner',
    'lifecycle-member',
    'lifecycle-outsider'
  ])
  const [owner, member, outsider] = humans

  try {
    const agent = await provisionAgentFixture(`Lifecycle agent ${randomUUID()}`)

    return { agent, member, outsider, owner }
  } catch (error) {
    await deleteHumanFixtures(humans)
    throw error
  }
}

export const cleanupGroupLifecycleFixtures = async (
  fixtures: GroupLifecycleFixtures | undefined
) => {
  if (!fixtures) {
    return
  }

  const { error } = await groupLifecycleAdmin
    .from('groups')
    .delete()
    .eq('owner_principal_id', fixtures.owner.principalId)

  if (error) {
    throw error
  }

  await deleteAgentFixtures([fixtures.agent])
  await deleteHumanFixtures([fixtures.owner, fixtures.member, fixtures.outsider])
}

export const insertMembership = async (groupId: string, principalId: string) => {
  const { error } = await groupLifecycleAdmin.from('memberships').insert({
    group_id: groupId,
    principal_id: principalId,
    role: 'member'
  })

  if (error) {
    throw error
  }
}

export const selectCount = async (table: string, column: string, value: string) => {
  const { count, error } = await groupLifecycleAdmin
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(column, value)

  if (error) {
    throw error
  }

  return count
}
