import { platform } from 'node:os'
import {
  processGroupMembersMatch,
  readLinuxBootId,
  readProcessGroupMembers,
  readProcessIdentity,
  stableProcessIdentityMatches
} from '../process-identity.mjs'
import { abortableDelay } from './abort.mjs'

const executingIdentity = (identity) => (
  identity && !['X', 'Z'].includes(identity.state?.[0])
)

export const durableProcessIdentity = (identity) => {
  if (!executingIdentity(identity)
    || identity.processGroupId !== identity.pid
    || !['darwin', 'linux'].includes(identity.platform)) {
    throw new Error('Agora handler process identity is invalid.')
  }

  return identity.platform === 'linux'
    ? {
        bootId: identity.bootId,
        pid: identity.pid,
        platform: identity.platform,
        processGroupId: identity.processGroupId,
        startTimeTicks: identity.startTimeTicks
      }
    : {
        pid: identity.pid,
        platform: identity.platform,
        processGroupId: identity.processGroupId,
        startTime: identity.startTime
      }
}

const currentMatches = (expected, current) => (
  executingIdentity(current)
  && current.processGroupId === expected.processGroupId
  && stableProcessIdentityMatches(expected, current)
)

const waitForGroupExit = async (processGroupId, timeoutMs, signal) => {
  const deadline = performance.now() + timeoutMs

  while (performance.now() < deadline) {
    if (readProcessGroupMembers(processGroupId).length === 0) return true
    await abortableDelay(25, signal)
  }

  return readProcessGroupMembers(processGroupId).length === 0
}

const signalGroup = (processGroupId, signal) => {
  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

export const terminateCurrentHandlerGroup = async (processGroupId, options = {}) => {
  const ownedMembers = readProcessGroupMembers(processGroupId)
  if (ownedMembers.length === 0) return

  signalGroup(processGroupId, 'SIGTERM')
  if (await waitForGroupExit(processGroupId, options.graceMs ?? 5000)) return

  const currentMembers = readProcessGroupMembers(processGroupId)
  if (!processGroupMembersMatch(ownedMembers, currentMembers)) {
    throw new Error('Agora handler process-group identity changed before escalation.')
  }

  signalGroup(processGroupId, 'SIGKILL')
  if (!await waitForGroupExit(processGroupId, options.killWaitMs ?? 5000)) {
    throw new Error('Agora handler process group did not terminate.')
  }
}

export const settleRecoveredHandler = async (identity, options = {}) => {
  if (!identity) return
  const currentPlatform = (options.platform ?? platform)()
  if (identity.platform !== currentPlatform) return
  if (identity.platform === 'linux'
    && identity.bootId !== (options.readBootId ?? readLinuxBootId)()) {
    return
  }

  const readIdentity = options.readIdentity ?? readProcessIdentity
  const readGroupMembers = options.readGroupMembers ?? readProcessGroupMembers
  const terminateGroup = options.terminateGroup ?? terminateCurrentHandlerGroup
  const current = readIdentity(identity.pid)

  if (!current) {
    if (readGroupMembers(identity.processGroupId).length > 0) {
      throw new Error('Agora recovered handler ownership is indeterminate.')
    }
    return
  }

  if (!executingIdentity(current)) {
    if (readGroupMembers(identity.processGroupId).length > 0) {
      throw new Error('Agora recovered handler ownership is indeterminate.')
    }
    return
  }

  if (!currentMatches(identity, current)) {
    throw new Error('Agora recovered handler identity changed.')
  }

  await terminateGroup(identity.processGroupId, options)
}
