import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { startContextBroker } from '../../../scripts/agent-runner/context-broker.mjs'

const brokers = []
const groupId = randomUUID()
const createdAt = '2026-08-12T00:00:00.000Z'

afterEach(async () => {
  await Promise.all(brokers.splice(0).map(({ close }) => close()))
})

describe('agent handler context broker', () => {
  it('offers one ephemeral read-only capability fixed to the leased group', async () => {
    const calls = []
    const api = {
      invoke: async (identifier, params) => {
        calls.push({ identifier, params })
        return {
          items: [{
            createdAt,
            groupId,
            id: randomUUID(),
            sender: {
              displayName: 'Example human',
              id: randomUUID(),
              kind: 'human'
            },
            sequence: '4',
            text: 'Earlier group context'
          }]
        }
      }
    }
    const broker = await startContextBroker({
      api,
      groupId,
      signal: new AbortController().signal
    })
    brokers.push(broker)

    const denied = await fetch(broker.url, {
      body: '{"limit":10}',
      method: 'POST'
    })
    expect(denied.status).toBe(404)
    expect(calls).toHaveLength(0)

    const allowed = await fetch(broker.url, {
      body: '{"beforeSequence":"5","limit":10}',
      headers: { authorization: `Bearer ${broker.capability}` },
      method: 'POST'
    })
    expect(allowed.status).toBe(200)
    await expect(allowed.json()).resolves.toMatchObject({
      items: [{ groupId, sequence: '4' }]
    })
    expect(calls).toEqual([{
      identifier: 'getGroupMessages',
      params: { beforeSequence: '5', groupId, limit: 10 }
    }])

    const invalid = await fetch(broker.url, {
      body: JSON.stringify({ groupId: randomUUID(), limit: 10 }),
      headers: { authorization: `Bearer ${broker.capability}` },
      method: 'POST'
    })
    expect(invalid.status).toBe(503)
    expect(calls).toHaveLength(1)
  })

  it('settles an in-flight context request when the capability closes', async () => {
    let entered
    let aborted = false
    const enteredPromise = new Promise((resolve) => { entered = resolve })
    const api = {
      invoke: async (identifier, params, { signal }) => {
        expect(identifier).toBe('getGroupMessages')
        expect(params).toEqual({ groupId, limit: 10 })
        entered()
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('generated cancellation detail'))
          }, { once: true })
        })
      }
    }
    const broker = await startContextBroker({
      api,
      groupId,
      signal: new AbortController().signal
    })
    brokers.push(broker)
    const request = fetch(broker.url, {
      body: '{"limit":10}',
      headers: { authorization: `Bearer ${broker.capability}` },
      method: 'POST'
    })
    await enteredPromise

    await broker.close()
    await expect(request).rejects.toBeInstanceOf(TypeError)
    expect(aborted).toBe(true)
  })
})
