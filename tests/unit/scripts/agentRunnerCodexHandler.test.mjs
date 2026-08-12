import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunnerCanceledError } from '../../../scripts/agent-runner/abort.mjs'
import {
  buildCodexArgs,
  runCodexHandler
} from '../../../scripts/agent-runner/codex-handler.mjs'
import { isProcessExecuting, readProcessIdentity } from '../../../scripts/process-identity.mjs'

const roots = []
const context = {
  agentPrincipalId: randomUUID(),
  chunkId: 'a'.repeat(64),
  cursor: '0',
  groupId: randomUUID(),
  messages: [],
  through: '1'
}
const profile = { model: 'gpt-5.6-luna', reasoningEffort: 'medium' }
const contextAccess = {
  capability: 'c'.repeat(43),
  url: 'http://127.0.0.1:43210/context'
}

const fixtureConfig = (root, executable) => ({
  apiUrl: 'https://example.supabase.co/functions/v1/agora',
  codexBin: executable,
  credentialDirectory: root,
  handlerOutputSchemaPath: join(process.cwd(), 'ops/agent-runner/handler-output.schema.json'),
  handlerTimeoutMs: 2000,
  leaseDurationMs: 1000,
  publishableKey: 'example-public-key',
  workspace: process.cwd()
})

const createExecutable = async (source) => {
  const root = await mkdtemp(join(tmpdir(), 'agora-handler-test-'))
  roots.push(root)
  const executable = join(root, 'fake-codex.mjs')
  await writeFile(executable, `#!/usr/bin/env node\n${source}`, { mode: 0o700 })
  await chmod(executable, 0o700)
  return { executable, root }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('Codex chunk handler adapter', () => {
  it('uses the exact structured-output stdin contract and observes EOF', async () => {
    const { executable, root } = await createExecutable(`
      import { writeFile } from 'node:fs/promises'
      const args = process.argv.slice(2)
      const output = args[args.indexOf('--output-last-message') + 1]
      let prompt = ''
      for await (const chunk of process.stdin) prompt += chunk
      await writeFile(output, JSON.stringify({ messages: [], version: 1 }))
      await writeFile(output + '.observation', JSON.stringify({
        args,
        contextCapabilityPresent: typeof process.env.AGORA_RUNNER_CONTEXT_CAPABILITY === 'string',
        contextUrlPresent: typeof process.env.AGORA_RUNNER_CONTEXT_URL === 'string',
        credentialDirectoryPresent: Object.hasOwn(process.env, 'CREDENTIALS_DIRECTORY'),
        legacyApiUrlPresent: Object.hasOwn(process.env, 'AGORA_RUNNER_API_URL'),
        prompt
      }))
    `)
    const outputPath = join(root, 'handler-output.json')
    let started

    await expect(runCodexHandler({
      config: fixtureConfig(root, executable),
      context,
      contextAccess,
      onHeartbeat: async () => undefined,
      onStarted: async (identity) => { started = identity },
      outputPath,
      profile,
      prompt: 'Generated prompt marker',
      signal: new AbortController().signal
    })).resolves.toEqual({ messages: [], version: 1 })

    const observation = JSON.parse(await readFile(`${outputPath}.observation`, 'utf8'))
    expect(observation.prompt).toBe('Generated prompt marker')
    expect(observation).toMatchObject({
      contextCapabilityPresent: true,
      contextUrlPresent: true,
      credentialDirectoryPresent: false,
      legacyApiUrlPresent: false
    })
    expect(observation.args.at(-1)).toBe('-')
    expect(observation.args).toContain('--output-schema')
    expect(observation.args).toContain('--output-last-message')
    expect(started.processGroupId).toBe(started.pid)
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600)
  })

  it('settles cancellation and escalates a resistant handler group', async () => {
    const { executable, root } = await createExecutable(`
      import { writeFile } from 'node:fs/promises'
      const args = process.argv.slice(2)
      const output = args[args.indexOf('--output-last-message') + 1]
      await writeFile(output + '.pid', String(process.pid))
      process.on('SIGTERM', () => undefined)
      setInterval(() => undefined, 1000)
    `)
    const outputPath = join(root, 'resistant-output.json')
    const controller = new AbortController()
    let started
    let entered
    const enteredPromise = new Promise((resolve) => { entered = resolve })
    const running = runCodexHandler({
      config: fixtureConfig(root, executable),
      context,
      contextAccess,
      onHeartbeat: async () => undefined,
      onStarted: async (identity) => {
        started = identity
        entered()
      },
      outputPath,
      profile,
      prompt: 'Cancellation fixture',
      signal: controller.signal,
      terminationOptions: { graceMs: 50, killWaitMs: 500 }
    })
    await enteredPromise
    controller.abort()

    await expect(running).rejects.toBeInstanceOf(RunnerCanceledError)
    const current = readProcessIdentity(started.pid)
    expect(isProcessExecuting(current)).toBe(false)
  })

  it('does not spawn when cancellation is already requested', async () => {
    const { executable, root } = await createExecutable('throw new Error("must not run")')
    const controller = new AbortController()
    controller.abort()

    await expect(runCodexHandler({
      config: fixtureConfig(root, executable),
      context,
      contextAccess,
      onHeartbeat: async () => undefined,
      onStarted: async () => undefined,
      outputPath: join(root, 'unused-output.json'),
      profile,
      prompt: 'unused',
      signal: controller.signal
    })).rejects.toBeInstanceOf(RunnerCanceledError)
  })

  it('rejects a handler that replaces its private output with a symlink', async () => {
    const { executable, root } = await createExecutable(`
      import { symlink, unlink, writeFile } from 'node:fs/promises'
      const args = process.argv.slice(2)
      const output = args[args.indexOf('--output-last-message') + 1]
      const target = output + '.target'
      for await (const chunk of process.stdin) void chunk
      await writeFile(target, JSON.stringify({ messages: [], version: 1 }))
      await unlink(output)
      await symlink(target, output)
    `)

    await expect(runCodexHandler({
      config: fixtureConfig(root, executable),
      context,
      contextAccess,
      onHeartbeat: async () => undefined,
      onStarted: async () => undefined,
      outputPath: join(root, 'symlink-output.json'),
      profile,
      prompt: 'Generated prompt marker',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'handler_output_invalid' })
  })

  it('selects model, reasoning, workspace, schema and streaming stdin explicitly', () => {
    const config = fixtureConfig('/tmp/example', process.execPath)
    const args = buildCodexArgs({ config, outputPath: '/tmp/example/output', profile })

    expect(args).toEqual(expect.arrayContaining([
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--model',
      profile.model,
      '-c',
      'model_reasoning_effort="medium"',
      '--output-schema',
      config.handlerOutputSchemaPath,
      '--output-last-message',
      '/tmp/example/output'
    ]))
    expect(args).toEqual(expect.arrayContaining([
      'approval_policy="never"',
      'default_permissions="agora-handler"',
      expect.stringContaining('permissions.agora-handler.filesystem={ ":root" = "deny"'),
      'permissions.agora-handler.network.domains={ "127.0.0.1" = "allow" }',
      'shell_environment_policy.ignore_default_excludes=false',
      'web_search="disabled"'
    ]))
    expect(args).not.toContain('--sandbox')
    expect(args.at(-1)).toBe('-')
  })
})
