import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { maximumMessagePageSize } from '../../../common/agoraMessageLimits'
import type { MessageDto, MessageSequence } from '../../../common/agoraDtos'
import { getGroupMessages } from '../../data/agora/agoraClient'
import { subscribeToGroupAvailability } from '../../data/agora/groupAvailability'
import { isFunctionAccessDenied } from '../../data/supabaseFunctionInvokerRequestHandler'
import { latestMessageSequence } from '../../state/conversationStateUpdates'
import { useActiveGroupRequest } from './useActiveGroupRequest'

const maximumCatchUpPages = 1_000

type ConversationSynchronizationParams = {
  accessRevoked: boolean
  applyMessages: (messages: MessageDto[]) => void
  groupId: string
  initialized: boolean
  latestSequenceRef: MutableRefObject<MessageSequence>
  revokeAccess: () => void
}

export const useConversationSynchronization = ({
  accessRevoked,
  applyMessages,
  groupId,
  initialized,
  latestSequenceRef,
  revokeAccess
}: ConversationSynchronizationParams) => {
  const [realtimeState, setRealtimeState] = useState<'connected' | 'connecting' | 'interrupted'>('connecting')
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncError, setSyncError] = useState<string>()
  const generationRef = useRef(0)
  const reconcileRequestedRef = useRef(false)
  const reconcilePromiseRef = useRef<{ groupId: string, promise: Promise<void> } | undefined>(undefined)
  const isActiveGroupRequest = useActiveGroupRequest(groupId)

  useEffect(() => {
    generationRef.current += 1
    reconcileRequestedRef.current = false
    setRealtimeState('connecting')
    setSyncBusy(false)
    setSyncError(undefined)
  }, [groupId])

  const requestReconciliation = useCallback(() => {
    if (!initialized || accessRevoked || !isActiveGroupRequest(groupId)) {
      return
    }

    reconcileRequestedRef.current = true

    if (reconcilePromiseRef.current?.groupId === groupId) {
      return
    }

    const generation = generationRef.current
    const reconcile = async () => {
      setSyncBusy(true)

      try {
        while (reconcileRequestedRef.current && generationRef.current === generation) {
          reconcileRequestedRef.current = false
          let cursor = latestSequenceRef.current
          let hasMore = true
          let pageCount = 0

          while (hasMore && generationRef.current === generation) {
            pageCount += 1

            if (pageCount > maximumCatchUpPages) {
              throw new Error('Conversation catch-up exceeded its safety bound.')
            }

            const page = await getGroupMessages({
              afterSequence: cursor,
              groupId,
              limit: maximumMessagePageSize
            })
            if (generationRef.current !== generation || !isActiveGroupRequest(groupId)) {
              return
            }

            applyMessages(page.items)
            cursor = latestMessageSequence(page.items) ?? cursor
            hasMore = Boolean(page.nextCursor)
          }
        }

        if (isActiveGroupRequest(groupId)) {
          setSyncError(undefined)
        }
      } catch (error) {
        if (generationRef.current !== generation || !isActiveGroupRequest(groupId)) {
          return
        }

        if (isFunctionAccessDenied(error)) {
          revokeAccess()
        } else {
          setSyncError(error instanceof Error ? error.message : 'Conversation catch-up failed.')
        }
      } finally {
        if (generationRef.current === generation && isActiveGroupRequest(groupId)) {
          setSyncBusy(false)
        }
      }
    }

    const promise = reconcile()
    const reconciliation = { groupId, promise }
    reconcilePromiseRef.current = reconciliation
    void promise.finally(() => {
      if (reconcilePromiseRef.current === reconciliation) {
        reconcilePromiseRef.current = undefined
      }
    })
  }, [
    accessRevoked,
    applyMessages,
    groupId,
    initialized,
    isActiveGroupRequest,
    latestSequenceRef,
    revokeAccess
  ])

  useEffect(() => {
    if (!initialized || accessRevoked) {
      return
    }

    const disconnect = subscribeToGroupAvailability(groupId, {
      onConnected: () => {
        if (!isActiveGroupRequest(groupId)) {
          return
        }

        setRealtimeState('connected')
        requestReconciliation()
      },
      onDisconnected: () => {
        if (!isActiveGroupRequest(groupId)) {
          return
        }

        setRealtimeState('interrupted')
        requestReconciliation()
      },
      onHint: () => {
        if (isActiveGroupRequest(groupId)) {
          requestReconciliation()
        }
      }
    })
    const reconcileOnline = () => {
      if (!isActiveGroupRequest(groupId)) {
        return
      }

      setRealtimeState('connecting')
      requestReconciliation()
    }
    window.addEventListener('online', reconcileOnline)

    return () => {
      window.removeEventListener('online', reconcileOnline)
      disconnect()
    }
  }, [accessRevoked, groupId, initialized, isActiveGroupRequest, requestReconciliation])

  return { realtimeState, syncBusy, syncError }
}
