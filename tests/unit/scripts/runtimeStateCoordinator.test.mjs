import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  claimRuntimeIdentity,
  clearRuntimeIdentity
} from '../../../scripts/managed-runtime.mjs'
import { acquireRuntimeStateCoordinator } from '../../../scripts/runtime-state-coordinator.mjs'

const staleIdentity = {
  bootId: '01234567-89ab-cdef-0123-456789abcdef',
  marker: 'agora:0123456789abcdef',
  pid: 4242,
  platform: 'linux',
  startTimeTicks: '123456',
  version: 2
}

const replacementIdentity = {
  ...staleIdentity,
  marker: 'agora:fedcba9876543210',
  pid: 4343,
  startTimeTicks: '654321'
}

const deferred = () => {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })

  return { promise, resolve }
}

const getAvailablePort = () => new Promise((resolve, reject) => {
  const server = createServer()

  server.once('error', reject)
  server.listen({ host: '127.0.0.1', port: 0 }, () => {
    const address = server.address()

    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve(address.port)
    })
  })
})

describe('runtime state coordination', () => {
  it('admits one replacement when stale recoverers contend', async () => {
    const port = await getAvailablePort()
    const firstEntered = deferred()
    const finishFirst = deferred()
    const secondWaiting = deferred()
    const retrySecond = deferred()
    const inspectedMarkers = []
    let state = staleIdentity
    let first
    let second

    const shared = {
      clearIdentity: (expected) => {
        if (state?.marker === expected.marker) {
          state = undefined
          return true
        }

        return false
      },
      inspectProcess: async (candidate) => {
        inspectedMarkers.push(candidate.marker)
        return candidate.marker === staleIdentity.marker ? 'unowned' : 'owned'
      },
      readIdentity: () => state,
      writeIdentity: (candidate) => {
        if (state) {
          const error = new Error('exists')
          error.code = 'EEXIST'
          throw error
        }

        state = candidate
      }
    }

    try {
      first = claimRuntimeIdentity({
        ...shared,
        coordinatorOptions: { port },
        createIdentity: async () => {
          firstEntered.resolve()
          await finishFirst.promise
          return replacementIdentity
        }
      })
      await firstEntered.promise

      second = claimRuntimeIdentity({
        ...shared,
        coordinatorOptions: {
          pollIntervalMs: 1,
          port,
          sleep: async () => {
            secondWaiting.resolve()
            await retrySecond.promise
          },
          timeoutMs: 1000
        },
        createIdentity: async () => ({
          ...replacementIdentity,
          marker: 'agora:aaaaaaaaaaaaaaaa',
          pid: 4444
        })
      })
      await secondWaiting.promise

      expect(state).toBeUndefined()
      expect(inspectedMarkers).toEqual([staleIdentity.marker])

      finishFirst.resolve()
      await expect(first).resolves.toEqual(replacementIdentity)
      retrySecond.resolve()

      await expect(second).rejects.toThrow('another Agora get-going process is active')
      expect(state).toEqual(replacementIdentity)
      expect(inspectedMarkers).toEqual([
        staleIdentity.marker,
        replacementIdentity.marker
      ])
    } finally {
      finishFirst.resolve()
      retrySecond.resolve()
      await Promise.allSettled([first, second].filter(Boolean))
    }
  })

  it('leaves a replacement owner intact when an old release was delayed', async () => {
    const port = await getAvailablePort()
    const key = 'agora-runtime-delayed-release-fixture'
    const releaseCoordinator = await acquireRuntimeStateCoordinator(key, { port })
    const delayedReleaseWaiting = deferred()
    const retryDelayedRelease = deferred()
    const removeIdentity = vi.fn(() => {
      state = undefined
    })
    let state = staleIdentity
    let delayedRelease

    try {
      delayedRelease = clearRuntimeIdentity(staleIdentity, {
        coordinatorOptions: {
          pollIntervalMs: 1,
          port,
          sleep: async () => {
            delayedReleaseWaiting.resolve()
            await retryDelayedRelease.promise
          },
          timeoutMs: 1000
        },
        readIdentity: () => state,
        removeIdentity
      })
      await delayedReleaseWaiting.promise

      state = replacementIdentity
      await releaseCoordinator()
      retryDelayedRelease.resolve()

      await expect(delayedRelease).resolves.toBe(false)
      expect(removeIdentity).not.toHaveBeenCalled()
      expect(state).toEqual(replacementIdentity)
    } finally {
      retryDelayedRelease.resolve()
      await releaseCoordinator().catch(() => {})
      await Promise.allSettled([delayedRelease].filter(Boolean))
    }
  })
})
