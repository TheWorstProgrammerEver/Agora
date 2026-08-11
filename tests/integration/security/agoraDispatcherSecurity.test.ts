import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agoraContractVersion,
  agoraRequestIdentifiers
} from '../../../common/agoraRequestIdentifiers'
import {
  deleteAgentFixtures,
  provisionAgentFixture,
  type AgentFixture
} from './agentFixture'
import {
  createHumanFixture,
  deleteHumanFixtures,
  type HumanFixture
} from './humanFixture'

const agoraFunctionUrl = 'http://127.0.0.1:54321/functions/v1/agora'
let agent: AgentFixture | undefined
let human: HumanFixture | undefined

const postAgora = (body: unknown, headers: Record<string, string> = {}) => fetch(agoraFunctionUrl, {
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...headers },
  method: 'POST'
})

const validRequest = {
  identifier: agoraRequestIdentifiers.listGroups,
  params: {},
  version: agoraContractVersion
}

const requireFixtures = () => {
  if (!agent || !human) {
    throw new Error('Agora dispatcher fixtures were not created.')
  }

  return { agent, human }
}

const humanHeaders = async (fixture: HumanFixture) => {
  const { data, error } = await fixture.client.auth.getSession()
  const accessToken = data.session?.access_token

  if (error || !accessToken) {
    throw error ?? new Error('Human dispatcher fixture has no session.')
  }

  return { authorization: `Bearer ${accessToken}` }
}

beforeAll(async () => {
  human = await createHumanFixture('dispatcher-human')

  try {
    agent = await provisionAgentFixture('Dispatcher agent')
  } catch (error) {
    await deleteHumanFixtures([human])
    human = undefined
    throw error
  }
})

afterAll(async () => {
  await deleteAgentFixtures(agent ? [agent] : [])
  await deleteHumanFixtures(human ? [human] : [])
})

describe('Agora dual-auth dispatcher', () => {
  it('routes authorized human and agent calls through the same catalog handler', async () => {
    const fixtures = requireFixtures()
    const [humanResponse, agentResponse] = await Promise.all([
      postAgora(validRequest, await humanHeaders(fixtures.human)),
      postAgora(validRequest, { 'x-agora-agent-key': fixtures.agent.applicationKey })
    ])

    for (const response of [humanResponse, agentResponse]) {
      const body = await response.json()

      expect({ body, status: response.status }).toEqual({
        body: { items: [] },
        status: 200
      })
    }
  })

  it('denies anonymous, malformed human, malformed agent, and invalid credentials', async () => {
    const invalidAgentKey = `agora_agent_v1_${'A'.repeat(43)}`
    const responses = await Promise.all([
      postAgora(validRequest),
      postAgora(validRequest, { authorization: 'not-bearer' }),
      postAgora(validRequest, { 'x-agora-agent-key': 'agora_agent_v1_short' }),
      postAgora(validRequest, { authorization: 'Bearer invalid.jwt.value' }),
      postAgora(validRequest, { 'x-agora-agent-key': invalidAgentKey })
    ])

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401, 401, 401])
  })

  it('rejects unknown identifiers and invalid DTOs identically after either authentication', async () => {
    const fixtures = requireFixtures()
    const credentials = [
      await humanHeaders(fixtures.human),
      { 'x-agora-agent-key': fixtures.agent.applicationKey }
    ]

    for (const headers of credentials) {
      const [unknown, invalidDto] = await Promise.all([
        postAgora({ identifier: 'unknown', params: {}, version: agoraContractVersion }, headers),
        postAgora({
          identifier: agoraRequestIdentifiers.listGroups,
          params: { limit: '20' },
          version: agoraContractVersion
        }, headers)
      ])

      expect(unknown.status).toBe(400)
      expect(invalidDto.status).toBe(400)
    }
  })

  it('rejects attempts to select a caller principal before a handler runs', async () => {
    const fixtures = requireFixtures()
    const otherPrincipalId = fixtures.agent.principalId
    const headers = await humanHeaders(fixtures.human)
    const [envelopeSelector, paramsSelector] = await Promise.all([
      postAgora({
        ...validRequest,
        principalId: otherPrincipalId
      }, headers),
      postAgora({
        ...validRequest,
        params: { principalId: otherPrincipalId }
      }, headers)
    ])

    expect(envelopeSelector.status).toBe(400)
    expect(paramsSelector.status).toBe(400)
  })

  it('keeps a valid human session authoritative when an agent key is also present', async () => {
    const fixtures = requireFixtures()
    const response = await postAgora(validRequest, {
      ...await humanHeaders(fixtures.human),
      'x-agora-agent-key': fixtures.agent.applicationKey
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ items: [] })
  })

  it('does not fall back to a valid agent key when an explicit human token is invalid', async () => {
    const fixtures = requireFixtures()
    const response = await postAgora(validRequest, {
      authorization: 'Bearer invalid.jwt.value',
      'x-agora-agent-key': fixtures.agent.applicationKey
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'A valid human session is required.'
    })
  })

  it('requires authentication before exposing request validation results', async () => {
    const response = await postAgora({
      identifier: agoraRequestIdentifiers.listGroups,
      params: { principalId: 'selected-by-caller' },
      version: 999
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'A human session or Agora agent key is required.'
    })
  })
})
