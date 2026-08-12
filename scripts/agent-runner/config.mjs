import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { maximumChunkSize } from './constants.mjs'

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url))
const defaultPromptPath = resolve(moduleDirectory, '../../ops/agent-runner/handler-prompt.md')
const defaultThreadBootstrapPromptPath = resolve(
  moduleDirectory,
  '../../ops/agent-runner/thread-bootstrap-prompt.md'
)
const defaultOutputSchemaPath = resolve(
  moduleDirectory,
  '../../ops/agent-runner/handler-output.schema.json'
)

const requireValue = (environment, name) => {
  const value = environment[name]?.trim()

  if (!value) {
    throw new Error(`Agora runner configuration ${name} is required.`)
  }

  return value
}

const parseInteger = (environment, name, fallback, { minimum, maximum }) => {
  const source = environment[name]

  if (source === undefined) {
    return fallback
  }

  const value = Number(source)

  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Agora runner configuration ${name} is invalid.`)
  }

  return value
}

const parseUrl = (value, name, expectedPath) => {
  let url

  try {
    url = new URL(value)
  } catch {
    throw new Error(`Agora runner configuration ${name} is invalid.`)
  }

  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (expectedPath && url.pathname !== expectedPath)) {
    throw new Error(`Agora runner configuration ${name} is invalid.`)
  }

  return url.toString().replace(/\/$/, '')
}

const requireAbsolutePath = (value, name) => {
  if (!isAbsolute(value)) {
    throw new Error(`Agora runner configuration ${name} must be an absolute path.`)
  }

  return resolve(value)
}

const stateDirectoryFrom = (environment) => {
  const value = environment.AGORA_RUNNER_STATE_DIRECTORY ?? environment.STATE_DIRECTORY

  if (!value || value.includes(':')) {
    throw new Error('Agora runner state directory is required and must name one path.')
  }

  return requireAbsolutePath(value, 'AGORA_RUNNER_STATE_DIRECTORY')
}

export const loadStateDirectory = (environment = process.env) => stateDirectoryFrom(environment)

export const loadRunnerConfig = (environment = process.env) => {
  const api = loadApiConfig(environment)
  const supabaseUrlSource = environment.AGORA_RUNNER_SUPABASE_URL?.trim()
  const workspace = environment.AGORA_RUNNER_WORKSPACE?.trim()
  const codexHome = environment.CODEX_HOME?.trim()
  const agentHome = environment.HOME?.trim()

  if (!workspace) {
    throw new Error('Agora runner workspace is required.')
  }
  if (!codexHome) {
    throw new Error('Agora runner CODEX_HOME is required.')
  }
  if (!agentHome) {
    throw new Error('Agora runner HOME is required.')
  }

  return {
    ...api,
    agentHome: requireAbsolutePath(agentHome, 'HOME'),
    chunkSize: parseInteger(environment, 'AGORA_RUNNER_CHUNK_SIZE', 20, {
      maximum: maximumChunkSize,
      minimum: 1
    }),
    codexBin: environment.AGORA_RUNNER_CODEX_BIN?.trim() || 'codex',
    codexHome: requireAbsolutePath(codexHome, 'CODEX_HOME'),
    handlerOutputSchemaPath: requireAbsolutePath(
      environment.AGORA_RUNNER_HANDLER_SCHEMA?.trim() || defaultOutputSchemaPath,
      'AGORA_RUNNER_HANDLER_SCHEMA'
    ),
    handlerPromptPath: requireAbsolutePath(
      environment.AGORA_RUNNER_HANDLER_PROMPT?.trim() || defaultPromptPath,
      'AGORA_RUNNER_HANDLER_PROMPT'
    ),
    handlerTimeoutMs: parseInteger(environment, 'AGORA_RUNNER_HANDLER_TIMEOUT_MS', 15 * 60_000, {
      maximum: 60 * 60_000,
      minimum: 1000
    }),
    leaseDurationMs: parseInteger(environment, 'AGORA_RUNNER_LEASE_DURATION_MS', 60_000, {
      maximum: 10 * 60_000,
      minimum: 5000
    }),
    maximumHandlerAttempts: parseInteger(environment, 'AGORA_RUNNER_HANDLER_ATTEMPTS', 3, {
      maximum: 10,
      minimum: 1
    }),
    pollIntervalMs: parseInteger(environment, 'AGORA_RUNNER_POLL_INTERVAL_MS', 30_000, {
      maximum: 60 * 60_000,
      minimum: 1000
    }),
    stateDirectory: stateDirectoryFrom(environment),
    supabaseUrl: supabaseUrlSource
      ? parseUrl(supabaseUrlSource, 'AGORA_RUNNER_SUPABASE_URL', '/')
      : undefined,
    threadBootstrapPromptPath: requireAbsolutePath(
      environment.AGORA_RUNNER_THREAD_BOOTSTRAP_PROMPT?.trim()
        || defaultThreadBootstrapPromptPath,
      'AGORA_RUNNER_THREAD_BOOTSTRAP_PROMPT'
    ),
    workspace: requireAbsolutePath(workspace, 'AGORA_RUNNER_WORKSPACE')
  }
}

export function loadApiConfig(environment = process.env) {
  return {
    apiTimeoutMs: parseInteger(environment, 'AGORA_RUNNER_API_TIMEOUT_MS', 15_000, {
      maximum: 120_000,
      minimum: 100
    }),
    apiUrl: parseUrl(
      requireValue(environment, 'AGORA_RUNNER_API_URL'),
      'AGORA_RUNNER_API_URL',
      '/functions/v1/agora'
    ),
    credentialDirectory: requireAbsolutePath(
      requireValue(environment, 'CREDENTIALS_DIRECTORY'),
      'CREDENTIALS_DIRECTORY'
    ),
    maximumRequestAttempts: parseInteger(environment, 'AGORA_RUNNER_REQUEST_ATTEMPTS', 3, {
      maximum: 10,
      minimum: 1
    }),
    publishableKey: environment.AGORA_RUNNER_SUPABASE_PUBLISHABLE_KEY?.trim(),
    retryBaseMs: parseInteger(environment, 'AGORA_RUNNER_RETRY_BASE_MS', 1000, {
      maximum: 60_000,
      minimum: 10
    })
  }
}
