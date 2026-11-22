'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { messengerAPI, type MessengerConversation, type MessengerMessage } from '@/lib/api'
import {
  MESSENGER_MAX_TEXT,
  messengerErrorKey,
  messengerTitle,
  remainingParts,
  singleLine,
  windowRemainingMs,
} from '@/lib/messenger'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/** Com que frequência a caixa e a conversa aberta se atualizam. */
const LIST_POLL_MS = 15_000
const THREAD_POLL_MS = 8_000

/**
 * A caixa do Messenger: lista de conversas e a conversa aberta.
 *
 * Em tela estreita só uma das duas aparece por vez (a lista, ou a conversa com
 * um botão de voltar), como a caixa do WhatsApp. A janela de 24 h é mostrada
 * aqui mas quem a impõe é o servidor: o campo de resposta fecha para evitar o
 * erro, e uma resposta que ainda assim passe é recusada lá.
 */
export function MessengerInbox({ canSend, hasPages }: { canSend: boolean; hasPages: boolean }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [status, setStatus] = useState<'open' | 'closed'>('open')
  const [conversations, setConversations] = useState<MessengerConversation[] | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const loadList = useCallback(async () => {
    const res = await messengerAPI.listConversations(status)
    if (res.success && res.data) setConversations(res.data)
    else if (conversations === null) toast.error(t('messenger.loadFailed'))
    // `conversations` fica fora das dependências de propósito: o aviso é só da
    // primeira carga, e a atualização periódica não pode refazer o efeito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, t, toast])

  useEffect(() => {
    void loadList()
    const timer = window.setInterval(() => void loadList(), LIST_POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadList])

  const selected = useMemo(
    () => conversations?.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId]
  )

  return (
    <div className="modern-card grid min-h-[32rem] overflow-hidden md:grid-cols-[20rem_1fr]">
      <div className={`flex min-w-0 flex-col border-border md:border-e ${selectedId !== null ? 'max-md:hidden' : ''}`}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold text-foreground">{t('messenger.inbox')}</h2>
          <div className="flex gap-1" role="group" aria-label={t('messenger.inbox')}>
            {(['open', 'closed'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={status === value}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold max-sm:min-h-9 ${
                  status === value ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => {
                  setStatus(value)
                  setSelectedId(null)
                  setConversations(null)
                }}
              >
                {t(value === 'open' ? 'messenger.filter.open' : 'messenger.filter.closed')}
              </button>
            ))}
          </div>
        </div>
        {conversations && conversations.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name="chat" size={22} /></div>
            <p className="empty-state-title">{t(hasPages ? 'messenger.empty' : 'messenger.emptyNoPage')}</p>
          </div>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto" role="list">
            {(conversations ?? []).map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  aria-current={conversation.id === selectedId}
                  className={`flex w-full flex-col gap-1 px-3 py-3 text-start transition-colors hover:bg-muted ${
                    conversation.id === selectedId ? 'bg-muted' : ''
                  }`}
                  onClick={() => setSelectedId(conversation.id)}
                >
                  <span className="flex items-baseline gap-2">
                    <span className={`min-w-0 flex-1 truncate text-sm text-foreground ${conversation.unreadCount ? 'font-semibold' : ''}`}>
                      {messengerTitle(conversation)}
                    </span>
                    {conversation.unreadCount > 0 && (
                      <span className="modern-badge" aria-label={t('messenger.unread', { count: conversation.unreadCount })}>
                        {conversation.unreadCount}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={`flex min-w-0 flex-col ${selectedId === null ? 'max-md:hidden' : ''}`}>
        {selected ? (
          <Thread
            key={selected.id}
            conversation={selected}
            canSend={canSend}
            onBack={() => setSelectedId(null)}
            onChanged={() => void loadList()}
          />
        ) : (
          <div className="empty-state m-auto">
            <p className="empty-state-title">{t('messenger.select')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function Thread({
  conversation,
  canSend,
  onBack,
  onChanged,
}: {
  conversation: MessengerConversation
  canSend: boolean
  onBack: () => void
  onChanged: () => void
}) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [current, setCurrent] = useState(conversation)
  const [messages, setMessages] = useState<MessengerMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const res = await messengerAPI.listMessages(conversation.id)
    if (res.success && res.data) {
      setCurrent(res.data.conversation)
      setMessages(res.data.messages)
    } else {
      toast.error(t('messenger.messagesLoadFailed'))
    }
  }, [conversation.id, t, toast])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void load()
    }, THREAD_POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const remaining = windowRemainingMs(current.lastInboundAt, now)
  const windowOpen = remaining > 0
  const parts = remainingParts(remaining)

  const handleSend = async (event: FormEvent) => {
    event.preventDefault()
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const res = await messengerAPI.send(conversation.id, body)
      if (res.success && res.data) {
        setText('')
        await load()
        onChanged()
      } else {
        toast.error(t(messengerErrorKey(res.code)))
        // A recusa por janela fechada muda o estado da conversa; recarrega.
        if (res.code === 'window_closed') await load()
      }
    } finally {
      setSending(false)
    }
  }

  const handleClosed = async () => {
    const res = await messengerAPI.setClosed(conversation.id, current.closedAt === null)
    if (res.success) {
      onChanged()
      onBack()
    } else {
      toast.error(t(messengerErrorKey(res.code)))
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button type="button" className="md:hidden max-sm:min-h-10 text-sm font-semibold text-primary" onClick={onBack}>
          {t('messenger.back')}
        </button>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{messengerTitle(current)}</h3>
        {canSend && (
          <button type="button" className="modern-button-secondary max-sm:min-h-10" onClick={() => void handleClosed()}>
            {t(current.closedAt === null ? 'messenger.archive' : 'messenger.reopen')}
          </button>
        )}
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3" role="list">
        {messages.map((message) => (
          <li key={message.id} className={`flex ${message.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                message.direction === 'out' ? 'bg-primary/10 text-foreground' : 'bg-muted text-foreground'
              }`}
            >
              {message.body ? (
                <p className="whitespace-pre-wrap break-words">{message.body}</p>
              ) : !message.attachmentType ? (
                <p className="text-muted-foreground">{t('messenger.noText')}</p>
              ) : null}
              {message.attachmentType && (
                <p className="text-xs text-muted-foreground">
                  {t('messenger.attachment', { type: message.attachmentType })}
                  {message.attachmentUrl && /^https:\/\//i.test(message.attachmentUrl) && (
                    <>
                      {' · '}
                      <a
                        className="text-primary hover:underline"
                        href={message.attachmentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('messenger.openAttachment')}
                      </a>
                    </>
                  )}
                </p>
              )}
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[0.68rem] text-muted-foreground">
                <span>{formatDateTime(message.createdAt)}</span>
                {message.direction === 'out' && message.source === 'page' && <span>{t('messenger.sentOutside')}</span>}
                {message.direction === 'out' && message.deliveryStatus && (
                  <span className={message.deliveryStatus === 'failed' ? 'text-[hsl(var(--status-danger))]' : ''}>
                    {t(`messenger.status.${message.deliveryStatus}`)}
                    {message.deliveryStatus === 'failed' && message.deliveryError ? ` — ${message.deliveryError}` : ''}
                  </span>
                )}
              </p>
            </div>
          </li>
        ))}
        <div ref={endRef} />
      </ul>

      {canSend && (
        <form onSubmit={(event) => void handleSend(event)} className="space-y-2 border-t border-border p-3">
          <p className="field-hint" role="status">
            {windowOpen
              ? t('messenger.windowOpen', { hours: parts.hours, minutes: parts.minutes })
              : t('messenger.windowClosed')}
          </p>
          <div className="flex items-end gap-2">
            <textarea
              className="modern-input min-h-12 flex-1"
              rows={2}
              maxLength={MESSENGER_MAX_TEXT}
              disabled={!windowOpen || sending}
              placeholder={t('messenger.placeholder')}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
            />
            <button type="submit" className="modern-button max-sm:min-h-12" disabled={!windowOpen || sending || !text.trim()}>
              {sending ? t('messenger.sending') : t('messenger.send')}
            </button>
          </div>
        </form>
      )}
    </>
  )
}
