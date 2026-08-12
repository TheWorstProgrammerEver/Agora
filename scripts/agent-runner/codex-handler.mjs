import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { validateHandlerPlan } from './api-validation.mjs'
import { RunnerCanceledError, throwIfAborted } from './abort.mjs'
import { resolveCodexRuntime } from './codex-runtime.mjs'
import {
  durableProcessIdentity,
  terminateCurrentHandlerGroup
} from './handler-process.mjs'
import { readProcessIdentity } from '../process-identity.mjs'

const apiCliPath = fileURLToPath(new URL('./context-cli.mjs', import.meta.url))
const apiCliDirectory = fileURLToPath(new URL('.', import.meta.url))
const allowedEnvironmentKeys = new Set([
  'CODEX_HOME',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'USER',
  'XDG_CONFIG_HOME'
])

export class HandlerExecutionError extends Error {
  constructor(code) {
    super(`Agora handler failed (${code}).`)
    this.code = code
  }
}

const handlerRuntime = (codexBin) => {
  try {
    return resolveCodexRuntime(codexBin)
  } catch {
    throw new HandlerExecutionError('handler_failed')
  }
}

const filesystemPermissionConfig = (config) => {
  const runtime = config.codexRuntime ?? handlerRuntime(config.codexBin)
  const entries = new Map([
    [':root', 'deny'],
    [':minimal', 'read'],
    [apiCliDirectory, 'read'],
    ...runtime.readableDirectories.map((path) => [path, 'read']),
    [config.credentialDirectory, 'deny']
  ])
  const fields = Array.from(entries, ([path, access]) => (
    `${JSON.stringify(path)} = ${JSON.stringify(access)}`
  ))
  return `permissions.agora-handler.filesystem={ ${fields.join(', ')} }`
}

export const handlerPermissionConfig = (config) => [
  'approval_policy="never"',
  'default_permissions="agora-handler"',
  'permissions.agora-handler.description="Read-only Agora group context"',
  filesystemPermissionConfig(config),
  'permissions.agora-handler.network.enabled=true',
  'permissions.agora-handler.network.allow_local_binding=false',
  'permissions.agora-handler.network.domains={ "127.0.0.1" = "allow" }',
  'shell_environment_policy.inherit="all"',
  'shell_environment_policy.ignore_default_excludes=false',
  'tools.web_search=false',
  'web_search="disabled"'
]

export const buildCodexArgs = ({ config, outputPath, profile }) => [
  'exec',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--strict-config',
  '--model', profile.model,
  '-c', `model_reasoning_effort="${profile.reasoningEffort}"`,
  ...handlerPermissionConfig(config).flatMap((value) => ['-c', value]),
  '--skip-git-repo-check',
  '--cd', config.workspace,
  '--output-schema', config.handlerOutputSchemaPath,
  '--output-last-message', outputPath,
  '--color', 'never',
  '-'
]

const buildHandlerEnvironment = (config, context, contextAccess) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => (
      allowedEnvironmentKeys.has(key) && value !== undefined
    ))
  ),
  AGORA_RUNNER_API_CLI: apiCliPath,
  AGORA_RUNNER_API_TIMEOUT_MS: String(config.apiTimeoutMs),
  AGORA_RUNNER_CONTEXT_CAPABILITY: contextAccess.capability,
  AGORA_RUNNER_CONTEXT_URL: contextAccess.url,
  AGORA_RUNNER_HANDLER_CHUNK_ID: context.chunkId,
  AGORA_RUNNER_HANDLER_GROUP_ID: context.groupId,
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

export const runCodexHandler = async ({
  config,
  context,
  contextAccess,
  onHeartbeat,
  onStarted,
  outputPath,
  profile,
  prompt,
  signal,
  terminationOptions
}) => {
  throwIfAborted(signal)
  if (!contextAccess
    || !/^[A-Za-z0-9_-]{43}$/.test(contextAccess.capability ?? '')
    || typeof contextAccess.url !== 'string') {
    throw new HandlerExecutionError('handler_failed')
  }
  const outputHandle = await open(
    outputPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  )
  await outputHandle.close()
  const codexRuntime = handlerRuntime(config.codexBin)
  const resolvedConfig = {
    ...config,
    codexBin: codexRuntime.executable,
    codexRuntime
  }
  const child = spawn(codexRuntime.executable, buildCodexArgs({
    config: resolvedConfig,
    outputPath,
    profile
  }), {
    cwd: config.workspace,
    detached: true,
    env: buildHandlerEnvironment(config, context, contextAccess),
    stdio: ['pipe', 'ignore', 'ignore']
  })
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
  const acceptTerminal = (outcome) => {
    if (terminalAccepted) return
    terminalAccepted = true
    signal?.removeEventListener('abort', onAbort)
    clearInterval(heartbeat)
    clearTimeout(timeout)
    resolveTerminal(outcome)
  }
  child.once('error', () => {
    if (terminalAccepted) return
    terminalAccepted = true
    signal?.removeEventListener('abort', onAbort)
    clearInterval(heartbeat)
    clearTimeout(timeout)
    rejectTerminal(new HandlerExecutionError('handler_failed'))
  })
  child.once('close', (code, childSignal) => acceptTerminal({ code, signal: childSignal }))

  const terminate = async (code) => {
    if (terminalAccepted || cancellationCode) return
    cancellationCode = code
    if (child.pid) await terminateCurrentHandlerGroup(child.pid, terminationOptions)
  }
  const requestTermination = (code) => {
    void terminate(code).catch(() => {
      if (terminalAccepted) return
      terminalAccepted = true
      signal?.removeEventListener('abort', onAbort)
      clearInterval(heartbeat)
      clearTimeout(timeout)
      rejectTerminal(new HandlerExecutionError('handler_failed'))
    })
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

    return await readHandlerOutput(outputPath)
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
