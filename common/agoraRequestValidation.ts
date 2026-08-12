import type { AgoraRequestParams } from './agoraRequestContract.ts'
import {
  agoraRequestIdentifiers,
  type AgoraRequestIdentifier
} from './agoraRequestIdentifiers.ts'
import {
  maximumGroupListPageSize,
  maximumGroupNameLength,
  maximumInvitationListPageSize,
  maximumMemberListPageSize
} from './agoraGroupLimits.ts'
import {
  maximumClientMessageIdLength,
  maximumMessageTextLength
} from './agoraMessageLimits.ts'

type ParamsValidator = (value: unknown) => boolean

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const hasExactKeys = (
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = []
) => {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])

  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key))
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isNonEmptyString = (value: unknown): value is string => (
  isString(value) && value.trim().length > 0
)
const isBoundedNonEmptyString = (value: unknown, maximumLength: number): value is string => (
  isNonEmptyString(value) && [...value].length <= maximumLength
)
const isPositiveInteger = (value: unknown): value is number => (
  Number.isInteger(value) && Number(value) > 0
)
const isUuid = (value: unknown): value is string => (
  isString(value)
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
)

const isCursorPage = (value: unknown, maximumPageSize: number) => (
  isObject(value)
  && hasExactKeys(value, [], ['cursor', 'limit'])
  && (value.cursor === undefined || isNonEmptyString(value.cursor))
  && (value.limit === undefined || (
    isPositiveInteger(value.limit) && value.limit <= maximumPageSize
  ))
)

const isGroupListPage = (value: unknown) => (
  isObject(value)
  && hasExactKeys(value, [], ['cursor', 'limit'])
  && (value.cursor === undefined || isNonEmptyString(value.cursor))
  && (value.limit === undefined || (
    isPositiveInteger(value.limit) && value.limit <= maximumGroupListPageSize
  ))
)

const isGroupIdParams = (value: unknown) => (
  isObject(value)
  && hasExactKeys(value, ['groupId'])
  && isUuid(value.groupId)
)

const isInvitationIdParams = (value: unknown) => (
  isObject(value)
  && hasExactKeys(value, ['invitationId'])
  && isUuid(value.invitationId)
)

const validators = {
  [agoraRequestIdentifiers.acceptInvitation]: isInvitationIdParams,
  [agoraRequestIdentifiers.addAgentMember]: (value) => (
    isObject(value)
    && hasExactKeys(value, ['agentPrincipalId', 'groupId'])
    && isUuid(value.agentPrincipalId)
    && isUuid(value.groupId)
  ),
  [agoraRequestIdentifiers.createGroup]: (value) => (
    isObject(value)
    && hasExactKeys(value, ['name'])
    && isNonEmptyString(value.name)
    && value.name.trim().length <= maximumGroupNameLength
  ),
  [agoraRequestIdentifiers.createRealtimeSession]: (value) => (
    isObject(value)
    && hasExactKeys(value, ['groupIds'])
    && Array.isArray(value.groupIds)
    && value.groupIds.every(isUuid)
  ),
  [agoraRequestIdentifiers.deleteGroup]: isGroupIdParams,
  [agoraRequestIdentifiers.getGroup]: isGroupIdParams,
  [agoraRequestIdentifiers.getGroupMessages]: (value) => {
    if (!isObject(value)
      || !hasExactKeys(
        value,
        ['groupId'],
        ['afterSequence', 'aroundSequence', 'beforeSequence', 'limit']
      )
      || !isUuid(value.groupId)
      || (value.limit !== undefined && !isPositiveInteger(value.limit))) {
      return false
    }

    const windows = [
      value.afterSequence,
      value.aroundSequence,
      value.beforeSequence
    ].filter((window) => window !== undefined)

    return windows.length <= 1 && windows.every(isNonEmptyString)
  },
  [agoraRequestIdentifiers.getUnreadMessages]: (value) => (
    isObject(value)
    && hasExactKeys(value, ['groupId'], ['afterSequence', 'limit'])
    && isUuid(value.groupId)
    && (value.afterSequence === undefined || isNonEmptyString(value.afterSequence))
    && (value.limit === undefined || isPositiveInteger(value.limit))
  ),
  [agoraRequestIdentifiers.inviteHuman]: (value) => (
    isObject(value)
    && hasExactKeys(value, ['email', 'groupId'])
    && isNonEmptyString(value.email)
    && isUuid(value.groupId)
  ),
  [agoraRequestIdentifiers.listGroupMembers]: (value) => (
    isObject(value)
    && hasExactKeys(value, ['groupId'], ['cursor', 'limit'])
    && isUuid(value.groupId)
    && (value.cursor === undefined || isNonEmptyString(value.cursor))
    && (value.limit === undefined || (
      isPositiveInteger(value.limit) && value.limit <= maximumMemberListPageSize
    ))
  ),
  [agoraRequestIdentifiers.listGroups]: isGroupListPage,
  [agoraRequestIdentifiers.listPendingInvitations]: (value) => (
    isCursorPage(value, maximumInvitationListPageSize)
  ),
  [agoraRequestIdentifiers.markGroupRead]: (value) => (
    isObject(value)
    && hasExactKeys(value, ['groupId', 'throughSequence'])
    && isUuid(value.groupId)
    && isNonEmptyString(value.throughSequence)
  ),
  [agoraRequestIdentifiers.rejectInvitation]: isInvitationIdParams,
  [agoraRequestIdentifiers.removeMember]: (value) => (
    isObject(value)
    && hasExactKeys(value, ['groupId', 'principalId'])
    && isUuid(value.groupId)
    && isUuid(value.principalId)
  ),
  [agoraRequestIdentifiers.sendMessage]: (value) => (
    isObject(value)
    && hasExactKeys(value, ['clientMessageId', 'groupId', 'text'])
    && isBoundedNonEmptyString(value.clientMessageId, maximumClientMessageIdLength)
    && isUuid(value.groupId)
    && isBoundedNonEmptyString(value.text, maximumMessageTextLength)
  )
} satisfies Record<AgoraRequestIdentifier, ParamsValidator>

export const isAgoraRequestParams = <TIdentifier extends AgoraRequestIdentifier>(
  identifier: TIdentifier,
  value: unknown
): value is AgoraRequestParams<TIdentifier> => validators[identifier](value)
