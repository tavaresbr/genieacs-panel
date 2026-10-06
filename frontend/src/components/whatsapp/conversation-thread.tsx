'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AssigneeControl } from '@/components/whatsapp/assignment'
import { TagPicker } from '@/components/whatsapp/tags'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { WhatsAppAccount, WhatsAppConversation, WhatsAppMessage } from '@/lib/api'
import { AccountChip, conversationAddress, conversationTitle } from '@/components/whatsapp/conversation-list'
import { accountTag } from '@/lib/wa-account-color'
import { MessageBubble } from '@/components/whatsapp/message-bubble'
import { SubscriberLinker } from '@/components/whatsapp/subscriber-linker'
import { useAuth } from '@/contexts/auth-context'
import { showActionLabels } from '@/lib/wa-thread-actions'

/** How close to the foot counts as "the operator is at the bottom". */
const STICK_PX = 120

interface ConversationThreadProps {
  conversation: WhatsAppConversation
  /** Os números do provedor, por id: a conversa diz por qual deles chegou. */
  accounts: ReadonlyMap<number, WhatsAppAccount>
  /** Newest first, exactly as the API hands them over. */
  messages: WhatsAppMessage[]
  loading: boolean
  canLoadMore: boolean
  onLoadMore: () => void
  onResend: (message: WhatsAppMessage) => void
  resendingId: number | null
  /** A close or reopen is in flight; the button must not be pressed twice. */
  filing: boolean
  onFile: (status: 'open' | 'closed') => void
  /** Undefined when the operator may not read the ERP: then there is no button. */
  sgpPanelOpen?: boolean
  onToggleSgpPanel?: () => void
  /** The operator linked the thread to an SGP subscriber by hand. */
  onLinked: (conversation: WhatsAppConversation) => void
  /**
   * Back to the list. Only drawn below `lg`, where the inbox shows one pane at
   * a time; on a wide screen the list is right there.
   */
  onBack?: () => void
  /** Teclado aberto no celular: o cabeçalho vira uma linha (voltar + nome). */
  compact?: boolean
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
  accounts,
  messages,
  loading,
  canLoadMore,
  onLoadMore,
  onResend,
  resendingId,
  filing,
  onFile,
  sgpPanelOpen,
  onToggleSgpPanel,
  onLinked,
  onBack,
  compact = false
}: ConversationThreadProps) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const [linkerOpen, setLinkerOpen] = useState(false)
  const closed = Boolean(conversation.closedAt)
  const scrollRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const [headerWidth, setHeaderWidth] = useState(0)
  const stick = useRef(true)

  const address = conversationAddress(conversation)
  const numero = accountTag(accounts, conversation)
  // The API hands the history back newest first; a conversation reads the other
  // way round.
  const ordered = [...messages].reverse()
  const lastId = ordered.length > 0 ? ordered[ordered.length - 1].id : null

  // Os botões do cabeçalho levam texto só quando a coluna da conversa tem
  // largura para os quatro (`lib/wa-thread-actions.ts`). A primeira medida é
  // antes da pintura, para o texto não aparecer e sumir ao abrir a conversa; a
  // partir daí o observador acompanha a janela e o módulo SGP abrindo ao lado.
  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return
    setHeaderWidth(header.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setHeaderWidth(entry.contentRect.width))
    observer.observe(header)
    return () => observer.disconnect()
  }, [])
  const withLabels = showActionLabels(headerWidth)
  const actionClass = withLabels ? 'modern-button-secondary' : 'modern-button-secondary px-3'
  const labelClass = withLabels ? 'inline' : 'hidden'

  // A new thread always opens at its foot: the newest message is the one the
  // operator came here for.
  useEffect(() => {
    const box = scrollRef.current
    setLinkerOpen(false)
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
      <header
        ref={headerRef}
        className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-card px-3 sm:px-4 lg:items-start lg:gap-3 lg:py-3 ${compact ? 'flex-nowrap py-1.5' : 'py-2.5'}`}
      >
        {/* No celular o voltar e as ações dividem a primeira linha, e o nome
            desce para a de baixo (`order-last`): numa linha própria cada, as
            três comiam a altura que as mensagens tinham. */}
        {onBack && (
          <button
            type="button"
            className="-ms-1 inline-flex min-h-10 items-center gap-1.5 rounded-md px-1 text-sm font-semibold text-primary hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            data-testid="inbox-back"
            onClick={onBack}
          >
            <Icon name="back" size={16} />
            {t('whatsapp.inbox.title')}
          </button>
        )}
        <div className={compact ? 'min-w-0 flex-1' : 'order-last w-full min-w-0 lg:order-0 lg:w-auto'}>
          <h2 className="truncate text-base font-semibold text-foreground">{conversationTitle(conversation)}</h2>
          {!compact && address && <p className="truncate font-mono text-xs text-muted-foreground">{address}</p>}

          {/* Com o teclado aberto os selos e as ações saem: a altura vai para as mensagens. */}
          {!compact && (
            <div className={`mt-2 flex flex-wrap items-center gap-1.5 ${numero?.className ?? ''}`}>
              {numero?.showName && <AccountChip name={numero.name} />}
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
                <span className="modern-badge max-w-full">
                  <span className="truncate">{t('whatsapp.inbox.subscriber')}: {conversation.clientName}</span>
                </span>
              )}
              {conversation.botPausedUntil && (
                <span className="modern-badge-warning" title={t('whatsapp.inbox.wantsHumanHint')}>
                  <Icon name="contacts" size={12} />
                  {t('whatsapp.inbox.wantsHuman')}
                </span>
              )}
              {conversation.optedOut && (
                <span className="modern-badge-warning" title={t('whatsapp.inbox.optedOutHint')}>
                  <Icon name="bell" size={12} />
                  {t('whatsapp.inbox.optedOut')}
                </span>
              )}
              {conversation.waitingSince && !conversation.assignedUserId && (
                <span className="modern-badge-warning" title={t('whatsapp.assign.waitingHint')}>
                  <Icon name="contacts" size={12} />
                  {t('whatsapp.assign.waiting')}
                </span>
              )}
              <AssigneeControl conversation={conversation} onChange={onLinked} />
              <TagPicker conversation={conversation} onChange={onLinked} />
              {closed && (
                <span className="modern-badge" title={t('whatsapp.inbox.closeHint')}>
                  <Icon name="check" size={12} />
                  {t('whatsapp.inbox.closed')}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Com a coluna estreita (celular, notebook, módulo SGP aberto) os
            quatro viram só ícone, com o nome no `aria-label` e no `title`; e o
            grupo quebra linha em vez de sair da tela. */}
        {!compact && (
          <div className="flex flex-wrap items-center gap-2">
            {can('whatsapp.send') && (
              <button
                type="button"
                className={actionClass}
                aria-expanded={linkerOpen}
                aria-label={t(conversation.contract ? 'whatsapp.inbox.changeSubscriber' : 'whatsapp.inbox.linkSubscriber')}
                title={t(conversation.contract ? 'whatsapp.inbox.changeSubscriber' : 'whatsapp.inbox.linkSubscriber')}
                onClick={() => setLinkerOpen((open) => !open)}
              >
                <Icon name="edit" size={16} />
                <span className={labelClass}>
                  {t(conversation.contract ? 'whatsapp.inbox.changeSubscriber' : 'whatsapp.inbox.linkSubscriber')}
                </span>
              </button>
            )}

            {/* Closing is not a destructive act and is not offered as one: the
                hint says what it does, and the same button undoes it. */}
            <button
              type="button"
              className={actionClass}
              disabled={filing}
              aria-label={t(closed ? 'whatsapp.inbox.reopen' : 'whatsapp.inbox.close')}
              title={t('whatsapp.inbox.closeHint')}
              onClick={() => onFile(closed ? 'open' : 'closed')}
            >
              <Icon name={closed ? 'refresh' : 'check'} size={16} className={filing ? 'animate-spin' : ''} />
              <span className={labelClass}>{t(closed ? 'whatsapp.inbox.reopen' : 'whatsapp.inbox.close')}</span>
            </button>

            {onToggleSgpPanel && (
              <button
                type="button"
                className={actionClass}
                aria-pressed={Boolean(sgpPanelOpen)}
                aria-label={t('whatsapp.sgp.toggle')}
                title={t('whatsapp.sgp.toggle')}
                onClick={onToggleSgpPanel}
              >
                <Icon name="database" size={16} />
                <span className={labelClass}>{t('whatsapp.sgp.toggle')}</span>
              </button>
            )}

            {conversation.deviceId && (
              <Link
                to={`/devices/detail?id=${encodeURIComponent(conversation.deviceId)}`}
                className={actionClass}
                aria-label={t('whatsapp.inbox.openDevice')}
                title={t('whatsapp.inbox.openDevice')}
              >
                <Icon name="server" size={16} />
                <span className={labelClass}>{t('whatsapp.inbox.openDevice')}</span>
              </Link>
            )}
          </div>
        )}
      </header>

      {linkerOpen && (
        <SubscriberLinker
          conversation={conversation}
          onCancel={() => setLinkerOpen(false)}
          onLinked={(linked) => {
            setLinkerOpen(false)
            onLinked(linked)
          }}
        />
      )}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[hsl(var(--surface-subtle))] px-3 py-3 sm:px-4 sm:py-4"
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
          // A classe do número fica na lista, e o balão RECEBIDO lê a cor dela:
          // é a mensagem que chegou por aquele número. O que o provedor mandou
          // continua na cor do painel.
          <ul className={`flex flex-col gap-2 ${numero?.className ?? ''}`} role="list">
            {ordered.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onResend={onResend}
                resending={resendingId === message.id}
                accountTinted={numero !== null}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
