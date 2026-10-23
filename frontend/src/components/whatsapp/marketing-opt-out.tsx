'use client'

import { useState } from 'react'
import { whatsappAPI, type WhatsAppConversation, type WhatsAppMarketingOptOut } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import type { TranslationKey } from '@/lib/i18n'

const SOURCE_LABEL: Record<WhatsAppMarketingOptOut['source'], TranslationKey> = {
  keyword: 'whatsapp.marketingOptOut.sourceKeyword',
  button: 'whatsapp.marketingOptOut.sourceButton',
  operator: 'whatsapp.marketingOptOut.sourceOperator'
}

/**
 * "Não quer promoções" na conversa aberta: o selo, quando o cliente pediu (ou
 * a equipe marcou), e o botão para marcar e desmarcar.
 *
 * Marcar protege o cliente e é de quem atende (`whatsapp.send`). Desmarcar
 * devolve a promoção a alguém que pediu para sair, e pede quem decide campanha
 * (`campaigns.manage`) — com confirmação, porque o pedido foi dele.
 */
export function MarketingOptOutControl({ conversation, onChange }: {
  conversation: WhatsAppConversation
  onChange: (next: WhatsAppConversation) => void
}) {
  const { t, formatDateTime } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const optOut = conversation.marketingOptOut ?? null
  const hasAddress = Boolean(conversation.waPhoneE164 || conversation.waLid)

  const toggle = async (next: boolean) => {
    if (!next && !window.confirm(t('whatsapp.marketingOptOut.confirmClear'))) return
    setSaving(true)
    try {
      const res = next
        ? await whatsappAPI.setMarketingOptOut(conversation.id)
        : await whatsappAPI.clearMarketingOptOut(conversation.id)
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      onChange(res.data)
      toast.success(t(next ? 'whatsapp.marketingOptOut.markedToast' : 'whatsapp.marketingOptOut.clearedToast'))
    } finally {
      setSaving(false)
    }
  }

  if (optOut) {
    const hint = [
      t('whatsapp.marketingOptOut.hint'),
      t(SOURCE_LABEL[optOut.source] ?? SOURCE_LABEL.keyword),
      optOut.since ? formatDateTime(optOut.since) : null
    ].filter(Boolean).join(' · ')
    return (
      <span className="modern-badge-warning" title={hint} data-testid="marketing-opt-out-badge">
        <Icon name="bell" size={12} />
        {t('whatsapp.marketingOptOut.badge')}
        {can('campaigns.manage') && (
          <button
            type="button"
            className="-me-1 inline-flex size-5 items-center justify-center rounded-full hover:bg-black/10 disabled:opacity-50"
            aria-label={t('whatsapp.marketingOptOut.clear')}
            title={t('whatsapp.marketingOptOut.clear')}
            disabled={saving}
            onClick={() => void toggle(false)}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </span>
    )
  }

  if (!can('whatsapp.send') || !hasAddress) return null
  return (
    <button
      type="button"
      className="inline-flex min-h-7 items-center gap-1 rounded-full border border-dashed border-border px-2 text-[0.68rem] font-semibold text-muted-foreground hover:bg-[hsl(var(--surface-subtle))] disabled:opacity-50"
      title={t('whatsapp.marketingOptOut.markHint')}
      disabled={saving}
      data-testid="marketing-opt-out-mark"
      onClick={() => void toggle(true)}
    >
      <Icon name="bell" size={12} />
      {t('whatsapp.marketingOptOut.mark')}
    </button>
  )
}
