import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateHandlerPlan } from './api-validation.mjs'
import { RunnerCanceledError, throwIfAborted } from './abort.mjs'
import { resolveCodexRuntime } from './codex-runtime.mjs'
import { prepareGroupWorkspace } from './group-workspace.mjs'
import { HandlerExecutionError } from './handler-error.mjs'
import {
  durableProcessIdentity,
  terminateCurrentHandlerGroup
} from './handler-process.mjs'
import { isUuid } from './value-validation.mjs'
import { readProcessIdentity } from '../process-identity.mjs'

const apiCliPath = fileURLToPath(new URL('./context-cli.mjs', import.meta.url))
const maximumEventBytes = 256 * 1024
const transportEnvironmentPattern = /^(?:AGORA_RUNNER_|CREDENTIALS_DIRECTORY$)/

export { HandlerExecutionError } from './handler-error.mjs'

const handlerRuntime = (codexBin) => {
  try {
    return resolveCodexRuntime(codexBin)
  } catch {
    throw new HandlerExecutionError('handler_failed')
  }
}

const protectedCodexPaths = (config, protectedPaths) => {
  const codexHome = config.codexHome
  const candidates = [
    [config.workspace, 'read'],
    [join(config.workspace, 'AGENTS.md'), 'deny'],
    [join(config.workspace, 'AGENTS.override.md'), 'deny'],
    [join(codexHome, 'config.toml'), 'read'],
    [join(codexHome, 'plugins'), 'read'],
    [join(codexHome, 'rules'), 'read'],
    [join(codexHome, 'skills'), 'read'],
    [join(codexHome, '.credentials.json'), 'deny'],
    [join(codexHome, 'auth.json'), 'deny'],
    [join(codexHome, 'history.jsonl'), 'deny'],
    [join(codexHome, 'sessions'), 'deny'],
    [join(codexHome, 'archived_sessions'), 'deny'],
    [join(codexHome, 'shell_snapshots'), 'deny'],
    [join(codexHome, 'thread-writer-locks'), 'deny'],
    [join(codexHome, 'thread_history_1.sqlite'), 'deny'],
    [config.credentialDirectory, 'deny'],
    [config.stateDirectory, 'deny'],
    ...protectedPaths.map((path) => [path, 'deny'])
  ]
  return new Map(candidates.filter(([path]) => typeof path === 'string'))
}

const filesystemPermissionConfig = (config, protectedPaths) => {
  const entries = new Map([
    [':root', 'read'],
    ...protectedCodexPaths(config, protectedPaths)
  ])
  const fields = Array.from(entries, ([path, access]) => (
    `${JSON.stringify(path)} = ${JSON.stringify(access)}`
  ))
  return `permissions.agora-inbox.filesystem={ ${fields.join(', ')} }`
}

export const handlerPermissionConfig = (config, { protectedPaths = [] } = {}) => [
  'approval_policy="never"',
  'default_permissions="agora-inbox"',
  'permissions.agora-inbox.description="Host agent permissions with Agora isolation"',
  'permissions.agora-inbox.extends=":workspace"',
  filesystemPermissionConfig(config, protectedPaths),
  'permissions.agora-inbox.network.enabled=true',
  'permissions.agora-inbox.network.allow_local_binding=false',
  'permissions.agora-inbox.network.domains={ "*" = "allow", "127.0.0.1" = "allow", "localhost" = "allow" }',
  'shell_environment_policy.inherit="all"',
  'shell_environment_policy.ignore_default_excludes=false'
]

