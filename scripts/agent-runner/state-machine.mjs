import { createHash } from 'node:crypto'
import { handlerPlanVersion } from './constants.mjs'
import {
  boundedChunkEnd,
  compareSequences,
  maximumSequence
} from './value-validation.mjs'

const leaseExpiry = (now, leaseDurationMs) => new Date(now + leaseDurationMs).toISOString()

export const chunkIdFor = ({ principalId, groupId, fromExclusive, through }) => (
  createHash('sha256')
    .update(`agora-runner-v1\0${principalId}\0${groupId}\0${fromExclusive}\0${through}`)
    .digest('hex')
)

export const reconcileGroups = (state, { groups, principalId }) => {
  if (state.principalId !== null && state.principalId !== principalId) {
    throw new Error('Agora runner principal does not match durable state.')
  }

  state.principalId = principalId
  const activeGroupIds = new Set(groups.map(({ id }) => id))
  const removedChunkIds = []

  for (const [groupId, group] of Object.entries(state.groups)) {
    if (!activeGroupIds.has(groupId)) {
      if (group.lease?.phase === 'planned') removedChunkIds.push(group.lease.chunkId)
      delete state.groups[groupId]
    }
  }

  for (const group of groups) {
    const high = BigInt(group.highWatermarkSequence)
    const unread = BigInt(group.unreadCount)

    if (unread > high) {
      throw new Error('Agora group unread state is inconsistent.')
    }

    const existing = state.groups[group.id]
    const serverReadThrough = (high - unread).toString()

    if (!existing) {
      state.groups[group.id] = {
        cursor: serverReadThrough,
        observedHighWatermark: group.highWatermarkSequence
      }
      continue
    }

    if (compareSequences(existing.cursor, group.highWatermarkSequence) > 0) {
      throw new Error('Agora runner cursor exceeds the current group sequence.')
    }

    existing.observedHighWatermark = maximumSequence(
      existing.observedHighWatermark,
      group.highWatermarkSequence
    )
  }

  return removedChunkIds
}

export const observeHighWatermark = (state, groupId, highWatermarkSequence) => {
  const group = state.groups[groupId]
  if (!group) return false
  const next = maximumSequence(group.observedHighWatermark, highWatermarkSequence)
  const changed = next !== group.observedHighWatermark
  group.observedHighWatermark = next
  return changed
}

export const prepareLease = (state, groupId, {
  chunkSize,
  leaseDurationMs,
  maximumAttempts,
  now,
  ownerPid,
  ownerRunId
}) => {
  const group = state.groups[groupId]
  if (!group) return undefined
  const current = group.lease

  if (current?.phase === 'planned') {
    current.ownerPid = ownerPid
    current.ownerRunId = ownerRunId
    current.expiresAt = leaseExpiry(now, leaseDurationMs)
    return current
  }

  if (current?.phase === 'retryable') {
    if (Date.parse(current.retryAt) > now || current.attempt >= maximumAttempts) {
      return undefined
    }

    group.lease = {
      attempt: current.attempt + 1,
      chunkId: current.chunkId,
      expiresAt: leaseExpiry(now, leaseDurationMs),
      fromExclusive: current.fromExclusive,
      ownerPid,
      ownerRunId,
      phase: 'leased',
      through: current.through
    }
    return group.lease
  }

  if (current || compareSequences(group.cursor, group.observedHighWatermark) >= 0) {
    return undefined
  }

  const through = boundedChunkEnd(group.cursor, group.observedHighWatermark, chunkSize)
  group.lease = {
    attempt: 1,
    chunkId: chunkIdFor({
      fromExclusive: group.cursor,
      groupId,
      principalId: state.principalId,
      through
    }),
    expiresAt: leaseExpiry(now, leaseDurationMs),
    fromExclusive: group.cursor,
    ownerPid,
    ownerRunId,
    phase: 'leased',
    through
  }
  return group.lease
}

const requireOwnedLease = (state, groupId, chunkId, ownerRunId) => {
  const lease = state.groups[groupId]?.lease

  if (!lease || lease.chunkId !== chunkId || lease.ownerRunId !== ownerRunId) {
    throw new Error('Agora runner lease ownership changed.')
  }

  return lease
}

export const markLeaseHandling = (
  state,
  groupId,
  chunkId,
  ownerRunId,
  child,
  expiresAt
) => {
  const lease = requireOwnedLease(state, groupId, chunkId, ownerRunId)

  if (lease.phase !== 'leased') {
    throw new Error('Agora runner lease phase is invalid.')
  }

  lease.child = child
  lease.expiresAt = expiresAt
  lease.phase = 'handling'
}

export const markLeaseBootstrapping = (
  state,
  groupId,
  chunkId,
  ownerRunId,
  child,
  expiresAt
) => {
  const lease = requireOwnedLease(state, groupId, chunkId, ownerRunId)

  if (lease.phase !== 'leased' || state.groups[groupId].threadId !== undefined) {
    throw new Error('Agora runner lease phase is invalid.')
  }

  lease.child = child
  lease.expiresAt = expiresAt
  lease.phase = 'bootstrapping'
}

