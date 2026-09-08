'use client'

import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { WhatsAppConversation } from '@/lib/api'

/**
 * What to call the person on the other end.
 *
 * Ordered by how much the name is worth: the subscriber name the ERP knows
 * beats the profile name they set on their own phone, which beats the raw
 * address. The chain never ends nameless — a contact WhatsApp handed us only a
 * LID for still has to be clickable, and the id is the last resort so that a
 * row can never render as an empty button.
 */
export function conversationTitle(conversation: WhatsAppConversation): string {
  return (
    conversation.clientName
    || conversation.pushName
    || conversation.waPhoneE164
    || conversation.waLid
    || `#${conversation.id}`
  )
}

/**
 * The address, only when it is not already the title. Showing
 * "+5511999999999 · +5511999999999" on an unnamed thread is noise.
 */
export function conversationAddress(conversation: WhatsAppConversation): string | null {
  const address = conversation.waPhoneE164 || conversation.waLid
  if (!address) return null
  return address === conversationTitle(conversation) ? null : address
}

/**
 * A chat list stamp, not a log stamp: today collapses to the clock and anything
 * older to the day. Built from `Intl` alone so it needs no vocabulary of its
 * own — every word here would be a word to translate five times.
 */
function stamp(iso: string | null, intlLocale: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return new Intl.DateTimeFormat(
    intlLocale,
    sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { day: '2-digit', month: '2-digit' }
  ).format(date)
}

interface ConversationListProps {
  conversations: WhatsAppConversation[]
  selectedId: number | null
  onSelect: (conversation: WhatsAppConversation) => void
  /** A search term or a non-default pile is narrowing what is drawn here. */
  filtered: boolean
}

/**
 * The left pane. Pure presentation: it neither fetches nor reconciles the
 * unread counts it draws, because the badge shown here and the badge the server
 * clears when a thread is opened have to be settled in one place, and that
 * place is the page.
 */
export function ConversationList({ conversations, selectedId, onSelect, filtered }: ConversationListProps) {
  const { t, intlLocale } = useTranslation()

  if (conversations.length === 0) {
    // "Nothing matches that" sends the operator back to the search box;
    // "no conversation yet" tells them the panel is simply new. Reading the
    // first as the second is how a working search looks broken.
    return (
      <div className="empty-state">
        <div className="empty-state-icon"><Icon name={filtered ? 'search' : 'chat'} size={22} /></div>
        <p className="empty-state-title">{t(filtered ? 'whatsapp.inbox.noMatch' : 'whatsapp.inbox.empty')}</p>
      </div>
    )
  }

  return (
    <ul className="divide-y divide-border" role="list">
      {conversations.map((conversation) => {
        const active = conversation.id === selectedId
        const address = conversationAddress(conversation)
        return (
          <li key={conversation.id}>
            <button
              type="button"
              onClick={() => onSelect(conversation)}
              aria-current={active ? 'true' : undefined}
              className={`flex w-full flex-col gap-1.5 px-3 py-3 text-left transition-colors ${
                active
                  ? 'bg-[hsl(var(--surface-subtle))] shadow-[inset_3px_0_0_0_hsl(var(--primary))]'
                  : 'hover:bg-[hsl(var(--surface-subtle))]'
              }`}
            >
              <span className="flex items-baseline gap-2">
                <span
                  className={`min-w-0 flex-1 truncate text-sm text-foreground ${
                    conversation.unreadCount > 0 ? 'font-bold' : 'font-semibold'
                  }`}
                >
                  {conversationTitle(conversation)}
                </span>
                <span className="shrink-0 font-mono text-[0.68rem] tabular-nums text-muted-foreground">
                  {stamp(conversation.lastMessageAt, intlLocale)}
                </span>
              </span>

              {address && (
                <span className="block truncate font-mono text-[0.68rem] text-muted-foreground">{address}</span>
              )}

              <span className="flex flex-wrap items-center gap-1.5">
                {/* Only ever visible under the closed or the all pile, which is
                    exactly where a row's state stops being obvious. */}
                {conversation.closedAt && (
                  <span className="modern-badge" title={t('whatsapp.inbox.closeHint')}>
                    <Icon name="check" size={12} />
                    {t('whatsapp.inbox.closed')}
                  </span>
                )}
                {conversation.unreadCount > 0 && (
                  <span className="modern-badge-success">
                    {t('whatsapp.inbox.unread', { count: conversation.unreadCount })}
                  </span>
                )}
                {conversation.optedOut && (
                  <span className="modern-badge-warning" title={t('whatsapp.inbox.optedOutHint')}>
                    <Icon name="bell" size={12} />
                    {t('whatsapp.inbox.optedOut')}
                  </span>
                )}
                {conversation.contract ? (
                  <span className="modern-badge">
                    <Icon name="invoice" size={12} />
                    <span className="font-mono">{conversation.contract}</span>
                  </span>
                ) : (
                  <span className="modern-badge" title={t('whatsapp.inbox.unknownContact')}>
                    <Icon name="info" size={12} />
                    {t('whatsapp.inbox.unknownContact')}
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