const assertPermissionProfileCompatibility = async (config) => {
  let source
  try {
    source = await readFile(join(config.codexHome, 'config.toml'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw new HandlerExecutionError('handler_failed')
  }

  const activeLines = source
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter(Boolean)
  if (activeLines.some((line) => (
    /^sandbox_mode\s*=/.test(line) || /^\[sandbox_workspace_write(?:\.|\])/.test(line)
  ))) {
    throw new HandlerExecutionError('handler_failed')
  }
}

const commonCodexArgs = (config, options) => [
  '--strict-config',
  ...handlerPermissionConfig(config, options).flatMap((value) => ['-c', value]),
  '--skip-git-repo-check'
]

export const buildBootstrapArgs = ({
  config,
  protectedPaths = [],
  workspace = config.workspace
}) => [
  'exec',
  '--json',
  ...commonCodexArgs(config, { protectedPaths }),
  '--cd', workspace,
  '-'
]

export const buildCodexArgs = ({ config, outputPath, protectedPaths = [], threadId }) => [
  'exec',
  'resume',
  '--json',
  ...commonCodexArgs(config, { protectedPaths }),
  '--output-schema', config.handlerOutputSchemaPath,
  '--output-last-message', outputPath,
  threadId,
  '-'
]

const buildHandlerEnvironment = (config, context, contextAccess) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => (
      !transportEnvironmentPattern.test(key) && value !== undefined
    ))
  ),
  CODEX_HOME: config.codexHome,
  HOME: config.agentHome ?? process.env.HOME,
  AGORA_RUNNER_API_CLI: apiCliPath,
  AGORA_RUNNER_CONTEXT_CAPABILITY: contextAccess.capability,
  AGORA_RUNNER_CONTEXT_URL: contextAccess.url,
  AGORA_RUNNER_HANDLER_CHUNK_ID: context.chunkId,
  AGORA_RUNNER_HANDLER_GROUP_ID: context.groupId
})

const waitForIdentity = async (pid) => {
  const deadline = performance.now() + 2000

  while (performance.now() < deadline) {
    const identity = readProcessIdentity(pid)
    if (identity) return durableProcessIdentity(identity)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new HandlerExecutionError('handler_failed')
}

const readHandlerOutput = async (outputPath) => {
  let handle

  try {
    handle = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const outputStat = await handle.stat()
    if (!outputStat.isFile()
      || outputStat.uid !== process.getuid?.()
      || outputStat.nlink !== 1
      || (outputStat.mode & 0o077) !== 0
      || outputStat.size > 32 * 1024) {
      throw new HandlerExecutionError('handler_output_invalid')
    }
    return validateHandlerPlan(JSON.parse(await handle.readFile({ encoding: 'utf8' })))
  } catch {
    throw new HandlerExecutionError('handler_output_invalid')
  } finally {
    await handle?.close()
  }
}

const threadIdFromEvents = (source) => {
  let threadId

  for (const line of source.split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      throw new HandlerExecutionError('handler_failed')
    }
    if (event?.type !== 'thread.started') continue
    if (!isUuid(event.thread_id) || (threadId && threadId !== event.thread_id)) {
      throw new HandlerExecutionError('handler_failed')
    }
    threadId = event.thread_id
  }

  if (!threadId) throw new HandlerExecutionError('handler_failed')
  return threadId
}

