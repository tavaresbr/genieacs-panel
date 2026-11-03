'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { onboardingConsoleAPI, type OnboardingSummary } from '@/lib/api'

/**
 * O progresso dos primeiros passos de cada provedor, na lista do console.
 *
 * Lido à parte da lista (`GET /platform/tenants/onboarding`) e depois dela: a
 * lista aparece na hora, e o percentual chega quando chega. Uma falha aqui
 * deixa a coluna em branco, nunca a lista sem provedores.
 */
export function useOnboardingSummaries(enabled: boolean, reloadKey: unknown): Map<number, OnboardingSummary> {
  const [mapa, setMapa] = useState<Map<number, OnboardingSummary>>(() => new Map())
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void onboardingConsoleAPI.summaries().then((res) => {
      if (cancelled || !res.success || !res.data) return
      setMapa(new Map(res.data.summaries.map((summary) => [summary.tenantId, summary])))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [enabled, reloadKey])
  return mapa
}

/** "62%", e "travado" ao lado quando passou de 7 dias abaixo da metade. */
export function OnboardingBadge({ summary }: { summary: OnboardingSummary | undefined }) {
  const { t } = useTranslation()
  if (!summary) return <span className="text-sm text-muted-foreground">—</span>
  const cor = summary.percent >= 100
    ? 'modern-badge-success'
    : summary.stuck ? 'modern-badge-warning' : 'modern-badge-info'
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1.5"
      title={t('platform.onboarding.detail', { done: summary.done, total: summary.total })}
      data-testid="tenant-onboarding"
    >
      <span className={cor}>{t('platform.onboarding.percent', { percent: summary.percent })}</span>
      {summary.stuck && <span className="modern-badge-error">{t('platform.onboarding.stuck')}</span>}
    </span>
  )
}

/** O filtro "só os travados", com a contagem. */
export function OnboardingStuckFilter({
  summaries, active, onChange
}: { summaries: Map<number, OnboardingSummary>; active: boolean; onChange: (active: boolean) => void }) {
  const { t } = useTranslation()
  const travados = [...summaries.values()].filter((summary) => summary.stuck).length
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={active ? 'modern-button-secondary' : 'modern-button'}
        aria-pressed={!active}
        onClick={() => onChange(false)}
      >
        {t('platform.onboarding.filterAll')}
      </button>
      <button
        type="button"
        className={active ? 'modern-button' : 'modern-button-secondary'}
        aria-pressed={active}
        onClick={() => onChange(true)}
      >
        {t('platform.onboarding.filterStuck', { count: travados })}
      </button>
      <span className="field-hint">{t('platform.onboarding.stuckHint')}</span>
    </div>
  )
}
