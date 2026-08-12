import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgoraApiError } from '../../../scripts/agent-runner/api-client.mjs'
import { RunnerCanceledError } from '../../../scripts/agent-runner/abort.mjs'
import { HandlerExecutionError } from '../../../scripts/agent-runner/codex-handler.mjs'
import { DurableRunnerStore } from '../../../scripts/agent-runner/durable-store.mjs'
import { AgoraRunner, withExclusiveRunner } from '../../../scripts/agent-runner/runner.mjs'

const roots = []
const principalId = randomUUID()
const groupId = randomUUID()
const ownerPrincipalId = randomUUID()
const humanPrincipalId = randomUUID()
const createdAt = '2026-08-12T00:00:00.000Z'
const logger = { event: () => undefined }
const processIdentity = {
  bootId: randomUUID(),
  pid: 1010,
  platform: 'linux',
  processGroupId: 1010,
  startTimeTicks: '99'
}

class FakeAgora {
  constructor(messages = []) {
    this.messages = messages
    this.idempotent = new Map()
    this.markCalls = []
    this.readThrough = 0n
    this.throwAfterAccept = false
  }

  appendHuman(text) {
    const message = this.#message(text, humanPrincipalId, 'human')
    this.messages.push(message)
    return message
  }

  #message(text, senderId, kind) {
    const sequence = String(this.messages.length + 1)
    return {
      createdAt,
      groupId,
      id: randomUUID(),
      sender: { displayName: kind === 'agent' ? 'Example agent' : 'Example human', id: senderId, kind },
      sequence,
      text
    }
  }

  async invoke(identifier, params) {
    if (identifier === 'listGroups') {
      const unreadCount = this.messages.filter(({ sequence }) => BigInt(sequence) > this.readThrough).length
      return {
        items: [{
          createdAt,
          id: groupId,
          name: 'Example group',
          ownerPrincipalId,
          unreadCount
        }]
      }
    }
    if (identifier === 'getGroup') {
      return {
        currentMember: {
          groupId,
          joinedAt: createdAt,
          principal: { displayName: 'Example agent', id: principalId, kind: 'agent' },
          role: 'member'
        },
        group: { createdAt, id: groupId, name: 'Example group', ownerPrincipalId }
      }
    }
    if (identifier === 'createRealtimeSession') {
      const highWatermarkSequence = String(this.messages.length)
      return {
        accessToken: 'generated.realtime.token',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        refreshAfter: new Date(Date.now() + 240_000).toISOString(),
        topics: params.groupIds.map((id) => ({
          groupId: id,
          highWatermarkSequence,
          topic: `agora:group:${id}`
        }))
      }
    }
    if (identifier === 'getGroupMessages') {
      const items = this.messages
        .filter(({ sequence }) => BigInt(sequence) > BigInt(params.afterSequence ?? 0))
        .slice(0, params.limit)
      return { items }
    }
    if (identifier === 'sendMessage') {
      const existing = this.idempotent.get(params.clientMessageId)
      if (existing) {
        if (existing.text !== params.text) {
          throw new AgoraApiError('idempotency_conflict', { status: 409 })
        }
        return existing
      }
      const sent = this.#message(params.text, principalId, 'agent')
      this.messages.push(sent)
      this.idempotent.set(params.clientMessageId, sent)
      this.readThrough = BigInt(sent.sequence)
      if (this.throwAfterAccept) {
        this.throwAfterAccept = false
        throw new AgoraApiError('transport_failed')
      }
      return sent
    }
    if (identifier === 'markGroupRead') {
      this.markCalls.push(params.throughSequence)
      this.readThrough = this.readThrough > BigInt(params.throughSequence)
        ? this.readThrough
        : BigInt(params.throughSequence)
      return { groupId, sequence: String(this.readThrough) }
    }
    throw new Error(`Unexpected fake request ${identifier}`)
  }
}

const configFor = (stateDirectory, overrides = {}) => ({
  agentHome: stateDirectory,
  apiTimeoutMs: 1000,
  apiUrl: 'https://example.supabase.co/functions/v1/agora',
  chunkSize: 20,
  codexBin: 'codex',
  codexHome: join(stateDirectory, 'codex'),
  credentialDirectory: stateDirectory,
  handlerOutputSchemaPath: join(process.cwd(), 'ops/agent-runner/handler-output.schema.json'),
  handlerPromptPath: join(process.cwd(), 'ops/agent-runner/handler-prompt.md'),
  handlerTimeoutMs: 5000,
  leaseDurationMs: 5000,
  maximumHandlerAttempts: 2,
  maximumRequestAttempts: 1,
  pollIntervalMs: 100,
  publishableKey: 'example-public-key',
  retryBaseMs: 1,
  stateDirectory,
  supabaseUrl: 'https://example.supabase.co',
  threadBootstrapPromptPath: join(process.cwd(), 'ops/agent-runner/thread-bootstrap-prompt.md'),
  workspace: process.cwd(),
  ...overrides
})

