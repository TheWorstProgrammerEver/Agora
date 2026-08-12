import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createEmptyRunnerState, validateRunnerState } from '../../../scripts/agent-runner/state-schema.mjs'
import {
  attachPlan,
  bindGroupThread,
  commitLease,
  failLease,
  markLeaseBootstrapping,
  markLeaseHandling,
  observeHighWatermark,
  prepareLease,
  reconcileGroups,
  recoverLease
} from '../../../scripts/agent-runner/state-machine.mjs'

const principalId = randomUUID()
const groupId = randomUUID()
const ownerRunId = randomUUID()
const processIdentity = {
  bootId: randomUUID(),
  pid: 1001,
  platform: 'linux',
  processGroupId: 1001,
  startTimeTicks: '42'
}

const seededState = (high = '25', unreadCount = 25) => {
  const state = createEmptyRunnerState()
  reconcileGroups(state, {
    groups: [{ highWatermarkSequence: high, id: groupId, unreadCount }],
    principalId
  })
  return state
}

const leaseOptions = (overrides = {}) => ({
  chunkSize: 10,
  leaseDurationMs: 60_000,
  maximumAttempts: 3,
  now: 1000,
  ownerPid: 1001,
  ownerRunId,
  ...overrides
})

const planAndCommit = (state, lease) => {
  markLeaseHandling(
    state,
    groupId,
    lease.chunkId,
    ownerRunId,
    processIdentity,
    new Date(61_000).toISOString()
  )
  attachPlan(state, groupId, lease.chunkId, ownerRunId, {
    actionCount: 0,
    digest: `sha256:${'a'.repeat(64)}`
  })
  commitLease(state, groupId, lease.chunkId, ownerRunId)
}

