import type {
  RealtimeChannel,
  SupabaseClient
} from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgoraRequestResult } from '../../../common/agoraRequestContract'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'
import {
  agoraRealtimeAgentRole,
  agoraRealtimeEvent,
  formatAgoraRealtimeTopic
} from '../../../common/agoraRealtime'
import {
  cleanupGroupLifecycleFixtures,
  createGroup,
  createGroupLifecycleFixtures,
  insertMembership,
  postAgent,
  postHuman,
  type GroupLifecycleFixtures
} from './groupLifecycleTestSupport'
import { createRealtimeCredentialClient } from './localSupabase'

type BroadcastEnvelope = {
  event: string
  meta?: unknown
  payload: unknown
  type: string
}

let fixtures: GroupLifecycleFixtures | undefined

const requireFixtures = () => {
  if (!fixtures) {
    throw new Error('Realtime security fixtures were not created.')
  }

  return fixtures
}

const decodeClaims = (token: string) => JSON.parse(
  Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
) as Record<string, unknown>

const subscribe = (
  client: SupabaseClient,
  topic: string,
  onBroadcast: (envelope: BroadcastEnvelope) => void = () => undefined
) => new Promise<{ channel: RealtimeChannel, status: string }>((resolve) => {
  let settled = false
  const channel = client
    .channel(topic, { config: { broadcast: { ack: true }, private: true } })
    .on('broadcast', { event: agoraRealtimeEvent }, onBroadcast)
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      resolve({ channel, status: 'TEST_TIMEOUT' })
    }
  }, 8000)

  channel.subscribe((status) => {
    if (!settled && status !== 'CLOSED') {
      settled = true
      clearTimeout(timer)
      resolve({ channel, status })
    }
  })
})

const waitForBroadcast = (
  client: SupabaseClient,
  topic: string
) => new Promise<{
  channel: RealtimeChannel
  event: Promise<BroadcastEnvelope>
  subscribed: Promise<string>
}>((resolve) => {
  let resolveEvent: (envelope: BroadcastEnvelope) => void
  const event = new Promise<BroadcastEnvelope>((eventResolve) => {
    resolveEvent = eventResolve
  })
  const subscription = subscribe(client, topic, (envelope) => resolveEvent(envelope))

  subscription.then(({ channel, status }) => resolve({
    channel,
    event,
    subscribed: Promise.resolve(status)
  }))
})

const observeBroadcast = (channel: RealtimeChannel) => new Promise<BroadcastEnvelope>((resolve) => {
  channel.on('broadcast', { event: agoraRealtimeEvent }, resolve)
})

const observeOptionalBroadcast = (
  event: Promise<BroadcastEnvelope>,
  milliseconds: number
) => Promise.race([
  event,
  new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), milliseconds))
])

const expectAvailabilityEnvelope = (
  envelope: BroadcastEnvelope,
  expected: { groupId: string, highWatermarkSequence: string }
) => {
  const payload = envelope.payload as Record<string, unknown>

  expect(envelope).toMatchObject({
    event: agoraRealtimeEvent,
    payload: expected,
    type: 'broadcast'
  })
  expect(Object.keys(envelope).sort()).toEqual(['event', 'meta', 'payload', 'type'])
  expect(Object.keys(payload).sort()).toEqual([
    'groupId',
    'highWatermarkSequence',
    'id'
  ])
  expect(payload.id).toEqual(expect.any(String))
  expect(envelope.meta).toEqual({ id: payload.id })
}

