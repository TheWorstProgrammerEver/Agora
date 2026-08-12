export class RunnerCanceledError extends Error {
  constructor() {
    super('Agora runner operation was canceled.')
    this.code = 'canceled'
  }
}

export const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    throw new RunnerCanceledError()
  }
}

export const abortableDelay = (milliseconds, signal) => new Promise((resolve, reject) => {
  throwIfAborted(signal)
  let settled = false
  const finish = (callback) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    callback()
  }
  const onAbort = () => finish(() => reject(new RunnerCanceledError()))
  const timer = setTimeout(() => finish(resolve), milliseconds)

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
})

export const createLinkedTimeout = (signal, timeoutMs) => {
  throwIfAborted(signal)
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(signal?.reason)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
