import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers.ts'
import { createAgoraApiClient } from '../../../scripts/agent-runner/api-client.mjs'
import { loadRunnerConfig } from '../../../scripts/agent-runner/config.mjs'
import { handlerPermissionConfig } from '../../../scripts/agent-runner/codex-handler.mjs'
import { resolveCodexRuntime } from '../../../scripts/agent-runner/codex-runtime.mjs'
import { readAgentCredential } from '../../../scripts/agent-runner/credential.mjs'
import { createAgoraRunner } from '../../../scripts/agent-runner/runner.mjs'
import {
  cleanupGroupLifecycleFixtures,
  createGroup,
  createGroupLifecycleFixtures,
  insertMembership,
  postAgent,
  postHuman
} from './groupLifecycleTestSupport.ts'
import { localSupabasePublicConfig } from './localSupabase.ts'

let fixtures
const runtimeRoots = []
const logger = { event: () => undefined }
const syntheticHandlerIdentity = {
  bootId: randomUUID(),
  pid: 1234,
  platform: 'linux',
  processGroupId: 1234,
  startTimeTicks: '1'
}
const contextCliPath = fileURLToPath(new URL(
  '../../../scripts/agent-runner/context-cli.mjs',
  import.meta.url
))

const requireFixtures = () => {
  if (!fixtures) throw new Error('Agent runner fixtures were not created.')
  return fixtures
}

const waitFor = async (predicate, timeoutMs = 15_000) => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for the agent runner integration fixture.')
}

const createRuntime = async (applicationKey, overrides = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'agora-runner-security-'))
  const credentialDirectory = join(root, 'credentials')
  const handlerWorkspace = join(root, 'handler-workspace')
  const stateDirectory = join(root, 'state')
  runtimeRoots.push(root)
  await mkdir(credentialDirectory, { mode: 0o700 })
  await mkdir(handlerWorkspace, { mode: 0o700 })
  await writeFile(join(credentialDirectory, 'agora-agent-key'), applicationKey, {
    mode: 0o400
  })
  await chmod(join(credentialDirectory, 'agora-agent-key'), 0o400)

  const config = loadRunnerConfig({
    AGORA_RUNNER_API_URL: `${localSupabasePublicConfig.url}/functions/v1/agora`,
    AGORA_RUNNER_HANDLER_TIMEOUT_MS: '60000',
    AGORA_RUNNER_POLL_INTERVAL_MS: '60000',
    AGORA_RUNNER_RETRY_BASE_MS: '10',
    AGORA_RUNNER_STATE_DIRECTORY: stateDirectory,
    AGORA_RUNNER_SUPABASE_PUBLISHABLE_KEY: localSupabasePublicConfig.publishableKey,
    AGORA_RUNNER_SUPABASE_URL: localSupabasePublicConfig.url,
    AGORA_RUNNER_WORKSPACE: handlerWorkspace,
    CREDENTIALS_DIRECTORY: credentialDirectory,
    ...overrides
  })

  return { config, root }
}