export const bindGroupThread = (state, groupId, chunkId, ownerRunId, threadId) => {
  const group = state.groups[groupId]
  const lease = requireOwnedLease(state, groupId, chunkId, ownerRunId)

  if (lease.phase !== 'bootstrapping') {
    throw new Error('Agora runner lease phase is invalid.')
  }
  if (group.threadId !== undefined && group.threadId !== threadId) {
    throw new Error('Agora runner group already has another Codex thread.')
  }

  group.threadId = threadId
  delete lease.child
  lease.phase = 'leased'
}

export const renewLease = (state, groupId, chunkId, ownerRunId, expiresAt) => {
  const lease = requireOwnedLease(state, groupId, chunkId, ownerRunId)

  if (!['bootstrapping', 'handling', 'leased', 'planned'].includes(lease.phase)) {
    throw new Error('Agora runner lease phase is invalid.')
  }

  lease.expiresAt = expiresAt
}

export const releaseUnplannedLease = (state, groupId, chunkId, ownerRunId) => {
  const group = state.groups[groupId]
  const lease = requireOwnedLease(state, groupId, chunkId, ownerRunId)

  if (lease.phase !== 'leased') {
    throw new Error('Only an unplanned Agora lease can be released.')
  }

  delete group.lease
}

export const attachPlan = (state, groupId, chunkId, ownerRunId, plan) => {
  const lease = requireOwnedLease(state, groupId, chunkId, ownerRunId)

  if (lease.phase !== 'handling') {
    throw new Error('Agora runner lease phase is invalid.')
  }

  delete lease.child
  lease.phase = 'planned'
  lease.plan = plan
}

export const failLease = (state, groupId, chunkId, ownerRunId, {
  code,
  terminal = false,
  maximumAttempts,
  retryAt
}) => {
  const group = state.groups[groupId]
  const lease = requireOwnedLease(state, groupId, chunkId, ownerRunId)

  if (lease.phase === 'planned') {
    throw new Error('A durable Agora handler plan cannot be discarded as failed.')
  }

  delete lease.child
  delete lease.plan
  lease.failureCode = code
  group.lastFailureCode = code

  if (terminal || lease.attempt >= maximumAttempts) {
    lease.phase = 'failed'
    delete lease.retryAt
  } else {
    lease.phase = 'retryable'
    lease.retryAt = retryAt
  }
}

export const recoverLease = (state, groupId, {
  leaseDurationMs,
  maximumAttempts,
  now,
  ownerPid,
  ownerRunId,
  retryAt
}) => {
  const group = state.groups[groupId]
  const lease = group?.lease

  if (!lease || lease.ownerRunId === ownerRunId || lease.phase === 'failed') {
    return lease
  }

  delete lease.child
  lease.ownerPid = ownerPid
  lease.ownerRunId = ownerRunId
  lease.expiresAt = leaseExpiry(now, leaseDurationMs)

  if (lease.phase === 'planned') {
    return lease
  }

  if (lease.phase === 'handling') {
    lease.failureCode = 'turn_indeterminate'
    group.lastFailureCode = 'turn_indeterminate'
    lease.phase = 'failed'
    delete lease.retryAt
    return lease
  }

  lease.failureCode = 'canceled'
  group.lastFailureCode = 'canceled'
  if (lease.attempt >= maximumAttempts) {
    lease.phase = 'failed'
    delete lease.retryAt
  } else {
    lease.phase = 'retryable'
    lease.retryAt = retryAt
  }
  return lease
}

export const commitLease = (state, groupId, chunkId, ownerRunId) => {
  const group = state.groups[groupId]
  const lease = requireOwnedLease(state, groupId, chunkId, ownerRunId)

  if (lease.phase !== 'planned') {
    throw new Error('Agora runner lease has no durable handler plan.')
  }

  group.cursor = lease.through
  group.lastHandledThrough = lease.through
  delete group.lastFailureCode
  delete group.lease
}

export const commitSelfOnlyLease = (state, groupId, chunkId, ownerRunId) => {
  const group = state.groups[groupId]
  const lease = requireOwnedLease(state, groupId, chunkId, ownerRunId)

  if (lease.phase !== 'leased') {
    throw new Error('Agora runner lease phase is invalid.')
  }

  group.cursor = lease.through
  group.lastHandledThrough = lease.through
  delete group.lastFailureCode
  delete group.lease
}

export const createDurablePlan = (lease, groupId, messages) => ({
  chunkId: lease.chunkId,
  fromExclusive: lease.fromExclusive,
  groupId,
  messages,
  through: lease.through,
  version: handlerPlanVersion
})

export const resetFailedLeases = (state) => {
  let reset = 0
  for (const group of Object.values(state.groups)) {
    if (group.lease?.phase === 'failed') {
      delete group.lease
      delete group.lastFailureCode
      reset += 1
    }
  }
  return reset
}
