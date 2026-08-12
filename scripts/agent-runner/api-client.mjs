import { abortableDelay, createLinkedTimeout, RunnerCanceledError } from './abort.mjs'
import { maximumApiResponseBytes } from './constants.mjs'
import { validateAgoraResult } from './api-validation.mjs'

export class AgoraApiError extends Error {
  constructor(code, { retryable = false, status } = {}) {
    super(`Agora API request failed (${code}).`)
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

export const readBoundedResponse = async (response) => {
  const declaredLength = Number(response.headers.get('content-length'))

  if (Number.isFinite(declaredLength) && declaredLength > maximumApiResponseBytes) {
    throw new AgoraApiError('response_too_large')
  }

  const reader = response.body?.getReader()

  if (!reader) return ''
  const chunks = []
  let byteLength = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maximumApiResponseBytes) {
        await reader.cancel().catch(() => undefined)
        throw new AgoraApiError('response_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(bytes)
}

const statusError = (status) => {
  if (status === 401) return new AgoraApiError('authentication_denied', { status })
  if (status === 403) return new AgoraApiError('authorization_denied', { status })
  if (status === 404) return new AgoraApiError('resource_unavailable', { status })
  if (status === 409) return new AgoraApiError('idempotency_conflict', { status })
  if (status === 429 || status >= 500) {
    return new AgoraApiError('temporarily_unavailable', { retryable: true, status })
  }
  return new AgoraApiError('request_rejected', { status })
}

const parseResponse = (identifier, source) => {
  let value

  try {
    value = JSON.parse(source)
  } catch {
    throw new AgoraApiError('response_invalid', { retryable: true })
  }

  try {
    return validateAgoraResult(identifier, value)
  } catch {
    throw new AgoraApiError('response_invalid', { retryable: true })
  }
}

const requestOnce = async ({
  apiUrl,
  credentialReader,
  fetchImpl,
  identifier,
  params,
  publishableKey,
  signal,
  timeoutMs
}) => {
  const timeout = createLinkedTimeout(signal, timeoutMs)

  try {
    const credential = await credentialReader()
    let response

    try {
      response = await fetchImpl(apiUrl, {
        body: JSON.stringify({ identifier, params, version: 1 }),
        headers: {
          ...(publishableKey ? { apikey: publishableKey } : {}),
          'content-type': 'application/json',
          'x-agora-agent-key': credential
        },
        method: 'POST',
        signal: timeout.signal
      })
    } catch {
      if (signal?.aborted) throw new RunnerCanceledError()
      throw new AgoraApiError(timeout.timedOut() ? 'request_timeout' : 'transport_failed', {
        retryable: true
      })
    }

    let source
    try {
      source = await readBoundedResponse(response)
    } catch (error) {
      if (signal?.aborted) throw new RunnerCanceledError()
      if (error instanceof AgoraApiError) throw error
      throw new AgoraApiError('response_failed', { retryable: true })
    }

    if (!response.ok) {
      throw statusError(response.status)
    }

    return parseResponse(identifier, source)
  } finally {
    timeout.dispose()
  }
}

export const createAgoraApiClient = ({
  apiUrl,
  credentialReader,
  fetchImpl = fetch,
  maximumAttempts,
  publishableKey,
  retryBaseMs,
  sleep = abortableDelay,
  timeoutMs
}) => ({
  invoke: async (identifier, params, { signal } = {}) => {
    let lastError

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await requestOnce({
          apiUrl,
          credentialReader,
          fetchImpl,
          identifier,
          params,
          publishableKey,
          signal,
          timeoutMs
        })
      } catch (error) {
        if (error instanceof RunnerCanceledError) throw error
        lastError = error instanceof AgoraApiError
          ? error
          : new AgoraApiError('request_failed')

        if (!lastError.retryable || attempt === maximumAttempts) {
          throw lastError
        }

        await sleep(retryBaseMs * (2 ** (attempt - 1)), signal)
      }
    }

    throw lastError ?? new AgoraApiError('request_failed')
  }
})
