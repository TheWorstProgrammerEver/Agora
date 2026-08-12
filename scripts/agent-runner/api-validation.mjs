import { agentKeySearchPattern, maximumHandlerActions } from './constants.mjs'
import {
  compareSequences,
  hasExactKeys,
  isIsoTimestamp,
  isObject,
  isPositiveSequence,
  isSequence,
  isUuid
} from './value-validation.mjs'

const isBoundedString = (value, maximumLength, allowEmpty = false) => (
  typeof value === 'string'
  && value.length <= maximumLength
  && (allowEmpty || value.length > 0)
)

const isPrincipal = (value) => (
  isObject(value)
  && hasExactKeys(value, ['displayName', 'id', 'kind'])
  && isBoundedString(value.displayName, 200)
  && isUuid(value.id)
  && ['agent', 'human'].includes(value.kind)
)

const isGroup = (value) => (
  isObject(value)
  && hasExactKeys(value, ['createdAt', 'id', 'name', 'ownerPrincipalId'])
  && isIsoTimestamp(value.createdAt)
  && isUuid(value.id)
  && isBoundedString(value.name, 120)
  && isUuid(value.ownerPrincipalId)
)

const isGroupSummary = (value) => (
  isObject(value)
  && hasExactKeys(value, ['createdAt', 'id', 'name', 'ownerPrincipalId', 'unreadCount'])
  && isGroup({
    createdAt: value.createdAt,
    id: value.id,
    name: value.name,
    ownerPrincipalId: value.ownerPrincipalId
  })
  && Number.isSafeInteger(value.unreadCount)
  && value.unreadCount >= 0
)

const isGroupMember = (value) => (
  isObject(value)
  && hasExactKeys(value, ['groupId', 'joinedAt', 'principal', 'role'])
  && isUuid(value.groupId)
  && isIsoTimestamp(value.joinedAt)
  && isPrincipal(value.principal)
  && ['member', 'owner'].includes(value.role)
)

export const isMessage = (value) => (
  isObject(value)
  && hasExactKeys(value, ['createdAt', 'groupId', 'id', 'sender', 'sequence', 'text'])
  && isIsoTimestamp(value.createdAt)
  && isUuid(value.groupId)
  && isUuid(value.id)
  && isPrincipal(value.sender)
  && isPositiveSequence(value.sequence)
  && isBoundedString(value.text, 4000)
)

const isPage = (value, itemValidator) => {
  if (!isObject(value)
    || !hasExactKeys(value, ['items'], ['nextCursor'])
    || !Array.isArray(value.items)
    || !value.items.every(itemValidator)
    || (value.nextCursor !== undefined && !isBoundedString(value.nextCursor, 4096))) {
    return false
  }

  return true
}

const isMessagePage = (value) => (
  isPage(value, isMessage)
  && value.items.every((message, index) => (
    index === 0 || compareSequences(value.items[index - 1].sequence, message.sequence) < 0
  ))
)

const isRealtimeTopic = (value) => (
  isObject(value)
  && hasExactKeys(value, ['groupId', 'highWatermarkSequence', 'topic'])
  && isUuid(value.groupId)
  && isSequence(value.highWatermarkSequence)
  && value.topic === `agora:group:${value.groupId}`
)

const isRealtimeSession = (value) => (
  isObject(value)
  && hasExactKeys(value, ['accessToken', 'expiresAt', 'refreshAfter', 'topics'])
  && isBoundedString(value.accessToken, 16 * 1024)
  && isIsoTimestamp(value.expiresAt)
  && isIsoTimestamp(value.refreshAfter)
  && Date.parse(value.refreshAfter) < Date.parse(value.expiresAt)
  && Array.isArray(value.topics)
  && value.topics.length > 0
  && value.topics.length <= 32
  && value.topics.every(isRealtimeTopic)
  && new Set(value.topics.map(({ groupId }) => groupId)).size === value.topics.length
)

const validators = {
  createRealtimeSession: isRealtimeSession,
  getGroup: (value) => (
    isObject(value)
    && hasExactKeys(value, ['currentMember', 'group'])
    && isGroupMember(value.currentMember)
    && isGroup(value.group)
    && value.currentMember.groupId === value.group.id
  ),
  getGroupMessages: isMessagePage,
  listGroups: (value) => isPage(value, isGroupSummary),
  markGroupRead: (value) => (
    isObject(value)
    && hasExactKeys(value, ['groupId', 'sequence'])
    && isUuid(value.groupId)
    && isPositiveSequence(value.sequence)
  ),
  sendMessage: isMessage
}

export const validateAgoraResult = (identifier, value) => {
  const validator = validators[identifier]

  if (!validator || !validator(value)) {
    throw new Error('Agora runner API response is invalid.')
  }

  return value
}

export const validateHandlerPlan = (value) => {
  if (!isObject(value)
    || !hasExactKeys(value, ['messages', 'version'])
    || value.version !== 1
    || !Array.isArray(value.messages)
    || value.messages.length > maximumHandlerActions
    || !value.messages.every((message) => (
      isObject(message)
      && hasExactKeys(message, ['text'])
      && isBoundedString(message.text, 4000)
      && message.text.trim().length > 0
      && !agentKeySearchPattern.test(message.text)
    ))) {
    throw new Error('Agora handler output is invalid.')
  }

  return value
}
