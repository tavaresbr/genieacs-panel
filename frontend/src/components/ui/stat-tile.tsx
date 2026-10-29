import type { ReactNode } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { deltaText, deltaTone } from '@/lib/platform-overview'

/**
 * Um número com rótulo, a variação sobre o período anterior e uma dica — o
 * cartão das métricas da Receita e do painel Início.
 *
 * - `delta` ausente: sem a linha da variação. Presente e nulo (ou zero):
 *   "Sem variação".
 * - `formatDelta` formata o valor absoluto da variação (o padrão é o número
 *   cru); `deltaPct` é a fração (0,05 = 5%).
 * - `upIsBad`: onde subir é ruim (inadimplência, falhas), o verde e o
 *   vermelho trocam.
 * - `onClick`: o cartão vira botão (leva à aba do detalhe).
 */
export function StatTile({
  label, value, delta, deltaPct = null, formatDelta = String, hint, upIsBad = false, onClick, actionLabel
}: {
  label: string
  value: ReactNode
  delta?: number | null
  deltaPct?: number | null
  formatDelta?: (value: number) => string
  hint?: ReactNode
  upIsBad?: boolean
  onClick?: () => void
  /** O nome acessível do botão, quando `onClick` (o padrão é o rótulo). */
  actionLabel?: string
}) {
  const { t, intlLocale: locale } = useTranslation()
  const tom = deltaTone(delta, upIsBad)
  const corpo = (
    <>
      <p className="metric-label">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{value}</p>
      {delta !== undefined && (
        <p className={`text-xs font-medium ${tom === 'neutral' ? 'text-muted-foreground' : tom === 'good' ? 'text-[hsl(var(--status-success))]' : 'text-destructive'}`}>
          <span className="sr-only">{t('platform.metrics.vsPrevious')}: </span>
          {deltaText(delta, deltaPct, formatDelta, locale) ?? t('platform.metrics.noChange')}
        </p>
      )}
      {hint && <p className="field-hint">{hint}</p>}
    </>
  )
  if (!onClick) return <div className="modern-card p-3">{corpo}</div>
  return (
    <button
      type="button"
      onClick={onClick}
      title={actionLabel}
      className="modern-card block w-full p-3 text-left transition hover:border-primary/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {corpo}
      {actionLabel && <span className="sr-only">{actionLabel}</span>}
    </button>
  )
}

export default StatTile
