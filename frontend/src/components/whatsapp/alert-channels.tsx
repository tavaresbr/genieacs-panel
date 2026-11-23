'use client'

import { useTranslation } from '@/contexts/language-context'
import { channelCards, type AlertChannelsInfo, type ChannelTone } from '@/lib/alert-channels'

const DOT: Record<ChannelTone, string> = {
  ok: 'bg-[hsl(var(--status-success))]',
  warn: 'bg-[hsl(var(--status-warning))]',
  off: 'bg-muted-foreground/50'
}

/**
 * Para cada canal de aviso (WhatsApp, e-mail, Telegram): pronto, com algo
 * faltando ou desligado — e o que falta. Só lê; quem decide é a varredura.
 */
export function AlertChannels({ channels }: { channels: AlertChannelsInfo }) {
  const { t } = useTranslation()
  return (
    <section
      className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4"
      aria-label={t('whatsapp.alerts.chTitle')}
    >
      <h3 className="text-sm font-semibold">{t('whatsapp.alerts.chTitle')}</h3>
      <ul className="mt-2 divide-y divide-border">
        {channelCards(channels).map((card) => (
          <li key={card.id} className="flex items-start gap-3 py-2 text-sm">
            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[card.tone]}`} aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium">
                {t(card.title)}
                {card.count !== null && (
                  <span className="ms-2 text-xs font-normal text-muted-foreground">
                    {t('whatsapp.alerts.chRecipients', { count: card.count })}
                  </span>
                )}
              </p>
              <p className="text-muted-foreground">{t(card.hint)}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
