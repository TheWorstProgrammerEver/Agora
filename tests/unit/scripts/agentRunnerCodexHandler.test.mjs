import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunnerCanceledError } from '../../../scripts/agent-runner/abort.mjs'
import {
  buildBootstrapArgs,
  buildCodexArgs,
  handlerPermissionConfig,
  runCodexHandler
} from '../../../scripts/agent-runner/codex-handler.mjs'
import {
  groupWorkspacePath,
  prepareGroupWorkspace
} from '../../../scripts/agent-runner/group-workspace.mjs'
import { isProcessExecuting, readProcessIdentity } from '../../../scripts/process-identity.mjs'

const roots = []
const threadId = randomUUID()
const workspaceId = randomUUID()
const context = {
  agentPrincipalId: randomUUID(),
  chunkId: 'a'.repeat(64),
  cursor: '0',
  groupId: randomUUID(),
  messages: [],
  through: '1'
}
const contextAccess = {
  capability: 'c'.repeat(43),
  url: 'http://127.0.0.1:43210/context'
}

const fixtureConfig = (root, executable) => ({
  agentHome: root,
  apiUrl: 'https://example.supabase.co/functions/v1/agora',
  codexBin: executable,
  codexHome: join(root, '.codex'),
  credentialDirectory: join(root, 'credentials'),
  handlerOutputSchemaPath: join(process.cwd(), 'ops/agent-runner/handler-output.schema.json'),
  handlerTimeoutMs: 2000,
  leaseDurationMs: 1000,
  publishableKey: 'example-public-key',
  stateDirectory: join(root, 'state'),
  threadBootstrapPromptPath: join(process.cwd(), 'ops/agent-runner/thread-bootstrap-prompt.md'),
  workspace: root
})

const createExecutable = async (source) => {
  const root = await mkdtemp(join(tmpdir(), 'agora-handler-test-'))
  roots.push(root)
  const executable = join(root, 'fake-codex.mjs')
  await writeFile(executable, `#!/usr/bin/env node\n${source}`, { mode: 0o700 })
  await chmod(executable, 0o700)
  return { executable, root }
}

