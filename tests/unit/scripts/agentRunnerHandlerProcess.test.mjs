import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { settleRecoveredHandler } from '../../../scripts/agent-runner/handler-process.mjs'

const identity = (overrides = {}) => ({
  bootId: randomUUID(),
  pid: 4242,
  platform: 'linux',
  processGroupId: 4242,
  startTimeTicks: '12345',
  ...overrides
})

describe('recovered agent handler identity', () => {
  it('treats a prior-boot PID occupant as unrelated without inspecting or signaling it', async () => {
    const previous = identity()
    const readIdentity = vi.fn(() => identity({
      bootId: randomUUID(),
      startTimeTicks: '67890'
    }))
    const readGroupMembers = vi.fn(() => [readIdentity()])
    const terminateGroup = vi.fn()

    await expect(settleRecoveredHandler(previous, {
      platform: () => 'linux',
      readBootId: () => randomUUID(),
      readGroupMembers,
      readIdentity,
      terminateGroup
    })).resolves.toBeUndefined()

    expect(readIdentity).not.toHaveBeenCalled()
    expect(readGroupMembers).not.toHaveBeenCalled()
    expect(terminateGroup).not.toHaveBeenCalled()
  })

  it('terminates only an exact same-boot handler identity', async () => {
    const previous = identity()
    const current = { ...previous, state: 'S' }
    const terminateGroup = vi.fn()

    await settleRecoveredHandler(previous, {
      platform: () => 'linux',
      readBootId: () => previous.bootId,
      readIdentity: () => current,
      terminateGroup
    })

    expect(terminateGroup).toHaveBeenCalledWith(previous.processGroupId, expect.any(Object))
  })

  it('fails closed on same-boot PID reuse', async () => {
    const previous = identity()

    await expect(settleRecoveredHandler(previous, {
      platform: () => 'linux',
      readBootId: () => previous.bootId,
      readIdentity: () => identity({
        bootId: previous.bootId,
        startTimeTicks: '67890',
        state: 'S'
      }),
      terminateGroup: vi.fn()
    })).rejects.toThrow('Agora recovered handler identity changed.')
  })
})
