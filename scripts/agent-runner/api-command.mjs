import { readBoundedResponse } from './api-client.mjs'
import { validateAgoraResult } from './api-validation.mjs'
import { isPositiveSequence, isSequence, isUuid } from './value-validation.mjs'

const readOptions = (args) => {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined || Object.hasOwn(options, name)) {
      throw new Error('Agora runner API arguments are invalid.')
    }
    options[name] = value
  }
  return options
}

const contextUrl = (source) => {
  let url
  try {
    url = new URL(source)
  } catch {
    throw new Error('Agora runner context capability is invalid.')
  }
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.pathname !== '/context'
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new Error('Agora runner context capability is invalid.')
  }
  return url.toString()
}

const requestParams = (args) => {
  const options = readOptions(args)
  const windows = [
    ['--after-sequence', 'afterSequence'],
    ['--around-sequence', 'aroundSequence'],
    ['--before-sequence', 'beforeSequence']
  ].filter(([flag]) => options[flag] !== undefined)
  const allowed = new Set(['--after-sequence', '--around-sequence', '--before-sequence', '--limit'])
  if (Object.keys(options).some((name) => !allowed.has(name))
    || windows.length > 1
    || windows.some(([flag]) => (
      flag === '--after-sequence'
        ? !isSequence(options[flag])
        : !isPositiveSequence(options[flag])
    ))) {
    throw new Error('Agora runner API arguments are invalid.')
  }
  const limit = options['--limit'] === undefined ? 50 : Number(options['--limit'])
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Agora runner API arguments are invalid.')
  }
  const window = windows[0]
  return { limit, ...(window ? { [window[1]]: options[window[0]] } : {}) }
}

export const runApiCommand = async (
  args,
  environment = process.env,
  write = (source) => process.stdout.write(source)
) => {
  if (args[0] !== 'get-group-messages') {
    throw new Error('Agora runner API command is not supported.')
  }
  const groupId = environment.AGORA_RUNNER_HANDLER_GROUP_ID
  const chunkId = environment.AGORA_RUNNER_HANDLER_CHUNK_ID
  const capability = environment.AGORA_RUNNER_CONTEXT_CAPABILITY
  if (!isUuid(groupId)
    || !/^[0-9a-f]{64}$/.test(chunkId ?? '')
    || !/^[A-Za-z0-9_-]{43}$/.test(capability ?? '')) {
    throw new Error('Agora runner context capability is invalid.')
  }

  const timeoutMs = Number(environment.AGORA_RUNNER_API_TIMEOUT_MS ?? 15_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error('Agora runner context capability is invalid.')
  }
  const response = await fetch(contextUrl(environment.AGORA_RUNNER_CONTEXT_URL), {
    body: JSON.stringify(requestParams(args.slice(1))),
    headers: {
      authorization: `Bearer ${capability}`,
      'content-type': 'application/json'
    },
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs)
  })
  const source = await readBoundedResponse(response)
  if (!response.ok) throw new Error('Agora runner context is unavailable.')
  let result
  try {
    result = validateAgoraResult('getGroupMessages', JSON.parse(source))
  } catch {
    throw new Error('Agora runner context is unavailable.')
  }
  if (result.items.some((message) => message.groupId !== groupId)) {
    throw new Error('Agora runner context is unavailable.')
  }
  write(`${JSON.stringify(result)}\n`)
}