const createFixture = async ({
  api = new FakeAgora(),
  handler,
  logger: fixtureLogger = logger,
  realtimeConnector
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'agora-runner-test-'))
  roots.push(root)
  const store = new DurableRunnerStore(root)
  const runner = new AgoraRunner({
    api,
    config: configFor(root),
    handler,
    logger: fixtureLogger,
    realtimeConnector,
    store
  })
  await runner.initialize()
  return { api, root, runner, store }
}

const message = (sequence, text) => ({
  createdAt,
  groupId,
  id: randomUUID(),
  sender: { displayName: 'Example human', id: humanPrincipalId, kind: 'human' },
  sequence: String(sequence),
  text
})

const startHandlerTurn = async ({
  onBootstrapStarted,
  onThreadReady,
  onTurnStarted,
  threadId
}) => {
  if (!threadId) {
    await onBootstrapStarted(processIdentity)
    await onThreadReady(randomUUID())
  }
  await onTurnStarted(processIdentity)
}

const successfulHandler = (calls, reply = 'Example reply') => async (options) => {
  calls.count += 1
  await startHandlerTurn(options)
  await options.onHeartbeat()
  return { messages: [{ text: reply }], version: 1 }
}

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for runner fixture.')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('Agora agent runner orchestration', () => {
  it('excludes concurrent runner instances that share one durable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-runner-test-'))
    roots.push(root)
    const first = new AgoraRunner({
      api: new FakeAgora(),
      config: configFor(root),
      logger,
      store: new DurableRunnerStore(root)
    })
    const second = new AgoraRunner({
      api: new FakeAgora(),
      config: configFor(root),
      logger,
      store: new DurableRunnerStore(root)
    })
    let entered
    let releaseOperation
    const enteredPromise = new Promise((resolve) => { entered = resolve })
    const releasePromise = new Promise((resolve) => { releaseOperation = resolve })
    const active = withExclusiveRunner(first, async () => {
      entered()
      await releasePromise
    })
    await enteredPromise

    await expect(withExclusiveRunner(second, async () => undefined))
      .rejects.toThrow('already active')
    releaseOperation()
    await active
  })

  it('durably commits a successful chunk and consumes its own reply without feedback', async () => {
    const api = new FakeAgora([message(1, 'First'), message(2, 'Second')])
    const calls = { count: 0 }
    const { runner, store } = await createFixture({
      api,
      handler: successfulHandler(calls)
    })

    await runner.runOnce(new AbortController().signal)
    expect((await store.read()).groups[groupId].cursor).toBe('2')
    expect(api.markCalls).toEqual(['2'])
    expect(api.idempotent.size).toBe(1)
    expect(calls.count).toBe(1)

    await runner.runOnce(new AbortController().signal)
    expect((await store.read()).groups[groupId].cursor).toBe('3')
    expect(api.idempotent.size).toBe(1)
    expect(calls.count).toBe(1)
  })

  it('resumes the same group thread after a runner restart', async () => {
    const api = new FakeAgora([message(1, 'First durable turn')])
    const expectedThreadId = randomUUID()
    const observedThreadIds = []
    const handler = async (options) => {
      observedThreadIds.push(options.threadId)
      if (!options.threadId) {
        await options.onBootstrapStarted(processIdentity)
        await options.onThreadReady(expectedThreadId)
      }
      await options.onTurnStarted(processIdentity)
      return { messages: [], version: 1 }
    }
    const first = await createFixture({ api, handler })
    await first.runner.runOnce(new AbortController().signal)
    expect((await first.store.read()).groups[groupId].threadId).toBe(expectedThreadId)

    api.appendHuman('Second durable turn')
    const resumed = new AgoraRunner({
      api,
      config: configFor(first.root),
      handler,
      logger,
      store: new DurableRunnerStore(first.root)
    })
    await resumed.initialize()
    await resumed.runOnce(new AbortController().signal)

    expect(observedThreadIds).toEqual([undefined, expectedThreadId])
    expect((await resumed.store.read()).groups[groupId].threadId).toBe(expectedThreadId)
  })

  it('keeps message text and raw identifiers out of structured runner logs', async () => {
    const input = 'Generated private input marker'
    const reply = 'Generated private reply marker'
    const api = new FakeAgora([message(1, input)])
    const records = []
    const calls = { count: 0 }
    const { runner } = await createFixture({
      api,
      handler: successfulHandler(calls, reply),
      logger: { event: (event, fields = {}) => records.push({ event, ...fields }) }
    })

    await runner.runOnce(new AbortController().signal)

    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain(input)
    expect(serialized).not.toContain(reply)
    expect(serialized).not.toContain(groupId)
    expect(serialized).not.toContain(principalId)
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'chunk_committed', through: '1' })
    ]))
  })

  it('rejects a handler plan that projects its ephemeral context capability', async () => {
    const api = new FakeAgora([message(1, 'Generated capability injection fixture')])
    const { runner } = await createFixture({
      api,
      handler: async (options) => {
        await startHandlerTurn(options)
        const { contextAccess } = options
        return { messages: [{ text: contextAccess.capability }], version: 1 }
      }
    })

    await expect(runner.runOnce(new AbortController().signal))
      .rejects.toMatchObject({ code: 'handler_output_invalid' })
    expect(api.idempotent.size).toBe(0)
    expect(api.markCalls).toEqual([])
  })

  it('replays a durable plan after an accepted send loses its response', async () => {
    const api = new FakeAgora([message(1, 'Please reply once')])
    api.throwAfterAccept = true
    const calls = { count: 0 }
    const first = await createFixture({ api, handler: successfulHandler(calls) })

    await expect(first.runner.runOnce(new AbortController().signal))
      .rejects.toMatchObject({ code: 'transport_failed' })
    expect(api.idempotent.size).toBe(1)
    expect(api.markCalls).toEqual([])
    expect((await first.store.read()).groups[groupId].lease.phase).toBe('planned')

    const resumed = new AgoraRunner({
      api,
      config: configFor(first.root),
      handler: successfulHandler(calls),
      logger,
      store: new DurableRunnerStore(first.root)
    })
    await resumed.initialize()
    await resumed.runOnce(new AbortController().signal)

    expect(api.idempotent.size).toBe(1)
    expect(api.markCalls).toContain('1')
    expect(calls.count).toBe(1)
    expect((await resumed.store.read()).groups[groupId].cursor).toBe('2')
  })

  it('preserves a planned range across credential denial and resumes after rotation', async () => {
    const backing = new FakeAgora([message(1, 'Please survive credential rotation')])
    let denied = true
    const api = {
      invoke: (identifier, params) => {
        if (identifier === 'sendMessage' && denied) {
          throw new AgoraApiError('authentication_denied', { status: 401 })
        }
        return backing.invoke(identifier, params)
      }
    }
    const calls = { count: 0 }
    const first = await createFixture({ api, handler: successfulHandler(calls) })

    await expect(first.runner.runOnce(new AbortController().signal))
      .rejects.toMatchObject({ code: 'authentication_denied' })
    expect(backing.markCalls).toEqual([])
    expect((await first.store.read()).groups[groupId]).toMatchObject({
      cursor: '0',
      lease: { phase: 'planned' }
    })

    denied = false
    const resumed = new AgoraRunner({
      api,
      config: configFor(first.root),
      handler: successfulHandler(calls),
      logger,
      store: new DurableRunnerStore(first.root)
    })
    await resumed.initialize()
    await resumed.runOnce(new AbortController().signal)

    expect(backing.idempotent.size).toBe(1)
    expect(backing.markCalls).toContain('1')
    expect(calls.count).toBe(1)
  })

  it('does not consume handler attempts when credentials rotate before chunk fetch', async () => {
    const backing = new FakeAgora([message(1, 'Please survive pre-plan rotation')])
    let denied = true
    const api = {
      invoke: (identifier, params) => {
        if (identifier === 'getGroupMessages' && denied) {
          throw new AgoraApiError('authentication_denied', { status: 401 })
        }
        return backing.invoke(identifier, params)
      }
    }
    const calls = { count: 0 }
    const fixture = await createFixture({ api, handler: successfulHandler(calls) })

    await expect(fixture.runner.runOnce(new AbortController().signal))
      .rejects.toMatchObject({ code: 'authentication_denied' })
    expect((await fixture.store.read()).groups[groupId]).toMatchObject({ cursor: '0' })
    expect((await fixture.store.read()).groups[groupId].lease).toBeUndefined()
    expect(calls.count).toBe(0)

    denied = false
    await fixture.runner.runOnce(new AbortController().signal)

    expect(calls.count).toBe(1)
    expect(backing.markCalls).toContain('1')
    expect((await fixture.store.read()).groups[groupId].cursor).toBe('1')
  })

  it('does not acknowledge or advance after bounded handler failures', async () => {
    const api = new FakeAgora([message(1, 'Handler should fail')])
    let calls = 0
    const { runner, store } = await createFixture({
      api,
      handler: async (options) => {
        calls += 1
        await startHandlerTurn(options)
        throw new HandlerExecutionError('handler_failed')
      }
    })

    await expect(runner.runOnce(new AbortController().signal))
      .rejects.toMatchObject({ code: 'handler_failed' })
    expect(calls).toBe(1)
    expect(api.markCalls).toEqual([])
    expect((await store.read()).groups[groupId]).toMatchObject({
      cursor: '0',
      lease: { attempt: 1, failureCode: 'turn_indeterminate', phase: 'failed' }
    })
  })

  it('settles cancellation without acknowledgement and requires effect reconciliation', async () => {
    const api = new FakeAgora([message(1, 'Wait for cancellation')])
    const controller = new AbortController()
    let entered
    const enteredPromise = new Promise((resolve) => { entered = resolve })
    const { runner, store } = await createFixture({
      api,
      handler: async (options) => {
        await startHandlerTurn(options)
        entered()
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new RunnerCanceledError())
          options.signal.addEventListener('abort', onAbort, { once: true })
          if (options.signal.aborted) onAbort()
        })
      }
    })
    const running = runner.runOnce(controller.signal)
    await enteredPromise
    controller.abort()

    await expect(running).rejects.toMatchObject({ code: 'canceled' })
    expect(api.markCalls).toEqual([])
    expect((await store.read()).groups[groupId]).toMatchObject({
      cursor: '0',
      lease: { failureCode: 'turn_indeterminate', phase: 'failed' }
    })
  })

  it('coalesces WebSocket hints and fetches persisted messages before handling', async () => {
    const api = new FakeAgora()
    const calls = { count: 0 }
    let realtimeOptions
    let connected
    const connectedPromise = new Promise((resolve) => { connected = resolve })
    let closed = false
    const realtimeConnector = async (options) => {
      realtimeOptions = options
      connected()
      return async () => { closed = true }
    }
    const { runner, store } = await createFixture({
      api,
      handler: successfulHandler(calls, 'Realtime reply'),
      realtimeConnector
    })
    const controller = new AbortController()
    const running = runner.runRealtime(controller.signal)
    await connectedPromise
    const appended = api.appendHuman('Realtime input')

    await Promise.all([
      realtimeOptions.onWatermark(groupId, appended.sequence),
      realtimeOptions.onWatermark(groupId, appended.sequence),
      realtimeOptions.onWatermark(groupId, '0')
    ])
    await waitFor(async () => (await store.read()).groups[groupId]?.cursor === '1')
    controller.abort()
    await running

    expect(calls.count).toBe(1)
    expect(api.markCalls).toContain('1')
    expect(closed).toBe(true)
  })

  it('drops removed group state and does not handle newly hidden messages', async () => {
    const backing = new FakeAgora([message(1, 'Visible message')])
    let visible = true
    const api = {
      invoke: (identifier, params) => (
        identifier === 'listGroups' && !visible
          ? Promise.resolve({ items: [] })
          : backing.invoke(identifier, params)
      )
    }
    const calls = { count: 0 }
    const { runner, store } = await createFixture({
      api,
      handler: successfulHandler(calls)
    })
    await runner.runOnce(new AbortController().signal)

    visible = false
    backing.appendHuman('Hidden after removal')
    await runner.runOnce(new AbortController().signal)

    expect((await store.read()).groups[groupId]).toBeUndefined()
    expect(calls.count).toBe(1)
    expect(backing.markCalls).toEqual(['1'])
  })

  it('refreshes after authorization denial and reconnects after transport loss', async () => {
    const backing = new FakeAgora()
    let denyRefresh = true
    const api = {
      invoke: (identifier, params) => {
        if (identifier === 'listGroups' && denyRefresh) {
          denyRefresh = false
          throw new AgoraApiError('authentication_denied', { status: 401 })
        }
        return backing.invoke(identifier, params)
      }
    }
    let connections = 0
    let closes = 0
    const realtimeConnector = async (options) => {
      connections += 1
      if (connections === 1) queueMicrotask(() => options.onDisconnect('test_disconnect'))
      return async () => { closes += 1 }
    }
    const { runner, store } = await createFixture({ api, realtimeConnector })
    const controller = new AbortController()
    const running = runner.runRealtime(controller.signal)

    await waitFor(async () => (
      connections >= 2
      && (await store.read()).lastActivity.code === 'realtime_connected'
    ))
    controller.abort()
    await running

    expect(connections).toBeGreaterThanOrEqual(2)
    expect(closes).toBe(connections)
    expect((await store.read()).lastActivity.code).toBe('shutdown')
  })

  it('settles a failed Realtime cleanup and exposes bounded shutdown health', async () => {
    let connected
    const connectedPromise = new Promise((resolve) => { connected = resolve })
    const realtimeConnector = async () => {
      connected()
      return async () => { throw new Error('generated cleanup detail') }
    }
    const { runner, store } = await createFixture({ realtimeConnector })
    const controller = new AbortController()
    const running = runner.runRealtime(controller.signal)
    await connectedPromise
    controller.abort()
    await running

    expect((await store.read()).lastActivity).toMatchObject({
      code: 'shutdown_cleanup_failed',
      status: 'stopped'
    })
  })
})