const callbacks = (observed) => ({
  onBootstrapStarted: async (identity) => { observed.bootstrap = identity },
  onBootstrapStarting: async () => undefined,
  onHeartbeat: async () => undefined,
  onThreadReady: async (value) => { observed.threadId = value },
  onTurnStarted: async (identity) => { observed.turn = identity },
  onTurnStarting: async () => undefined
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('Codex host inbox adapter', () => {
  it('creates one durable thread before resuming it with the untrusted turn', async () => {
    const { executable, root } = await createExecutable(`
      import { writeFile } from 'node:fs/promises'
      const args = process.argv.slice(2)
      let prompt = ''
      for await (const chunk of process.stdin) prompt += chunk
      if (args[1] !== 'resume') {
        process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(threadId)} }) + '\\n')
      } else {
        const output = args[args.indexOf('--output-last-message') + 1]
        await writeFile(output, JSON.stringify({ messages: [], version: 1 }))
        await writeFile(output + '.observation', JSON.stringify({
          args,
          codexHome: process.env.CODEX_HOME,
          contextCapabilityPresent: typeof process.env.AGORA_RUNNER_CONTEXT_CAPABILITY === 'string',
          credentialDirectoryPresent: Object.hasOwn(process.env, 'CREDENTIALS_DIRECTORY'),
          hostIntegrationPresent: process.env.AGORA_TEST_HOST_INTEGRATION === 'available',
          home: process.env.HOME,
          prompt,
          workspace: process.cwd()
        }))
      }
    `)
    const outputPath = join(root, 'handler-output.json')
    const observed = {}
    const priorIntegration = process.env.AGORA_TEST_HOST_INTEGRATION
    process.env.AGORA_TEST_HOST_INTEGRATION = 'available'

    try {
      await expect(runCodexHandler({
        ...callbacks(observed),
        config: fixtureConfig(root, executable),
        context,
        contextAccess,
        outputPath,
        prompt: 'Generated prompt marker',
        signal: new AbortController().signal,
        workspaceId
      })).resolves.toEqual({ messages: [], version: 1 })
    } finally {
      if (priorIntegration === undefined) delete process.env.AGORA_TEST_HOST_INTEGRATION
      else process.env.AGORA_TEST_HOST_INTEGRATION = priorIntegration
    }

    const observation = JSON.parse(await readFile(`${outputPath}.observation`, 'utf8'))
    expect(observed.threadId).toBe(threadId)
    expect(observed.bootstrap.processGroupId).toBe(observed.bootstrap.pid)
    expect(observed.turn.processGroupId).toBe(observed.turn.pid)
    expect(observation).toMatchObject({
      contextCapabilityPresent: true,
      codexHome: join(root, '.codex'),
      credentialDirectoryPresent: false,
      hostIntegrationPresent: true,
      home: root,
      prompt: 'Generated prompt marker',
      workspace: await realpath(groupWorkspacePath(
        fixtureConfig(root, executable),
        context,
        workspaceId
      ))
    })
    expect(observation.args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(observation.args.at(-2)).toBe(threadId)
    expect(observation.args.at(-1)).toBe('-')
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600)
  })

  it('resumes an existing group thread without creating another thread', async () => {
    const { executable, root } = await createExecutable(`
      import { writeFile } from 'node:fs/promises'
      const args = process.argv.slice(2)
      if (args[1] !== 'resume') process.exit(91)
      for await (const chunk of process.stdin) void chunk
      const output = args[args.indexOf('--output-last-message') + 1]
      await writeFile(output, JSON.stringify({ messages: [], version: 1 }))
    `)
    const observed = {}

    await expect(runCodexHandler({
      ...callbacks(observed),
      config: fixtureConfig(root, executable),
      context,
      contextAccess,
      outputPath: join(root, 'existing-output.json'),
      prompt: 'Next turn',
      signal: new AbortController().signal,
      threadId,
      workspaceId
    })).resolves.toEqual({ messages: [], version: 1 })
    expect(observed.bootstrap).toBeUndefined()
    expect(observed.threadId).toBeUndefined()
    expect(observed.turn).toBeDefined()
  })

  it('fails closed when bootstrap output does not identify one thread', async () => {
    const { executable, root } = await createExecutable(`
      for await (const chunk of process.stdin) void chunk
      process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')
    `)

    await expect(runCodexHandler({
      ...callbacks({}),
      config: fixtureConfig(root, executable),
      context,
      contextAccess,
      outputPath: join(root, 'missing-thread-output.json'),
      prompt: 'unused',
      signal: new AbortController().signal,
      workspaceId
    })).rejects.toMatchObject({ code: 'handler_failed' })
  })

  it('rejects legacy host sandbox config that would bypass the deny overlay', async () => {
    const { executable, root } = await createExecutable('process.exit(92)')
    const config = fixtureConfig(root, executable)
    await mkdir(config.codexHome, { mode: 0o700 })
    await writeFile(join(config.codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n')

    await expect(runCodexHandler({
      ...callbacks({}),
      config,
      context,
      contextAccess,
      outputPath: join(root, 'legacy-output.json'),
      prompt: 'unused',
      signal: new AbortController().signal,
      workspaceId
    })).rejects.toMatchObject({ code: 'handler_failed' })
  })

  it('settles cancellation and escalates a resistant resumed turn', async () => {
    const { executable, root } = await createExecutable(`
      import { writeFile } from 'node:fs/promises'
      const args = process.argv.slice(2)
      const output = args[args.indexOf('--output-last-message') + 1]
      await writeFile(output + '.pid', String(process.pid))
      process.on('SIGTERM', () => undefined)
      setInterval(() => undefined, 1000)
    `)
    const controller = new AbortController()
    let started
    let entered
    const enteredPromise = new Promise((resolve) => { entered = resolve })
    const running = runCodexHandler({
      ...callbacks({}),
      config: fixtureConfig(root, executable),
      context,
      contextAccess,
      onTurnStarted: async (identity) => {
        started = identity
        entered()
      },
      outputPath: join(root, 'resistant-output.json'),
      prompt: 'Cancellation fixture',
      signal: controller.signal,
      terminationOptions: { graceMs: 50, killWaitMs: 500 },
      threadId,
      workspaceId
    })
    await enteredPromise
    controller.abort()

    await expect(running).rejects.toBeInstanceOf(RunnerCanceledError)
    expect(isProcessExecuting(readProcessIdentity(started.pid))).toBe(false)
  })

  it('uses the real host config without ephemeral, rule, model, or reasoning overrides', () => {
    const config = fixtureConfig('/tmp/example', process.execPath)
    const bootstrap = buildBootstrapArgs({ config })
    const resume = buildCodexArgs({
      config,
      outputPath: '/tmp/example/output',
      threadId
    })

    expect(bootstrap).toEqual(expect.arrayContaining(['exec', '--json', '--cd', config.workspace]))
    expect(resume).toEqual(expect.arrayContaining([
      'exec',
      'resume',
      '--json',
      '--output-schema',
      config.handlerOutputSchemaPath,
      '--output-last-message',
      '/tmp/example/output',
      threadId
    ]))
    for (const forbidden of [
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--model',
      'model_reasoning_effort'
    ]) {
      expect([...bootstrap, ...resume]).not.toContain(forbidden)
    }
  })

  it('denies absent and nested host instructions plus private runner state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-permissions-test-'))
    roots.push(root)
    const config = { ...fixtureConfig(root, process.execPath), workspace: root }
    await Promise.all([
      mkdir(join(config.codexHome, 'sessions'), { mode: 0o700, recursive: true }),
      mkdir(config.credentialDirectory, { mode: 0o700 }),
      mkdir(config.stateDirectory, { mode: 0o700 }),
      writeFile(join(config.workspace, 'AGENTS.md'), 'fixture')
    ])
    await writeFile(join(config.codexHome, 'config.toml'), '')
    const values = handlerPermissionConfig(config)
    const filesystem = values.find((value) => value.startsWith(
      'permissions.agora-inbox.filesystem='
    ))

    expect(filesystem).toContain(`":root" = "read"`)
    expect(filesystem).toContain(`${JSON.stringify(config.workspace)} = "read"`)
    expect(filesystem).toContain(`${JSON.stringify(config.credentialDirectory)} = "deny"`)
    expect(filesystem).toContain(`${JSON.stringify(config.stateDirectory)} = "deny"`)
    expect(filesystem).toContain(`${JSON.stringify(join(config.codexHome, 'sessions'))} = "deny"`)
    expect(filesystem).toContain(`${JSON.stringify(join(config.codexHome, 'config.toml'))} = "read"`)
    expect(filesystem).toContain(`${JSON.stringify(join(config.workspace, 'AGENTS.override.md'))} = "deny"`)
    expect(values).toContain('permissions.agora-inbox.extends=":workspace"')
    expect(values).toContain(
      'permissions.agora-inbox.network.domains={ "*" = "allow", "127.0.0.1" = "allow", "localhost" = "allow" }'
    )
  })

  it('isolates each principal and group in a separate writable workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-workspace-test-'))
    roots.push(root)
    const config = fixtureConfig(root, process.execPath)
    const first = await prepareGroupWorkspace(config, context, workspaceId)
    const otherPrincipal = { ...context, agentPrincipalId: randomUUID() }
    const otherGroup = { ...context, groupId: randomUUID() }
    const second = await prepareGroupWorkspace(config, otherPrincipal, randomUUID())
    const third = await prepareGroupWorkspace(config, otherGroup, randomUUID())
    const retiredWorkspaceId = randomUUID()
    const retired = await prepareGroupWorkspace(config, context, retiredWorkspaceId)
    const refreshed = await prepareGroupWorkspace(config, context, workspaceId)

    expect(first.workspace).toBe(groupWorkspacePath(config, context, workspaceId))
    expect(second.workspace).not.toBe(first.workspace)
    expect(third.workspace).not.toBe(first.workspace)
    expect(refreshed.protectedPaths).toEqual(expect.arrayContaining([
      dirname(dirname(second.workspace)),
      dirname(third.workspace),
      retired.workspace
    ]))
    expect(refreshed.protectedPaths).not.toContain(first.workspace)
  })

  it('rejects a redirected group-workspace root before creating descendants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-workspace-redirect-test-'))
    roots.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'agora-workspace-outside-test-'))
    roots.push(outside)
    await symlink(outside, join(root, '.agora-inbox'))

    await expect(prepareGroupWorkspace(
      fixtureConfig(root, process.execPath),
      context,
      workspaceId
    )).rejects.toMatchObject({ code: 'handler_failed' })
    await expect(stat(join(outside, context.agentPrincipalId))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