describe('agent runner state machine', () => {
  it('coalesces duplicate and out-of-order watermarks to the maximum', () => {
    const state = seededState('10', 10)

    expect(observeHighWatermark(state, groupId, '9')).toBe(false)
    expect(observeHighWatermark(state, groupId, '10')).toBe(false)
    expect(observeHighWatermark(state, groupId, '14')).toBe(true)
    expect(observeHighWatermark(state, groupId, '12')).toBe(false)
    expect(state.groups[groupId].observedHighWatermark).toBe('14')
  })

  it('creates ordered non-overlapping chunks and one lease per range', () => {
    const state = seededState()
    const first = prepareLease(state, groupId, leaseOptions())

    expect(first).toMatchObject({ fromExclusive: '0', through: '10' })
    expect(prepareLease(state, groupId, leaseOptions())).toBeUndefined()
    planAndCommit(state, first)
    const second = prepareLease(state, groupId, leaseOptions({ now: 2000 }))

    expect(second).toMatchObject({ fromExclusive: '10', through: '20' })
    planAndCommit(state, second)
    const third = prepareLease(state, groupId, leaseOptions({ now: 3000 }))
    expect(third).toMatchObject({ fromExclusive: '20', through: '25' })
    validateRunnerState(state)
  })

  it('bootstraps from the authoritative server read watermark', () => {
    const state = seededState('18', 5)

    expect(state.groups[groupId]).toEqual({
      cursor: '13',
      observedHighWatermark: '18'
    })
  })

  it('binds one thread to one group and preserves it across leases', () => {
    const state = seededState('2', 2)
    const lease = prepareLease(state, groupId, leaseOptions())
    const threadId = randomUUID()
    markLeaseBootstrapping(
      state,
      groupId,
      lease.chunkId,
      ownerRunId,
      processIdentity,
      new Date(61_000).toISOString()
    )
    bindGroupThread(state, groupId, lease.chunkId, ownerRunId, threadId)
    expect(state.groups[groupId].threadId).toBe(threadId)
    expect(state.groups[groupId].lease.phase).toBe('leased')
    expect(() => markLeaseBootstrapping(
      state,
      groupId,
      lease.chunkId,
      ownerRunId,
      processIdentity,
      new Date(62_000).toISOString()
    )).toThrow('phase is invalid')
    validateRunnerState(state)
  })

  it('keeps thread bindings distinct across groups', () => {
    const otherGroupId = randomUUID()
    const state = createEmptyRunnerState()
    reconcileGroups(state, {
      groups: [groupId, otherGroupId].map((id) => ({
        highWatermarkSequence: '1',
        id,
        unreadCount: 1
      })),
      principalId
    })

    for (const [id, threadId] of [
      [groupId, randomUUID()],
      [otherGroupId, randomUUID()]
    ]) {
      const lease = prepareLease(state, id, leaseOptions())
      markLeaseBootstrapping(
        state,
        id,
        lease.chunkId,
        ownerRunId,
        processIdentity,
        new Date(61_000).toISOString()
      )
      bindGroupThread(state, id, lease.chunkId, ownerRunId, threadId)
    }

    expect(state.groups[groupId].threadId).not.toBe(state.groups[otherGroupId].threadId)
    validateRunnerState(state)
  })

  it('deletes a removed group thread and never carries it into a re-added group', () => {
    const state = seededState('0', 0)
    const threadId = randomUUID()
    state.groups[groupId].threadId = threadId

    reconcileGroups(state, { groups: [], principalId })
    expect(state.groups[groupId]).toBeUndefined()
    reconcileGroups(state, {
      groups: [{ highWatermarkSequence: '0', id: groupId, unreadCount: 0 }],
      principalId
    })
    expect(state.groups[groupId].threadId).toBeUndefined()
  })

  it('rejects state reuse by another principal', () => {
    const state = seededState('0', 0)

    expect(() => reconcileGroups(state, {
      groups: [{ highWatermarkSequence: '0', id: groupId, unreadCount: 0 }],
      principalId: randomUUID()
    })).toThrow('principal does not match')
  })

  it('fails closed when a host turn is interrupted after effects become possible', () => {
    const state = seededState('4', 4)
    const lease = prepareLease(state, groupId, leaseOptions())
    markLeaseHandling(
      state,
      groupId,
      lease.chunkId,
      ownerRunId,
      processIdentity,
      new Date(61_000).toISOString()
    )
    const replacementRunId = randomUUID()

    recoverLease(state, groupId, {
      leaseDurationMs: 60_000,
      maximumAttempts: 3,
      now: 90_000,
      ownerPid: 2002,
      ownerRunId: replacementRunId,
      retryAt: new Date(90_000).toISOString()
    })
    expect(state.groups[groupId].lease).toMatchObject({
      attempt: 1,
      fromExclusive: '0',
      ownerRunId: replacementRunId,
      failureCode: 'turn_indeterminate',
      phase: 'failed',
      through: '4'
    })
    expect(prepareLease(state, groupId, leaseOptions({
      now: 90_000,
      ownerPid: 2002,
      ownerRunId: replacementRunId
    }))).toBeUndefined()
  })

  it('exhausts a bounded handler retry budget without advancing the cursor', () => {
    const state = seededState('2', 2)
    let lease = prepareLease(state, groupId, leaseOptions({ maximumAttempts: 2 }))

    failLease(state, groupId, lease.chunkId, ownerRunId, {
      code: 'handler_failed',
      maximumAttempts: 2,
      retryAt: new Date(1000).toISOString()
    })
    lease = prepareLease(state, groupId, leaseOptions({ maximumAttempts: 2, now: 1000 }))
    failLease(state, groupId, lease.chunkId, ownerRunId, {
      code: 'handler_failed',
      maximumAttempts: 2,
      retryAt: new Date(2000).toISOString()
    })

    expect(state.groups[groupId].cursor).toBe('0')
    expect(state.groups[groupId].lease).toMatchObject({ attempt: 2, phase: 'failed' })
    expect(prepareLease(state, groupId, leaseOptions({ maximumAttempts: 2 }))).toBeUndefined()
  })

  it('rejects shape-valid but semantically impossible lease state', () => {
    const state = seededState('5', 5)
    const lease = prepareLease(state, groupId, leaseOptions())
    lease.fromExclusive = '1'

    expect(() => validateRunnerState(state)).toThrow('state is invalid')
  })
})
