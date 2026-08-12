import {
  agentKeySearchPattern,
  handlerFailureCodes,
  handlerPlanVersion,
  runnerStateVersion
} from './constants.mjs'
import {
  compareSequences,
  hasExactKeys,
  isIsoTimestamp,
  isObject,
  isSequence,
  isUuid
} from './value-validation.mjs'

const leasePhases = new Set(['failed', 'handling', 'leased', 'planned', 'retryable'])
const digestPattern = /^sha256:[0-9a-f]{64}$/
const chunkIdPattern = /^[0-9a-f]{64}$/

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0

const isProcessIdentity = (value) => {
  if (!isObject(value)
    || !hasExactKeys(
      value,
      ['pid', 'platform', 'processGroupId'],
      ['bootId', 'startTime', 'startTimeTicks']
    )
    || !isPositiveInteger(value.pid)
    || !isPositiveInteger(value.processGroupId)) {
    return false
  }

  if (value.platform === 'linux') {
    return typeof value.bootId === 'string'
      && isUuid(value.bootId)
      && typeof value.startTimeTicks === 'string'
      && /^\d+$/.test(value.startTimeTicks)
      && value.startTime === undefined
  }

  return value.platform === 'darwin'
    && typeof value.startTime === 'string'
    && value.startTime.length > 0
    && value.startTime.length <= 80
    && value.bootId === undefined
    && value.startTimeTicks === undefined
}

const isLease = (value, group) => {
  if (!isObject(value)
    || !hasExactKeys(value, [
      'attempt',
      'chunkId',
      'expiresAt',
      'fromExclusive',
      'ownerPid',
      'ownerRunId',
      'phase',
      'through'
    ], ['child', 'failureCode', 'plan', 'retryAt'])
    || !isPositiveInteger(value.attempt)
    || typeof value.chunkId !== 'string'
    || !chunkIdPattern.test(value.chunkId)
    || !isIsoTimestamp(value.expiresAt)
    || !isSequence(value.fromExclusive)
    || !isPositiveInteger(value.ownerPid)
    || !isUuid(value.ownerRunId)
    || !leasePhases.has(value.phase)
    || !isSequence(value.through)
    || value.fromExclusive !== group.cursor
    || compareSequences(value.through, value.fromExclusive) <= 0
    || compareSequences(value.through, group.observedHighWatermark) > 0
    || (value.child !== undefined && !isProcessIdentity(value.child))) {
    return false
  }

  const hasFailure = typeof value.failureCode === 'string'
    && handlerFailureCodes.has(value.failureCode)
  const hasRetryAt = isIsoTimestamp(value.retryAt)
  const hasPlan = isObject(value.plan)
    && hasExactKeys(value.plan, ['actionCount', 'digest'])
    && Number.isSafeInteger(value.plan.actionCount)
    && value.plan.actionCount >= 0
    && value.plan.actionCount <= 4
    && typeof value.plan.digest === 'string'
    && digestPattern.test(value.plan.digest)

  if (value.phase === 'planned') {
    return hasPlan && !hasFailure && !hasRetryAt && value.child === undefined
  }

  if (value.phase === 'retryable') {
    return hasFailure && hasRetryAt && value.plan === undefined && value.child === undefined
  }

  if (value.phase === 'failed') {
    return hasFailure && value.retryAt === undefined && value.plan === undefined
      && value.child === undefined
  }

  if (value.phase === 'handling') {
    return value.failureCode === undefined && value.retryAt === undefined
      && value.plan === undefined
  }

  return value.child === undefined
    && value.failureCode === undefined
    && value.retryAt === undefined
    && value.plan === undefined
}

const isGroupState = (value) => {
  if (!isObject(value)
    || !hasExactKeys(
      value,
      ['cursor', 'observedHighWatermark'],
      ['lastFailureCode', 'lastHandledThrough', 'lease']
    )
    || !isSequence(value.cursor)
    || !isSequence(value.observedHighWatermark)
    || compareSequences(value.cursor, value.observedHighWatermark) > 0
    || (value.lastHandledThrough !== undefined && (
      !isSequence(value.lastHandledThrough)
      || compareSequences(value.lastHandledThrough, value.cursor) > 0
    ))
    || (value.lastFailureCode !== undefined && (
      typeof value.lastFailureCode !== 'string'
      || !handlerFailureCodes.has(value.lastFailureCode)
    ))) {
    return false
  }

  return value.lease === undefined || isLease(value.lease, value)
}

const isActivity = (value) => (
  isObject(value)
  && hasExactKeys(value, ['at', 'code', 'status'])
  && isIsoTimestamp(value.at)
  && typeof value.code === 'string'
  && /^[a-z0-9_-]{1,64}$/.test(value.code)
  && ['degraded', 'healthy', 'starting', 'stopped'].includes(value.status)
)

export const createEmptyRunnerState = () => ({
  groups: {},
  principalId: null,
  version: runnerStateVersion
})

export const validateRunnerState = (value) => {
  if (!isObject(value)
    || !hasExactKeys(value, ['groups', 'principalId', 'version'], ['lastActivity'])
    || value.version !== runnerStateVersion
    || (value.principalId !== null && !isUuid(value.principalId))
    || !isObject(value.groups)
    || (value.lastActivity !== undefined && !isActivity(value.lastActivity))) {
    throw new Error('Agora runner state is invalid.')
  }

  for (const [groupId, group] of Object.entries(value.groups)) {
    if (!isUuid(groupId) || !isGroupState(group)) {
      throw new Error('Agora runner state is invalid.')
    }
  }

  if (value.principalId === null && Object.keys(value.groups).length > 0) {
    throw new Error('Agora runner state is invalid.')
  }

  return value
}

export const validateDurablePlan = (value) => {
  if (!isObject(value)
    || !hasExactKeys(value, [
      'chunkId',
      'fromExclusive',
      'groupId',
      'messages',
      'through',
      'version'
    ])
    || value.version !== handlerPlanVersion
    || typeof value.chunkId !== 'string'
    || !chunkIdPattern.test(value.chunkId)
    || !isSequence(value.fromExclusive)
    || !isUuid(value.groupId)
    || !isSequence(value.through)
    || compareSequences(value.through, value.fromExclusive) <= 0
    || !Array.isArray(value.messages)
    || value.messages.length > 4
    || !value.messages.every((message) => (
      isObject(message)
      && hasExactKeys(message, ['text'])
      && typeof message.text === 'string'
      && message.text.trim().length > 0
      && message.text.length <= 4000
      && !agentKeySearchPattern.test(message.text)
    ))) {
    throw new Error('Agora runner durable plan is invalid.')
  }

  return value
}
