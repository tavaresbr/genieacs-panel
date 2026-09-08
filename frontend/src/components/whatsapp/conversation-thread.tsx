'use client'

import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { WhatsAppConversation, WhatsAppMessage } from '@/lib/api'
import { conversationAddress, conversationTitle } from '@/components/whatsapp/conversation-list'
import { MessageBubble } from '@/components/whatsapp/message-bubble'

/** How close to the foot counts as "the operator is at the bottom". */
const STICK_PX = 120

interface ConversationThreadProps {
  conversation: WhatsAppConversation
  /** Newest first, exactly as the API hands them over. */
  messages: WhatsAppMessage[]
  loading: boolean
  canLoadMore: boolean
  onLoadMore: () => void
  onResend: (message: WhatsAppMessage) => void
  resendingId: number | null
}

/**
 * The right pane: who this is, then everything that was said.
 *
 * The header is where the two facts that change an operator's next move live —
 * whether the number resolved to a subscriber, and whether that subscriber
 * asked not to be contacted. Neither is a wall: an unresolved number is still
 * answerable and an opted-out one still gets replies, so both read as context,
 * not as a refusal.
 */
export function ConversationThread({
  conversation,
  messages,
  loading,
  canLoadMore,
  onLoadMore,
  onResend,
  resendingId
}: ConversationThreadProps) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const address = conversationAddress(conversation)
  // The API hands the history back newest first; a conversation reads the other
  // way round.
  const ordered = [...messages].reverse()
  const lastId = ordered.length > 0 ? ordered[ordered.length - 1].id : null

  // A new thread always opens at its foot: the newest message is the one the
  // operator came here for.
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    stick.current = true
    box.scrollTop = box.scrollHeight
  }, [conversation.id])

  // A message arriving while the operator is reading further up must not yank
  // the viewport out from under them — the poll below runs on its own clock,
  // and scrolling someone away mid-sentence is how a screen loses trust.
  // Loading older messages never trips this: it does not change the last id.
  useEffect(() => {
    const box = scrollRef.current
    if (!box || lastId === null || !stick.current) return
    box.scrollTop = box.scrollHeight
  }, [lastId])

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-card px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-foreground">{conversationTitle(conversation)}</h2>
          {address && <p className="truncate font-mono text-xs text-muted-foreground">{address}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {conversation.contract ? (
              <span className="modern-badge-info">
                <Icon name="invoice" size={12} />
                {t('whatsapp.inbox.contract')}: <span className="font-mono">{conversation.contract}</span>
              </span>
            ) : (
              <span className="modern-badge">
                <Icon name="info" size={12} />
                {t('whatsapp.inbox.unknownContact')}
              </span>
            )}
            {conversation.clientName && (
              <span className="modern-badge">
                {t('whatsapp.inbox.subscriber')}: {conversation.clientName}
              </span>
            )}
            {conversation.optedOut && (
              <span className="modern-badge-warning" title={t('whatsapp.inbox.optedOutHint')}>
                <Icon name="bell" size={12} />
                {t('whatsapp.inbox.optedOut')}
              </span>
            )}
          </div>
        </div>

        {conversation.deviceId && (
          <Link
            to={`/devices/detail?id=${encodeURIComponent(conversation.deviceId)}`}
            className="modern-button-secondary shrink-0"
          >
            <Icon name="server" size={16} />
            {t('whatsapp.inbox.openDevice')}
          </Link>
        )}
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-[hsl(var(--surface-subtle))] px-4 py-4"
        onScroll={(event) => {
          const box = event.currentTarget
          stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX
        }}
      >
        {canLoadMore && (
          <div className="mb-3 flex justify-center">
            <button type="button" className="modern-button-secondary min-h-9 px-3 py-1 text-xs" disabled={loading} onClick={onLoadMore}>
              <Icon name="refresh" size={13} className={loading ? 'animate-spin' : ''} />
              {t('whatsapp.inbox.loadMore')}
            </button>
          </div>
        )}

        {ordered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name="chat" size={22} /></div>
            <p className="empty-state-copy">{loading ? t('common.loading') : t('whatsapp.inbox.noMessages')}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2" role="list">
            {ordered.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onResend={onResend}
                resending={resendingId === message.id}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
