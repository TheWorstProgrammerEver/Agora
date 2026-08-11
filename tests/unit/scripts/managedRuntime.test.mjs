import { describe, expect, it, vi } from 'vitest'
import {
  claimRuntimeIdentity,
  inspectRuntimeProcess,
  stopManagedRuntime,
  validateRuntimeIdentity
} from '../../../scripts/managed-runtime.mjs'

const identity = {
  bootId: '01234567-89ab-cdef-0123-456789abcdef',
  marker: 'agora:0123456789abcdef',
  pid: 4242,
  platform: 'linux',
  startTimeTicks: '123456',
  version: 2
}

const processSnapshot = {
  ...identity,
  processGroupId: 4242,
  sessionId: 4242,
  state: 'S',
  title: identity.marker
}

describe('managed runtime identity', () => {
  it('rejects malformed persisted identity', () => {
    expect(() => validateRuntimeIdentity({ pid: 4242, version: 2 })).toThrow(
      'managed-runtime state is malformed'
    )
  })

  it('requires the complete stable process identity', async () => {
    await expect(inspectRuntimeProcess(
      identity,
      async () => processSnapshot
    )).resolves.toBe('owned')

    await expect(inspectRuntimeProcess(
      identity,
      async () => ({ ...processSnapshot, startTimeTicks: '654321' })
    )).resolves.toBe('unowned')
  })

  it('recovers an unowned record before claiming a replacement runtime', async () => {
    const replacement = {
      ...identity,
      marker: 'agora:fedcba9876543210',
      pid: 4343,
      startTimeTicks: '654321'
    }
    const clearIdentity = vi.fn()
    const writeIdentity = vi.fn()

    await expect(claimRuntimeIdentity({
      clearIdentity,
      createIdentity: async () => replacement,
      inspectProcess: async () => 'unowned',
      readIdentity: () => identity,
      writeIdentity
    })).resolves.toEqual(replacement)

    expect(clearIdentity).toHaveBeenCalledWith(identity)
    expect(writeIdentity).toHaveBeenCalledWith(replacement)
  })
})

describe('managed runtime shutdown', () => {
  it('clears an unowned record without signaling its process', async () => {
    const clearIdentity = vi.fn()
    const sendSignal = vi.fn()

    await expect(stopManagedRuntime(identity, {
      clearIdentity,
      inspectProcess: async () => 'unowned',
      sendSignal
    })).resolves.toBe('stale-record-cleared')

    expect(clearIdentity).toHaveBeenCalledWith(identity)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('revalidates ownership immediately before signaling', async () => {
    const inspectProcess = vi.fn()
      .mockResolvedValueOnce('owned')
      .mockResolvedValueOnce('unowned')
    const sendSignal = vi.fn()

    await expect(stopManagedRuntime(identity, {
      inspectProcess,
      sendSignal
    })).rejects.toThrow('identity changed before shutdown')

    expect(inspectProcess).toHaveBeenCalledTimes(2)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('revalidates ownership before forced shutdown', async () => {
    const clearIdentity = vi.fn()
    const inspectProcess = vi.fn()
      .mockResolvedValueOnce('owned')
      .mockResolvedValueOnce('owned')
      .mockResolvedValueOnce('owned')
      .mockResolvedValueOnce('unowned')
    const sendSignal = vi.fn()

    await expect(stopManagedRuntime(identity, {
      clearIdentity,
      inspectProcess,
      maxChecks: 1,
      sendSignal,
      sleep: async () => {}
    })).resolves.toBe('stopped')

    expect(sendSignal).toHaveBeenCalledOnce()
    expect(sendSignal).toHaveBeenCalledWith(identity.pid, 'SIGTERM')
    expect(clearIdentity).toHaveBeenCalledWith(identity)
  })

  it('fails when the owned process resists graceful and forced termination', async () => {
    const sendSignal = vi.fn()

    await expect(stopManagedRuntime(identity, {
      inspectProcess: async () => 'owned',
      killChecks: 1,
      maxChecks: 1,
      sendSignal,
      sleep: async () => {}
    })).rejects.toThrow('did not terminate within the shutdown deadline')

    expect(sendSignal.mock.calls).toEqual([
      [identity.pid, 'SIGTERM'],
      [identity.pid, 'SIGKILL']
    ])
  })

  it('reports success only after the owned identity disappears', async () => {
    const clearIdentity = vi.fn()
    const inspectProcess = vi.fn()
      .mockResolvedValueOnce('owned')
      .mockResolvedValueOnce('owned')
      .mockResolvedValueOnce('stopped')
    const sendSignal = vi.fn()

    await expect(stopManagedRuntime(identity, {
      clearIdentity,
      inspectProcess,
      sendSignal,
      sleep: async () => {}
    })).resolves.toBe('stopped')

    expect(sendSignal).toHaveBeenCalledWith(identity.pid, 'SIGTERM')
    expect(clearIdentity).toHaveBeenCalledWith(identity)
  })

  it('refuses to signal a live legacy record without stable identity', async () => {
    const sendSignal = vi.fn()

    await expect(stopManagedRuntime({
      marker: identity.marker,
      pid: identity.pid,
      version: 1
    }, {
      inspectProcess: async () => 'legacy-owned',
      sendSignal
    })).rejects.toThrow('lacks stable identity')

    expect(sendSignal).not.toHaveBeenCalled()
  })
})
