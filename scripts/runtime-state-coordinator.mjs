import { createHash } from 'node:crypto'
import { createServer } from 'node:net'

const firstCoordinatorPort = 49152
const coordinatorPortCount = 12000
const defaultTimeoutMs = 5000
const defaultPollIntervalMs = 25
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const coordinatorPortForKey = (key) => {
  const digest = createHash('sha256').update(key).digest()
  return firstCoordinatorPort + (digest.readUInt16BE(0) % coordinatorPortCount)
}

const tryListen = (port) => new Promise((resolve, reject) => {
  const server = createServer((socket) => socket.destroy())

  server.once('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      resolve(undefined)
      return
    }

    reject(error)
  })
  server.listen({ exclusive: true, host: '127.0.0.1', port }, () => {
    resolve(server)
  })
})

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => {
    if (error) {
      reject(error)
      return
    }

    resolve()
  })
})

export const acquireRuntimeStateCoordinator = async (key, overrides = {}) => {
  const port = overrides.port ?? coordinatorPortForKey(key)
  const wait = overrides.sleep ?? sleep
  const timeoutMs = overrides.timeoutMs ?? defaultTimeoutMs
  const pollIntervalMs = overrides.pollIntervalMs ?? defaultPollIntervalMs
  const deadline = performance.now() + timeoutMs

  while (true) {
    const server = await tryListen(port)

    if (server) {
      return () => close(server)
    }

    if (performance.now() >= deadline) {
      throw new Error('Agora runtime state is busy; retry the lifecycle command.')
    }

    await wait(pollIntervalMs)
  }
}

export const withRuntimeStateCoordinator = async (key, operation, overrides) => {
  const release = await acquireRuntimeStateCoordinator(key, overrides)

  try {
    return await operation()
  } finally {
    await release()
  }
}
