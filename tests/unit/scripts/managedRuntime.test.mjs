import { describe, expect, it, vi } from 'vitest'
import {
  stopManagedRuntime,
  validateRuntimeIdentity
} from '../../../scripts/managed-runtime.mjs'

const identity = {
  marker: 'agora:0123456789abcdef',
  pid: 4242,
  version: 1
}

describe('managed runtime shutdown', () => {
  it('rejects malformed persisted identity', () => {
    expect(() => validateRuntimeIdentity({ pid: 4242, version: 1 })).toThrow(
      'managed-runtime state is malformed'
    )
  })

  it('never signals an unrelated process', async () => {
    const sendSignal = vi.fn()

    await expect(stopManagedRuntime(identity, {
      inspectProcess: async () => 'unowned',
      sendSignal
    })).rejects.toThrow('does not own its recorded process')

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

  it('fails when the owned process resists termination', async () => {
    const sendSignal = vi.fn()

    await expect(stopManagedRuntime(identity, {
      inspectProcess: async () => 'owned',
      maxChecks: 2,
      sendSignal,
      sleep: async () => {}
    })).rejects.toThrow('did not terminate within the shutdown deadline')

    expect(sendSignal).toHaveBeenCalledOnce()
    expect(sendSignal).toHaveBeenCalledWith(identity.pid, 'SIGTERM')
  })

  it('reports success only after the owned identity disappears', async () => {
    const inspectProcess = vi.fn()
      .mockResolvedValueOnce('owned')
      .mockResolvedValueOnce('owned')
      .mockResolvedValueOnce('stopped')
    const sendSignal = vi.fn()

    await expect(stopManagedRuntime(identity, {
      inspectProcess,
      sendSignal,
      sleep: async () => {}
    })).resolves.toBe('stopped')

    expect(sendSignal).toHaveBeenCalledWith(identity.pid, 'SIGTERM')
  })
})
