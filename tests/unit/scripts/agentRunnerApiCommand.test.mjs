import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { runApiCommand } from '../../../scripts/agent-runner/api-command.mjs'

const servers = []
const groupId = randomUUID()
const senderId = randomUUID()
const chunkId = 'd'.repeat(64)
const createdAt = '2026-08-12T00:00:00.000Z'
const capability = 'c'.repeat(43)

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve())
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
})

describe('agent handler read-only API command', () => {
  it('fetches only the fixed handler group through the canonical API', async () => {
    let observed
    const server = createServer((request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        observed = {
          authorization: request.headers.authorization,
          params: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          method: request.method,
          url: request.url
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          items: [{
            createdAt,
            groupId,
            id: randomUUID(),
            sender: { displayName: 'Example human', id: senderId, kind: 'human' },
            sequence: '5',
            text: 'Earlier context'
          }]
        }))
      })
    })
    servers.push(server)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    let output = ''

    await runApiCommand([
      'get-group-messages',
      '--after-sequence', '4',
      '--limit', '10'
    ], {
      AGORA_RUNNER_CONTEXT_CAPABILITY: capability,
      AGORA_RUNNER_CONTEXT_URL: `http://127.0.0.1:${port}/context`,
      AGORA_RUNNER_HANDLER_CHUNK_ID: chunkId,
      AGORA_RUNNER_HANDLER_GROUP_ID: groupId,
      AGORA_RUNNER_API_TIMEOUT_MS: '1000'
    }, (source) => { output += source })

    expect(observed).toEqual({
      authorization: `Bearer ${capability}`,
      method: 'POST',
      params: { afterSequence: '4', limit: 10 },
      url: '/context'
    })
    expect(JSON.parse(output)).toMatchObject({
      items: [{ groupId, sequence: '5', text: 'Earlier context' }]
    })
    expect(output).not.toContain(capability)
  })

  it('rejects unsupported operations and ambiguous context windows', async () => {
    const environment = {
      AGORA_RUNNER_HANDLER_CHUNK_ID: chunkId,
      AGORA_RUNNER_HANDLER_GROUP_ID: groupId,
      AGORA_RUNNER_CONTEXT_CAPABILITY: capability,
      AGORA_RUNNER_CONTEXT_URL: 'http://127.0.0.1:43210/context'
    }

    await expect(runApiCommand(['send-message'], environment))
      .rejects.toThrow('not supported')
    await expect(runApiCommand([
      'get-group-messages',
      '--after-sequence', '4',
      '--before-sequence', '5'
    ], environment)).rejects.toThrow('arguments are invalid')
    await expect(runApiCommand([
      'get-group-messages',
      '--around-sequence', '0'
    ], environment)).rejects.toThrow('arguments are invalid')
  })
})