const deterministicHandler = (calls, text) => async ({ onHeartbeat, onStarted }) => {
  calls.count += 1
  await onStarted(syntheticHandlerIdentity)
  await onHeartbeat()
  return { messages: [{ text }], version: 1 }
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await Promise.all(runtimeRoots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })))
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('agent runner against local Supabase', () => {
  it('polls, handles, idempotently sends, acknowledges, and resumes its cursor', async () => {
    const { agent, owner } = requireFixtures()
    const group = await createGroup(owner, 'Runner polling integration')
    await insertMembership(group.id, agent.principalId)
    const sent = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
      clientMessageId: `runner-poll-input-${randomUUID()}`,
      groupId: group.id,
      text: 'Please acknowledge this polling integration message.'
    })
    expect(sent.status).toBe(200)
    const calls = { count: 0 }
    const runtime = await createRuntime(agent.applicationKey)
    const runner = createAgoraRunner({
      config: runtime.config,
      handler: deterministicHandler(calls, 'Polling integration acknowledged.'),
      logger
    })
    await runner.initialize()

    await runner.runOnce(new AbortController().signal)
    const afterFirst = await runner.store.read()
    expect(afterFirst.groups[group.id].cursor).toBe('1')
    expect(afterFirst.groups[group.id].lease).toBeUndefined()
    await runner.runOnce(new AbortController().signal)

    const messages = await postAgent(agent, agoraRequestIdentifiers.getGroupMessages, {
      groupId: group.id,
      limit: 100
    })
    expect(messages.status).toBe(200)
    expect(messages.body.items.map(({ text }) => text)).toEqual([
      'Please acknowledge this polling integration message.',
      'Polling integration acknowledged.'
    ])
    expect((await runner.store.read()).groups[group.id].cursor).toBe('2')
    expect(calls.count).toBe(1)
  })

  it('uses private Realtime metadata to fetch and process persisted chat', async () => {
    const { agent, owner } = requireFixtures()
    const group = await createGroup(owner, 'Runner Realtime integration')
    await insertMembership(group.id, agent.principalId)
    const calls = { count: 0 }
    const runtime = await createRuntime(agent.applicationKey)
    const runner = createAgoraRunner({
      config: runtime.config,
      handler: deterministicHandler(calls, 'Realtime integration acknowledged.'),
      logger
    })
    const controller = new AbortController()
    await runner.initialize()
    const running = runner.runRealtime(controller.signal)

    try {
      await waitFor(async () => (
        (await runner.store.read()).lastActivity.code === 'realtime_connected'
      ))
      const sent = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: `runner-realtime-input-${randomUUID()}`,
        groupId: group.id,
        text: 'Please acknowledge this Realtime integration message.'
      })
      expect(sent.status).toBe(200)
      await waitFor(async () => (
        (await runner.store.read()).groups[group.id]?.cursor === '1'
      ))

      const messages = await postAgent(agent, agoraRequestIdentifiers.getGroupMessages, {
        groupId: group.id,
        limit: 100
      })
      expect(messages.status).toBe(200)
      expect(messages.body.items.map(({ text }) => text)).toEqual([
        'Please acknowledge this Realtime integration message.',
        'Realtime integration acknowledged.'
      ])
      expect(calls.count).toBe(1)
    } finally {
      controller.abort()
      await running
    }

    expect((await runner.store.read()).lastActivity).toMatchObject({
      code: 'shutdown',
      status: 'stopped'
    })
  })

  it.skipIf(process.env.AGORA_RUNNER_REAL_CODEX !== 'true')(
    'spawns the installed Codex handler and commits its schema-constrained acknowledgement',
    async () => {
      const { agent, owner } = requireFixtures()
      const group = await createGroup(owner, 'Runner real Codex integration')
      await insertMembership(group.id, agent.principalId)
      const sent = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: `runner-codex-input-${randomUUID()}`,
        groupId: group.id,
        text: 'Use the supplied read-only context CLI to fetch around sequence 1, then return a valid empty action plan without a reply.'
      })
      expect(sent.status).toBe(200)
      const runtime = await createRuntime(agent.applicationKey, {
        AGORA_RUNNER_CODEX_BIN: process.env.AGORA_RUNNER_TEST_CODEX_BIN ?? 'codex',
        AGORA_RUNNER_HANDLER_PROMPT: join(
          process.cwd(),
          'tests/fixtures/agentRunnerContextHandlerPrompt.md'
        ),
        AGORA_RUNNER_HANDLER_TIMEOUT_MS: '600000'
      })
      const codexRuntime = resolveCodexRuntime(runtime.config.codexBin)
      if (process.env.AGORA_RUNNER_REQUIRE_NPM_CODEX === 'true') {
        expect(codexRuntime.executable).toMatch(/[\\/]codex\.js$/)
        expect(codexRuntime.readableDirectories).toHaveLength(2)
      }
      execFileSync(codexRuntime.executable, [
        'sandbox',
        ...handlerPermissionConfig(runtime.config).flatMap((value) => ['-c', value]),
        '--permission-profile', 'agora-handler',
        '--cd', process.cwd(),
        '--',
        '/bin/sh', '-c', 'test ! -r "$1" && test -r "$2"',
        'agora-sandbox-check',
        join(runtime.config.credentialDirectory, 'agora-agent-key'),
        contextCliPath
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      const observed = []
      const baseApi = createAgoraApiClient({
        apiUrl: runtime.config.apiUrl,
        credentialReader: () => readAgentCredential(runtime.config.credentialDirectory),
        maximumAttempts: runtime.config.maximumRequestAttempts,
        publishableKey: runtime.config.publishableKey,
        retryBaseMs: runtime.config.retryBaseMs,
        timeoutMs: runtime.config.apiTimeoutMs
      })
      const api = {
        invoke: (identifier, params, options) => {
          observed.push({ identifier, params })
          return baseApi.invoke(identifier, params, options)
        }
      }
      const runner = createAgoraRunner({ api, config: runtime.config, logger })
      await runner.initialize()

      await runner.runOnce(new AbortController().signal)

      const groupState = (await runner.store.read()).groups[group.id]
      expect(groupState.cursor).toBe('1')
      expect(groupState.lease).toBeUndefined()
      expect(observed).toEqual(expect.arrayContaining([
        expect.objectContaining({
          identifier: 'getGroupMessages',
          params: expect.objectContaining({ aroundSequence: '1', groupId: group.id })
        })
      ]))
      const messages = await postAgent(agent, agoraRequestIdentifiers.getGroupMessages, {
        groupId: group.id,
        limit: 100
      })
      expect(messages.status).toBe(200)
      expect(messages.body.items.map(({ text }) => text)).toEqual([
        'Use the supplied read-only context CLI to fetch around sequence 1, then return a valid empty action plan without a reply.'
      ])
    },
    12 * 60_000
  )
})