const cleanupRealtimeClient = async (client: SupabaseClient) => {
  await client.removeAllChannels()
  client.realtime.disconnect()
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('private Realtime authorization and agent sessions', () => {
  it('lets current human and agent members receive metadata-only availability', async () => {
    const { agent, owner } = requireFixtures()
    const group = await createGroup(owner, 'Realtime positive group')
    let agentRealtime: SupabaseClient | undefined

    try {
      await insertMembership(group.id, agent.principalId)
      const sessionResult = await postAgent(
        agent,
        agoraRequestIdentifiers.createRealtimeSession,
        { groupIds: [group.id] }
      )

      expect(sessionResult.status).toBe(200)
      const session = sessionResult.body as AgoraRequestResult<'createRealtimeSession'>
      expect(session.topics).toEqual([{
        groupId: group.id,
        highWatermarkSequence: '0',
        topic: formatAgoraRealtimeTopic(group.id)
      }])
      expect(Date.parse(session.refreshAfter)).toBeLessThan(Date.parse(session.expiresAt))
      expect(decodeClaims(session.accessToken)).toMatchObject({
        agora_principal_id: agent.principalId,
        agora_realtime_topics: [group.id],
        agora_token_kind: 'realtime',
        role: agoraRealtimeAgentRole,
        sub: agent.principalId
      })

      agentRealtime = createRealtimeCredentialClient(session.accessToken)
      await agentRealtime.realtime.setAuth(session.accessToken)
      await owner.client.realtime.setAuth()
      const [agentSubscription, humanSubscription] = await Promise.all([
        waitForBroadcast(agentRealtime, session.topics[0].topic),
        waitForBroadcast(owner.client, session.topics[0].topic)
      ])

      await expect(agentSubscription.subscribed).resolves.toBe('SUBSCRIBED')
      await expect(humanSubscription.subscribed).resolves.toBe('SUBSCRIBED')
      await expect(agentSubscription.channel.send({
        event: agoraRealtimeEvent,
        payload: { text: 'Clients cannot inject chat events.' },
        type: 'broadcast'
      }, { timeout: 1000 })).resolves.not.toBe('ok')
      const sent = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'realtime-positive',
        groupId: group.id,
        text: 'This plaintext must stay out of Realtime.'
      })

      expect(sent.status).toBe(200)
      const [agentEvent, humanEvent] = await Promise.all([
        agentSubscription.event,
        humanSubscription.event
      ])

      expectAvailabilityEnvelope(agentEvent, {
        groupId: group.id,
        highWatermarkSequence: '1'
      })
      expectAvailabilityEnvelope(humanEvent, {
        groupId: group.id,
        highWatermarkSequence: '1'
      })
      expect(JSON.stringify([agentEvent, humanEvent])).not.toContain('plaintext')
      expect(JSON.stringify([agentEvent, humanEvent])).not.toContain(session.accessToken)
      expect(agentSubscription.channel).toBeDefined()
      expect(humanSubscription.channel).toBeDefined()
    } finally {
      if (agentRealtime) await cleanupRealtimeClient(agentRealtime)
      await cleanupRealtimeClient(owner.client)
    }
  })

  it('denies cross-group subscriptions and every Data API or chat use of an agent credential', async () => {
    const { agent, owner } = requireFixtures()
    const allowedGroup = await createGroup(owner, 'Realtime allowed group')
    const deniedGroup = await createGroup(owner, 'Realtime denied group')
    let realtimeClient: SupabaseClient | undefined

    try {
      await insertMembership(allowedGroup.id, agent.principalId)
      const mixedSession = await postAgent(
        agent,
        agoraRequestIdentifiers.createRealtimeSession,
        { groupIds: [allowedGroup.id, deniedGroup.id] }
      )

      expect(mixedSession.status).toBe(403)
      const allowedSession = await postAgent(
        agent,
        agoraRequestIdentifiers.createRealtimeSession,
        { groupIds: [allowedGroup.id] }
      )
      const session = allowedSession.body as AgoraRequestResult<'createRealtimeSession'>

      expect(allowedSession.status).toBe(200)
      realtimeClient = createRealtimeCredentialClient(session.accessToken)
      await realtimeClient.realtime.setAuth(session.accessToken)
      const deniedSubscription = await subscribe(
        realtimeClient,
        formatAgoraRealtimeTopic(deniedGroup.id)
      )

      expect(deniedSubscription.status).not.toBe('SUBSCRIBED')
      const [
        tableRead,
        tableWrite,
        rpcRead,
        dispatcherUse
      ] = await Promise.all([
        realtimeClient.from('messages').select('id'),
        realtimeClient.from('groups').insert({
          name: 'Realtime tokens cannot create groups',
          owner_principal_id: agent.principalId
        }),
        realtimeClient.rpc('get_agora_group_messages', {
          group_id_to_get: allowedGroup.id
        }),
        fetch('http://127.0.0.1:54321/functions/v1/agora', {
          body: JSON.stringify({
            identifier: agoraRequestIdentifiers.listGroups,
            params: {},
            version: 1
          }),
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json'
          },
          method: 'POST'
        })
      ])

      expect(tableRead.error).toBeNull()
      expect(tableRead.data).toEqual([])
      expect(tableWrite.error).not.toBeNull()
      expect(rpcRead.error).not.toBeNull()
      expect(dispatcherUse.status).toBe(401)
      expect(decodeClaims(session.accessToken)).not.toHaveProperty('service_role')
    } finally {
      if (realtimeClient) await cleanupRealtimeClient(realtimeClient)
    }
  })

  it('refreshes with a new bounded session and denies reconnects immediately after removal', async () => {
    const { agent, owner } = requireFixtures()
    const group = await createGroup(owner, 'Realtime removal group')
    let originalClient: SupabaseClient | undefined
    let reconnectClient: SupabaseClient | undefined

    try {
      await insertMembership(group.id, agent.principalId)
      const originalResult = await postAgent(
        agent,
        agoraRequestIdentifiers.createRealtimeSession,
        { groupIds: [group.id] }
      )
      const refreshedResult = await postAgent(
        agent,
        agoraRequestIdentifiers.createRealtimeSession,
        { groupIds: [group.id] }
      )
      const original = originalResult.body as AgoraRequestResult<'createRealtimeSession'>
      const refreshed = refreshedResult.body as AgoraRequestResult<'createRealtimeSession'>

      expect(originalResult.status).toBe(200)
      expect(refreshedResult.status).toBe(200)
      expect(refreshed.accessToken).not.toBe(original.accessToken)
      originalClient = createRealtimeCredentialClient(original.accessToken)
      await originalClient.realtime.setAuth(original.accessToken)
      const liveSubscription = await waitForBroadcast(
        originalClient,
        formatAgoraRealtimeTopic(group.id)
      )

      await expect(liveSubscription.subscribed).resolves.toBe('SUBSCRIBED')
      await originalClient.realtime.setAuth(refreshed.accessToken)
      const beforeRemoval = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'before-removal',
        groupId: group.id,
        text: 'Persisted pre-removal content'
      })

      expect(beforeRemoval.status).toBe(200)
      expectAvailabilityEnvelope(await liveSubscription.event, {
        groupId: group.id,
        highWatermarkSequence: '1'
      })
      const residualEvent = observeBroadcast(liveSubscription.channel)
      const removal = await postHuman(owner, agoraRequestIdentifiers.removeMember, {
        groupId: group.id,
        principalId: agent.principalId
      })

      expect(removal.status).toBe(200)
      const deniedRefresh = await postAgent(
        agent,
        agoraRequestIdentifiers.createRealtimeSession,
        { groupIds: [group.id] }
      )

      expect(deniedRefresh.status).toBe(403)
      reconnectClient = createRealtimeCredentialClient(original.accessToken)
      await reconnectClient.realtime.setAuth(original.accessToken)
      const reconnect = await subscribe(reconnectClient, formatAgoraRealtimeTopic(group.id))

      expect(reconnect.status).not.toBe('SUBSCRIBED')
      await originalClient.realtime.setAuth(refreshed.accessToken)
      const sent = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'after-removal',
        groupId: group.id,
        text: 'Persisted post-removal content'
      })

      expect(sent.status).toBe(200)
      const residual = await observeOptionalBroadcast(residualEvent, 1000)

      if (residual) {
        expectAvailabilityEnvelope(residual, {
          groupId: group.id,
          highWatermarkSequence: '2'
        })
        expect(JSON.stringify(residual)).not.toContain('post-removal content')
        expect(JSON.stringify(residual)).not.toContain(refreshed.accessToken)
      }
    } finally {
      if (originalClient) await cleanupRealtimeClient(originalClient)
      if (reconnectClient) await cleanupRealtimeClient(reconnectClient)
    }
  })
})
