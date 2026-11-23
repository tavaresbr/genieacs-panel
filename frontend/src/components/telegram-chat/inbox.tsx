'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { telegramChatAPI, type TelegramChatConversation, type TelegramChatMessage } from '@/lib/api'
import { TELEGRAM_CHAT_MAX_TEXT, telegramChatErrorKey, telegramChatTitle } from '@/lib/telegram-chat'
import { sameLocalDay } from '@/lib/messenger'
import { TelegramSubscriberLinker } from '@/components/telegram-chat/subscriber-linker'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/** Com que frequência a caixa e a conversa aberta se atualizam. */
const LIST_POLL_MS = 15_000
const THREAD_POLL_MS = 8_000

/**
 * A caixa do Telegram dos clientes: lista de conversas e a conversa aberta.
 *
 * Em tela estreita só uma das duas aparece por vez (a lista, ou a conversa com
 * um botão de voltar), como a caixa do WhatsApp e a do Messenger. Aqui não há
 * janela de resposta (o Telegram não tem): o que fecha o campo é o cliente ter
 * bloqueado o bot, e quem recusa o envio é o servidor.
 */
export function TelegramChatInbox({ canSend, botOn }: { canSend: boolean; botOn: boolean }) {
  const { t, formatDate, formatTime } = useTranslation()
  const toast = useToast()
  const [status, setStatus] = useState<'open' | 'closed'>('open')
  const [conversations, setConversations] = useState<TelegramChatConversation[] | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const loadList = useCallback(async () => {
    const res = await telegramChatAPI.listConversations(status)
    if (res.success && res.data) {
      setConversations(res.data)
      setNow(Date.now())
    } else if (conversations === null) toast.error(t('messenger.loadFailed'))
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
            <p className="empty-state-title">{t(botOn ? 'messenger.empty' : 'telegramChat.emptyNoBot')}</p>
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
                      {telegramChatTitle(conversation)}
                    </span>
                    {conversation.lastMessage && (
                      <span className="shrink-0 font-mono text-[0.68rem] tabular-nums text-muted-foreground">
                        {sameLocalDay(conversation.lastMessage.at, now)
                          ? formatTime(conversation.lastMessage.at)
                          : formatDate(conversation.lastMessage.at)}
                      </span>
                    )}
                    {conversation.unreadCount > 0 && (
                      <span className="modern-badge" aria-label={t('messenger.unread', { count: conversation.unreadCount })}>
                        {conversation.unreadCount}
                      </span>
                    )}
                  </span>
                  {conversation.noticesOff && (
                    <span className="block truncate text-[0.68rem] text-muted-foreground">{t('telegramChat.noticesOff')}</span>
                  )}
                  {conversation.lastMessage && (
                    <span
                      className={`block truncate text-xs ${conversation.unreadCount ? 'text-foreground' : 'text-muted-foreground'}`}
                      data-testid="telegram-chat-preview"
                    >
                      {conversation.lastMessage.direction === 'out'
                        ? t('messenger.preview.you', { text: conversation.lastMessage.text ?? t('messenger.noText') })
                        : (conversation.lastMessage.text ?? t('messenger.noText'))}
                    </span>
                  )}
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
  conversation: TelegramChatConversation
  canSend: boolean
  onBack: () => void
  onChanged: () => void
}) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [current, setCurrent] = useState(conversation)
  const [messages, setMessages] = useState<TelegramChatMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [linking, setLinking] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const res = await telegramChatAPI.listMessages(conversation.id)
    if (res.success && res.data) {
      setCurrent(res.data.conversation)
      setMessages(res.data.messages)
    } else {
      toast.error(t('messenger.messagesLoadFailed'))
    }
  }, [conversation.id, t, toast])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), THREAD_POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const handleSend = async (event: FormEvent) => {
    event.preventDefault()
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const res = await telegramChatAPI.send(conversation.id, body)
      if (res.success && res.data) {
        setText('')
        await load()
        onChanged()
      } else if (res.code === 'send_refused') {
        // O Telegram recusou: a mensagem ficou gravada como falha, com o motivo, na conversa.
        setText('')
        toast.error(t(telegramChatErrorKey(res.code)))
        await load()
        onChanged()
      } else {
        toast.error(t(telegramChatErrorKey(res.code)))
        // O bloqueio muda o estado da conversa; recarrega.
        if (res.code === 'chat_blocked') await load()
      }
    } finally {
      setSending(false)
    }
  }

  const handleClosed = async () => {
    const res = await telegramChatAPI.setClosed(conversation.id, current.closedAt === null)
    if (res.success) {
      onChanged()
      onBack()
    } else {
      toast.error(t(telegramChatErrorKey(res.code)))
    }
  }

  const handleUnlink = async () => {
    const res = await telegramChatAPI.unlinkSubscriber(conversation.id)
    if (res.success && res.data) {
      toast.success(t('messenger.link.unlinked'))
      setCurrent(res.data)
      onChanged()
    } else {
      toast.error(t(telegramChatErrorKey(res.code)))
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button type="button" className="md:hidden max-sm:min-h-10 text-sm font-semibold text-primary" onClick={onBack}>
          {t('messenger.back')}
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{telegramChatTitle(current)}</h3>
          {current.linked && (
            <p className="truncate font-mono text-[0.7rem] text-muted-foreground">
              {current.contract ?? t('messenger.link.noContract')}
            </p>
          )}
        </div>
        {canSend && (
          <button
            type="button"
            className="modern-button-secondary max-sm:min-h-10"
            onClick={() => (current.linked ? void handleUnlink() : setLinking((open) => !open))}
          >
            {t(current.linked ? 'messenger.link.unlink' : 'messenger.link.button')}
          </button>
        )}
        {canSend && (
          <button type="button" className="modern-button-secondary max-sm:min-h-10" onClick={() => void handleClosed()}>
            {t(current.closedAt === null ? 'messenger.archive' : 'messenger.reopen')}
          </button>
        )}
      </div>

      {linking && !current.linked && (
        <TelegramSubscriberLinker
          conversation={current}
          onCancel={() => setLinking(false)}
          onLinked={(linked) => {
            setCurrent(linked)
            setLinking(false)
            onChanged()
          }}
        />
      )}

      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3" role="list">
        {messages.map((message) => (
          <li key={message.id} className={`flex ${message.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                message.direction === 'out' ? 'bg-primary/10 text-foreground' : 'bg-muted text-foreground'
              }`}
            >
              {message.body
                ? <p className="whitespace-pre-wrap break-words">{message.body}</p>
                : <p className="text-muted-foreground">{t('messenger.noText')}</p>}
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[0.68rem] text-muted-foreground">
                <span>{formatDateTime(message.createdAt)}</span>
                {message.direction === 'out' && (message.source === 'system' || message.source === 'notice') && <span>{t('messenger.sentAutomatic')}</span>}
                {message.direction === 'out' && message.deliveryStatus && (
                  <span className={message.deliveryStatus === 'failed' ? 'text-[hsl(var(--status-danger))]' : ''}>
                    {t(`messenger.status.${message.deliveryStatus}`)}
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
          {current.blocked && <p className="field-hint" role="status">{t('telegramChat.blocked')}</p>}
          {current.noticesOff && !current.blocked && <p className="field-hint" role="status">{t('telegramChat.noticesOff')}</p>}
          <div className="flex items-end gap-2">
            <textarea
              className="modern-input min-h-12 flex-1"
              rows={2}
              maxLength={TELEGRAM_CHAT_MAX_TEXT}
              disabled={current.blocked || sending}
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
            <button type="submit" className="modern-button max-sm:min-h-12" disabled={current.blocked || sending || !text.trim()}>
              {sending ? t('messenger.sending') : t('messenger.send')}
            </button>
          </div>
        </form>
      )}
    </>
  )
}
