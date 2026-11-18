'use client'

import type { AcsHealth } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { acsCodeLabelKey, acsReasonKey } from '@/lib/acs-health'

interface Props {
  health: AcsHealth | null | undefined
  /** `compact`: só a linha "fora (DNS) desde 09:46", para a lista de provedores. */
  compact?: boolean
}

/**
 * A saúde do GenieACS de um provedor, como o console a mostra: "GenieACS fora
 * (DNS) desde 09:46" — o que antes exigia SSH e `journalctl` para descobrir.
 *
 * Vem da memória do servidor (`acsHealth.js`): é o que o painel do provedor
 * viu nos pedidos de verdade ao ACS dele, e não um teste feito agora.
 */
export function AcsHealthStatus({ health, compact = false }: Props) {
  const { t, formatDateTime } = useTranslation()
  if (!health) return null

  if (health.status === 'down') {
    const linha = t('acsHealth.downSince', {
      code: t(acsCodeLabelKey(health.code)),
      time: formatDateTime(health.since)
    })
    if (compact) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive" data-testid="acs-health-down">
          <Icon name="warning" size={13} />
          {linha}
        </span>
      )
    }
    return (
      <div role="status" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        <p className="flex items-center gap-2 font-semibold">
          <Icon name="warning" size={16} />
          {linha}
        </p>
        <p className="mt-1">{t(acsReasonKey(health.code))}</p>
        {health.consecutiveFailures > 1 && (
          <p className="mt-1 text-xs text-destructive/90">
            {t('acsHealth.failures', { count: health.consecutiveFailures })}
          </p>
        )}
      </div>
    )
  }

  // Na lista, só a queda importa: "respondendo" em cada linha é ruído.
  if (compact) return null
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Icon name={health.lastCheckedAt ? 'check' : 'info'} size={15} />
      {health.lastCheckedAt
        ? t('acsHealth.okSince', { time: formatDateTime(health.lastCheckedAt) })
        : t('acsHealth.never')}
    </p>
  )
}

export default AcsHealthStatus
