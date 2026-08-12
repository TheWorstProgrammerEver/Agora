import { useState, type FormEvent } from 'react'
import { CheckCheck, Send } from 'lucide-react'
import { maximumMessageTextLength } from '../../../common/agoraMessageLimits'
import { Button } from '../../../lib/ui/Button/Button'
import { ComponentRoleContext } from '../../../lib/ui/ComponentRoleContext/ComponentRoleContext'
import { IconAndLabel } from '../../../lib/ui/ResponsiveContent/IconContent'
import type { useGroupConversation } from './useGroupConversation'
import styles from './ConversationPanel.module.scss'

type ConversationPanelProps = {
  conversation: ReturnType<typeof useGroupConversation>
  groupName: string
}

const formatMessageTime = (createdAt: string) => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
}).format(new Date(createdAt))

export const ConversationPanel = ({ conversation, groupName }: ConversationPanelProps) => {
  const [messageText, setMessageText] = useState('')
  const retrying = conversation.failedMessageText === messageText.trim()

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault()

    if (await conversation.send(messageText)) {
      setMessageText('')
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="conversation-title">
      <header className={styles.header}>
        <div>
          <h3 id="conversation-title">Conversation</h3>
          <p className={styles.connection} role="status">
            {conversation.realtimeState === 'connected'
              ? conversation.syncBusy ? 'Catching up…' : 'Live updates connected'
              : conversation.realtimeState === 'interrupted' ? 'Live updates interrupted · retrying' : 'Connecting live updates…'}
          </p>
        </div>
        {conversation.unreadCount > 0 && (
          <ComponentRoleContext role="secondary">
            <Button
              type="button"
              disabled={conversation.actionState.busy || conversation.syncBusy}
              onClick={() => void conversation.acknowledgeRead()}
            >
              <IconAndLabel icon={<CheckCheck />}>Mark as read</IconAndLabel>
            </Button>
          </ComponentRoleContext>
        )}
      </header>

      {(conversation.loadState.error || conversation.historyState.error || conversation.syncError) && (
        <p className={styles.error} role="alert">
          {conversation.historyState.error ?? conversation.loadState.error ?? conversation.syncError}
        </p>
      )}

      <div className={styles.history} aria-busy={conversation.loadState.busy || conversation.historyState.busy}>
        {conversation.hasEarlierMessages && (
          <ComponentRoleContext role="tertiary">
            <Button
              type="button"
              disabled={conversation.historyState.busy}
              onClick={() => void conversation.loadEarlier()}
            >
              Load earlier messages
            </Button>
          </ComponentRoleContext>
        )}

        {conversation.messages.length === 0 && !conversation.loadState.busy ? (
          <p className={styles.empty}>No messages yet. Start the conversation.</p>
        ) : (
          <ol className={styles.messages} aria-label={`${groupName} message history`} aria-live="polite">
            {conversation.messages.map((message) => {
              const unread = conversation.isUnread(message)

              return (
                <li className={unread ? styles.unreadMessage : undefined} key={message.id}>
                  <header className={styles.messageHeader}>
                    <strong>{message.sender.displayName}</strong>
                    <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
                    {unread && <span className={styles.unreadLabel}>Unread</span>}
                  </header>
                  <p>{message.text}</p>
                </li>
              )
            })}
          </ol>
        )}
      </div>

      <form className={styles.composer} onSubmit={(event) => void submitMessage(event)}>
        <label htmlFor="group-message">Message</label>
        <textarea
          id="group-message"
          required
          maxLength={maximumMessageTextLength}
          rows={3}
          value={messageText}
          onChange={(event) => setMessageText(event.target.value)}
        />
        {conversation.actionState.error && (
          <p className={styles.error} role="alert">
            {conversation.actionState.error} Your draft is safe; retrying unchanged text uses the same delivery ID.
          </p>
        )}
        <ComponentRoleContext role="primary">
          <Button
            type="submit"
            aria-busy={conversation.actionState.busy}
            disabled={conversation.actionState.busy || messageText.trim().length === 0}
          >
            <IconAndLabel icon={<Send />}>{retrying ? 'Retry send' : 'Send message'}</IconAndLabel>
          </Button>
        </ComponentRoleContext>
      </form>
    </section>
  )
}
