import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { isPositiveSequence, isSequence } from './value-validation.mjs'

const maximumRequestBytes = 16 * 1024

const isAuthorized = (header, capability) => {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(capability)
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
}

const parseRequest = (source) => {
  const value = JSON.parse(source)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
  const keys = Object.keys(value)
  const windowKeys = ['afterSequence', 'aroundSequence', 'beforeSequence']
    .filter((key) => value[key] !== undefined)
  if (keys.some((key) => !['afterSequence', 'aroundSequence', 'beforeSequence', 'limit'].includes(key))
    || windowKeys.length > 1
    || !Number.isSafeInteger(value.limit)
    || value.limit < 1
    || value.limit > 100
    || windowKeys.some((key) => (
      key === 'afterSequence'
        ? !isSequence(value[key])
        : !isPositiveSequence(value[key])
    ))) {
    throw new Error()
  }
  return value
}

const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = []
  let length = 0
  request.on('data', (chunk) => {
    length += chunk.byteLength
    if (length > maximumRequestBytes) {
      reject(new Error('bounded'))
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  request.once('error', reject)
})

const listen = (server) => new Promise((resolve, reject) => {
  const onError = () => reject(new Error('Agora context broker could not start.'))
  server.once('error', onError)
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', onError)
    resolve(server.address())
  })
})

export const startContextBroker = async ({ api, groupId, signal }) => {
  if (signal?.aborted) throw new Error('Agora context broker could not start.')
  const capability = randomBytes(32).toString('base64url')
  const controllers = new Set()
  const sockets = new Set()
  let closed = false
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json')
    if (closed
      || request.method !== 'POST'
      || request.url !== '/context'
      || !isAuthorized(request.headers.authorization, capability)) {
      response.writeHead(404)
      response.end('{"error":"context_unavailable"}')
      return
    }

    try {
      const params = parseRequest(await readBody(request))
      const controller = new AbortController()
      controllers.add(controller)
      const onAbort = () => controller.abort()
      const onResponseClose = () => {
        if (!response.writableEnded) controller.abort()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      response.once('close', onResponseClose)
      if (signal?.aborted) onAbort()
      let result
      try {
        result = await api.invoke('getGroupMessages', { groupId, ...params }, {
          signal: controller.signal
        })
      } finally {
        controllers.delete(controller)
        signal?.removeEventListener('abort', onAbort)
        response.removeListener('close', onResponseClose)
      }
      if (closed || response.destroyed) return
      response.writeHead(200)
      response.end(JSON.stringify(result))
    } catch {
      if (response.destroyed) return
      response.writeHead(503)
      response.end('{"error":"context_unavailable"}')
    }
  })
  server.headersTimeout = 5000
  server.keepAliveTimeout = 1000
  server.requestTimeout = 30_000
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const address = await listen(server)

  return {
    capability,
    close: async () => {
      if (closed) return
      closed = true
      for (const controller of controllers) controller.abort()
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
    },
    url: `http://127.0.0.1:${address.port}/context`
  }
}
