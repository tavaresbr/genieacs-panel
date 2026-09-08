'use client'

import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { WhatsAppMessage } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

type DeliveryStatus = NonNullable<WhatsAppMessage['deliveryStatus']>

const DELIVERY_LABEL: Record<DeliveryStatus, TranslationKey> = {
  queued: 'whatsapp.delivery.queued',
  sending: 'whatsapp.delivery.sending',
  sent: 'whatsapp.delivery.sent',
  delivered: 'whatsapp.delivery.delivered',
  read: 'whatsapp.delivery.read',
  failed: 'whatsapp.delivery.failed'
}

/**
 * The rung of `queued → sending → sent → delivered → read` gets a shape of its
 * own, because "it left the panel" and "the customer opened it" are different
 * facts and an operator deciding whether to call someone reads them
 * differently. Only `failed` is coloured: everything else is progress, and a
 * screen where five of six states shout has no way left to shout.
 */
const DELIVERY_ICON: Record<DeliveryStatus, 'refresh' | 'check' | 'eye' | 'warning'> = {
  queued: 'refresh',
  sending: 'refresh',
  sent: 'check',
  delivered: 'check',
  read: 'eye',
  failed: 'warning'
}

/**
 * `delivery_error` is 500 characters of whatever the Evolution server said. It
 * belongs on the screen — the operator has to know a message did not go out and
 * roughly why — but not as a wall of JSON in the middle of a conversation. The
 * full text stays reachable in the tooltip.
 */
const REASON_MAX = 140

function truncateReason(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim()
  return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX - 1)}…` : flat
}

function clock(iso: string | null, intlLocale: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(intlLocale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)
}

interface MessageBubbleProps {
  message: WhatsAppMessage
  /** Offered only for a failed outbound; the page re-queues the same text. */
  onResend: (message: WhatsAppMessage) => void
  resending: boolean
}

export function MessageBubble({ message, onResend, resending }: MessageBubbleProps) {
  const { t, intlLocale } = useTranslation()
  const stamp = clock(message.createdAt, intlLocale)

  const attachment = message.attachment && (
    <span className="mt-2 flex items-center gap-1.5 rounded border border-border/70 bg-background/40 px-2 py-1.5 text-xs">
      <Icon name="box" size={14} className="shrink-0 text-muted-foreground" />
      <span className="truncate" title={message.attachment.name || message.attachment.url}>
        {message.attachment.name || t('whatsapp.inbox.attachment')}
      </span>
    </span>
  )

  const body = message.body
    ? <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.body}</p>
    : !message.attachment
      ? <p className="text-sm italic text-muted-foreground">{t('whatsapp.inbox.attachment')}</p>
      : null

  // ── An internal note ──────────────────────────────────────────────────────
  // Not a bubble at all. A note is stored with `deliveryStatus: null` and the
  // outbox worker never sees it, so nothing about it will ever look wrong on
  // its own — the only thing that can go wrong is an operator reading it as a
  // reply and waiting for an answer that the customer was never asked for.
  // That is why it breaks the chat's whole grammar rather than being a sent
  // bubble in another colour: full width instead of aligned, dashed instead of
  // solid, and labelled in words.
  if (message.isNote) {
    return (
      <li className="my-1 w-full">
        <div className="rounded-[var(--radius)] border border-dashed border-[hsl(var(--status-warning))]/60 bg-[hsl(var(--status-warning))]/[0.07] px-3 py-2.5">
          <p className="mb-1.5 flex items-center gap-1.5 text-[0.62rem] font-bold uppercase tracking-[0.14em] text-[hsl(var(--status-warning))]">
            <Icon name="lock" size={12} />
            {t('whatsapp.inbox.note')}
          </p>
          <div className="text-foreground">{body}</div>
          {attachment}
          <p className="mt-1.5 font-mono text-[0.62rem] tabular-nums text-muted-foreground">{stamp}</p>
        </div>
      </li>
    )
  }

  const inbound = message.direction === 'in'
  const failed = message.deliveryStatus === 'failed'

  return (
    <li className={`flex w-full ${inbound ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-[min(38rem,85%)] rounded-[var(--radius)] border px-3 py-2 ${
          inbound
            ? 'border-border bg-card text-card-foreground'
            : failed
              ? 'border-[hsl(var(--status-danger))]/45 bg-[hsl(var(--status-danger))]/[0.07] text-foreground'
              : 'border-primary/30 bg-primary/10 text-foreground'
        }`}
      >
        {body}
        {attachment}

        <div className="mt-1.5 flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <span className="font-mono text-[0.62rem] tabular-nums text-muted-foreground">{stamp}</span>
          {message.deliveryStatus && (
            <span
              className={`inline-flex items-center gap-1 text-[0.62rem] font-semibold ${
                failed ? 'text-[hsl(var(--status-danger))]' : 'text-muted-foreground'
              }`}
            >
              <Icon
                name={DELIVERY_ICON[message.deliveryStatus]}
                size={12}
                className={message.deliveryStatus === 'sending' ? 'animate-spin' : ''}
              />
              {t(DELIVERY_LABEL[message.deliveryStatus])}
            </span>
          )}
        </div>

        {failed && (
          <div className="mt-2 border-t border-[hsl(var(--status-danger))]/25 pt-2">
            <p
              className="text-xs leading-5 text-[hsl(var(--status-danger))]"
              title={message.deliveryError || undefined}
            >
              {t('whatsapp.inbox.deliveryFailed', {
                reason: truncateReason(message.deliveryError || t('common.unknown'))
              })}
            </p>
            <button
              type="button"
              className="modern-button-secondary mt-2 min-h-9 px-3 py-1 text-xs"
              disabled={resending}
              onClick={() => onResend(message)}
            >
              <Icon name="refresh" size={13} className={resending ? 'animate-spin' : ''} />
              {t('whatsapp.inbox.resend')}
            </button>
          </div>
        )}
      </div>
    </li>
  )
}