const runCodexProcess = async ({
  args,
  config,
  environment,
  onHeartbeat,
  onStarting,
  onStarted,
  prompt,
  signal,
  terminationOptions,
  workspace,
  captureOutput = false
}) => {
  throwIfAborted(signal)
  await onStarting()
  throwIfAborted(signal)
  const child = spawn(config.codexBin, args, {
    cwd: workspace,
    detached: true,
    env: environment,
    stdio: ['pipe', captureOutput ? 'pipe' : 'ignore', 'ignore']
  })
  let captured = ''
  let terminalAccepted = false
  let cancellationCode
  let heartbeat
  let timeout
  let resolveTerminal
  let rejectTerminal
  const terminalPromise = new Promise((resolve, reject) => {
    resolveTerminal = resolve
    rejectTerminal = reject
  })
  const finish = (callback, outcome) => {
    if (terminalAccepted) return
    terminalAccepted = true
    signal?.removeEventListener('abort', onAbort)
    clearInterval(heartbeat)
    clearTimeout(timeout)
    callback(outcome)
  }
  const acceptTerminal = (outcome) => finish(resolveTerminal, outcome)
  child.once('error', () => finish(
    rejectTerminal,
    new HandlerExecutionError('handler_failed')
  ))
  child.once('close', (code, childSignal) => acceptTerminal({ code, signal: childSignal }))
  child.stdout?.on('data', (chunk) => {
    if (captured.length > maximumEventBytes) return
    captured += chunk.toString('utf8')
    if (Buffer.byteLength(captured) > maximumEventBytes) {
      void terminate('handler_failed')
    }
  })

  const terminate = async (code) => {
    if (terminalAccepted || cancellationCode) return
    cancellationCode = code
    if (child.pid) await terminateCurrentHandlerGroup(child.pid, terminationOptions)
  }
  const requestTermination = (code) => {
    void terminate(code).catch(() => finish(
      rejectTerminal,
      new HandlerExecutionError('handler_failed')
    ))
  }
  const onAbort = () => requestTermination('canceled')
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  try {
    if (!child.pid) throw new HandlerExecutionError('handler_failed')
    const identity = await Promise.race([
      waitForIdentity(child.pid),
      terminalPromise.then(() => {
        if (cancellationCode === 'canceled') throw new RunnerCanceledError()
        throw new HandlerExecutionError(cancellationCode ?? 'handler_failed')
      })
    ])
    await onStarted(identity)
    heartbeat = setInterval(() => {
      void onHeartbeat().catch(() => requestTermination('handler_failed'))
    }, Math.max(1000, Math.floor(config.leaseDurationMs / 3)))
    timeout = setTimeout(() => requestTermination('handler_timeout'), config.handlerTimeoutMs)
    child.stdin.on('error', () => undefined)
    child.stdin.end(prompt)

    const terminal = await terminalPromise
    await terminateCurrentHandlerGroup(child.pid, terminationOptions)
    if (cancellationCode === 'canceled') throw new RunnerCanceledError()
    if (cancellationCode) throw new HandlerExecutionError(cancellationCode)
    if (terminal.code !== 0 || terminal.signal !== null) {
      throw new HandlerExecutionError('handler_failed')
    }
    return captured
  } catch (error) {
    if (child.pid) {
      await terminateCurrentHandlerGroup(child.pid, terminationOptions).catch(() => undefined)
    }
    if (error instanceof RunnerCanceledError || error instanceof HandlerExecutionError) throw error
    throw new HandlerExecutionError('handler_failed')
  } finally {
    signal?.removeEventListener('abort', onAbort)
    clearInterval(heartbeat)
    clearTimeout(timeout)
  }
}

export const runCodexHandler = async ({
  config,
  context,
  contextAccess,
  onBootstrapStarted,
  onBootstrapStarting,
  onHeartbeat,
  onThreadReady,
  onTurnStarted,
  onTurnStarting,
  outputPath,
  prompt,
  signal,
  terminationOptions,
  threadId,
  workspaceId
}) => {
  throwIfAborted(signal)
  if (!contextAccess
    || !/^[A-Za-z0-9_-]{43}$/.test(contextAccess.capability ?? '')
    || typeof contextAccess.url !== 'string') {
    throw new HandlerExecutionError('handler_failed')
  }
  await assertPermissionProfileCompatibility(config)
  const codexRuntime = handlerRuntime(config.codexBin)
  const resolvedConfig = {
    ...config,
    codexBin: codexRuntime.executable,
    codexRuntime
  }
  const environment = buildHandlerEnvironment(config, context, contextAccess)
  const groupWorkspace = await prepareGroupWorkspace(config, context, workspaceId)
  let boundThreadId = threadId

  if (!boundThreadId) {
    const bootstrapPrompt = await readFile(config.threadBootstrapPromptPath, 'utf8')
    const events = await runCodexProcess({
      args: buildBootstrapArgs({
        config: resolvedConfig,
        protectedPaths: groupWorkspace.protectedPaths,
        workspace: groupWorkspace.workspace
      }),
      captureOutput: true,
      config: resolvedConfig,
      environment,
      onHeartbeat,
      onStarting: onBootstrapStarting,
      onStarted: onBootstrapStarted,
      prompt: bootstrapPrompt,
      signal,
      terminationOptions,
      workspace: groupWorkspace.workspace
    })
    boundThreadId = threadIdFromEvents(events)
    await onThreadReady(boundThreadId)
  }

  const outputHandle = await open(
    outputPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  )
  await outputHandle.close()
  await runCodexProcess({
    args: buildCodexArgs({
      config: resolvedConfig,
      outputPath,
      protectedPaths: groupWorkspace.protectedPaths,
      threadId: boundThreadId
    }),
    config: resolvedConfig,
    environment,
    onHeartbeat,
    onStarting: onTurnStarting,
    onStarted: onTurnStarted,
    prompt,
    signal,
    terminationOptions,
    workspace: groupWorkspace.workspace
  })
  return await readHandlerOutput(outputPath)
}
