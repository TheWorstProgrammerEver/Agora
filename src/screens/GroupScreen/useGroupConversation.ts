import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultMessagePageSize } from '../../../common/agoraMessageLimits'
import type { MessageDto, MessageSequence } from '../../../common/agoraDtos'
import { useLoader } from '../../../lib/hooks/useLoader'
import {
  getGroupMessages,
  getUnreadMessages,
  markGroupRead,
  sendMessage
} from '../../data/agora/agoraClient'
import { isFunctionAccessDenied } from '../../data/supabaseFunctionInvokerRequestHandler'
import {
  isMessageUnread,
  laterSequence,
  latestMessageSequence,
  mergeMessages,
  sequenceBefore
} from '../../state/conversationStateUpdates'
import { createId } from '../../utils/id'
import { useConversationSynchronization } from './useConversationSynchronization'

type FailedSend = {
  clientMessageId: string
  text: string
}

export const useGroupConversation = (groupId: string) => {
  const [messages, setMessages] = useState<MessageDto[]>([])
  const [historyCursor, setHistoryCursor] = useState<MessageSequence>()
  const [readThroughSequence, setReadThroughSequence] = useState<MessageSequence>('0')
  const [failedSend, setFailedSend] = useState<FailedSend>()
  const [accessRevoked, setAccessRevoked] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const latestSequenceRef = useRef<MessageSequence>('0')
  const generationRef = useRef(0)
  const loadState = useLoader()
  const historyState = useLoader()
  const actionState = useLoader()

  const applyMessages = useCallback((incoming: MessageDto[]) => {
    const incomingLatest = latestMessageSequence(incoming)

    if (incomingLatest) {
      latestSequenceRef.current = laterSequence(latestSequenceRef.current, incomingLatest)
    }

    setMessages((current) => mergeMessages(current, incoming))
  }, [])

  const revokeAccess = useCallback(() => {
    setAccessRevoked(true)
    setMessages([])
    setHistoryCursor(undefined)
    setInitialized(false)
  }, [])

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    latestSequenceRef.current = '0'
    setMessages([])
    setHistoryCursor(undefined)
    setReadThroughSequence('0')
    setFailedSend(undefined)
    setAccessRevoked(false)
    setInitialized(false)

    const initialize = async () => {
      try {
        const { page, unread } = await loadState.execute(async () => {
          const loadedPage = await getGroupMessages({
            groupId,
            limit: defaultMessagePageSize
          })
          const loadedUnread = await getUnreadMessages({ groupId, limit: 1 })

          return { page: loadedPage, unread: loadedUnread }
        })

        if (generationRef.current !== generation) {
          return
        }

        applyMessages(page.items)
        setHistoryCursor(page.nextCursor)
        const firstUnread = unread.items[0]?.sequence
        setReadThroughSequence(firstUnread
          ? sequenceBefore(firstUnread)
          : latestSequenceRef.current)
        setInitialized(true)
      } catch (error) {
        if (generationRef.current === generation && isFunctionAccessDenied(error)) {
          revokeAccess()
        }
      }
    }

    void initialize()

    return () => {
      if (generationRef.current === generation) {
        generationRef.current += 1
      }
    }
  }, [applyMessages, groupId, loadState.execute, revokeAccess])

  const synchronization = useConversationSynchronization({
    accessRevoked,
    applyMessages,
    groupId,
    initialized,
    latestSequenceRef,
    revokeAccess
  })

  const loadEarlier = useCallback(async () => {
    if (!historyCursor || accessRevoked) {
      return
    }

    try {
      const page = await historyState.execute(() => getGroupMessages({
        beforeSequence: historyCursor,
        groupId,
        limit: defaultMessagePageSize
      }))
      applyMessages(page.items)
      setHistoryCursor(page.nextCursor)
    } catch (error) {
      if (isFunctionAccessDenied(error)) {
        revokeAccess()
      }
    }
  }, [accessRevoked, applyMessages, groupId, historyCursor, historyState.execute, revokeAccess])

  const send = useCallback(async (text: string) => {
    const normalizedText = text.trim()
    const pending = failedSend?.text === normalizedText
      ? failedSend
      : { clientMessageId: createId('message'), text: normalizedText }

    try {
      const message = await actionState.execute(() => sendMessage({
        clientMessageId: pending.clientMessageId,
        groupId,
        text: pending.text
      }))
      applyMessages([message])
      setReadThroughSequence((current) => laterSequence(current, message.sequence))
      setFailedSend(undefined)
      return true
    } catch (error) {
      if (isFunctionAccessDenied(error)) {
        revokeAccess()
      } else {
        setFailedSend(pending)
      }

      return false
    }
  }, [actionState.execute, applyMessages, failedSend, groupId, revokeAccess])

  const acknowledgeRead = useCallback(async () => {
    if (latestSequenceRef.current === '0') {
      return
    }

    try {
      const watermark = await actionState.execute(() => markGroupRead({
        groupId,
        throughSequence: latestSequenceRef.current
      }))
      setReadThroughSequence((current) => laterSequence(current, watermark.sequence))
    } catch (error) {
      if (isFunctionAccessDenied(error)) {
        revokeAccess()
      }
    }
  }, [actionState.execute, groupId, revokeAccess])

  const unreadCount = useMemo(() => (
    messages.filter((message) => isMessageUnread(message, readThroughSequence)).length
  ), [messages, readThroughSequence])

  return {
    accessRevoked,
    acknowledgeRead,
    actionState,
    failedMessageText: failedSend?.text,
    hasEarlierMessages: Boolean(historyCursor),
    historyState,
    isUnread: (message: MessageDto) => isMessageUnread(message, readThroughSequence),
    loadEarlier,
    loadState,
    messages,
    realtimeState: synchronization.realtimeState,
    send,
    syncBusy: synchronization.syncBusy,
    syncError: synchronization.syncError,
    unreadCount
  }
}
