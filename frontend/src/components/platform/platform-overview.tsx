'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  platformOverviewAPI, type PlatformOverview, type PlatformOverviewRenewal, type PlatformOverviewTrial
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { StatTile } from '@/components/ui/stat-tile'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import type { PlatformTab } from '@/lib/platform-overview'
import type { TranslationKey } from '@/lib/i18n'

/** Para onde um cartão leva: uma aba, e nas Configurações o histórico de alertas. */
export type OverviewTarget = Exclude<PlatformTab, 'home'> | 'alertHistory'

/**
 * A aba Início do console (`GET /platform/overview`): os números de agora —
 * receita, inadimplência, alertas, cancelamentos, provedores novos — e as
 * listas curtas das renovações e dos trials que vencem na semana. Cada cartão
 * leva à aba do detalhe. Um bloco que falhou no servidor aparece como falha
 * só nele; os outros seguem.
 */
export function PlatformOverviewTab({ onNavigate }: { onNavigate: (target: OverviewTarget) => void }) {
  const { t, formatDate, formatDateTime } = useTranslation()
  const [dados, setDados] = useState<PlatformOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await platformOverviewAPI.get()
      if (res.success && res.data) setDados(res.data)
      else setError(res.message || t('platform.overview.loadFailed'))
    } catch {
      setError(t('platform.overview.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const abrir = (rotulo: TranslationKey) => t('platform.overview.open', { tab: t(rotulo) })
  const falhou = t('platform.overview.blockFailed')
  const dias = dados?.windowDays ?? 7

  const receita = dados?.revenue ?? null
  const moeda = receita?.currency || 'BRL'
  const dinheiro = (cents: number) => formatMoney(cents, moeda)
  const inad = dados?.delinquency ?? null
  const alertas = dados?.alerts ?? null
  const cancel = dados?.cancellations ?? null
  const novos = dados?.newTenants ?? null

  return (
    <section className="space-y-4" aria-labelledby="overview-title" aria-busy={loading}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="overview-title" className="section-heading">{t('platform.overview.title')}</h2>
          <p className="field-hint">{t('platform.overview.hint')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dados && (
            <span className="text-xs text-muted-foreground">
              {t('platform.overview.updatedAt', { time: formatDateTime(dados.generatedAt) })}
            </span>
          )}
          <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {error !== null && !loading && (
        <div className="modern-card py-8 text-center" role="alert">
          <p className="text-sm text-destructive">{error}</p>
          <button type="button" className="modern-button-secondary mt-3" onClick={() => void load()}>
            {t('common.refresh')}
          </button>
        </div>
      )}

      {loading && !dados && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="modern-card h-24 animate-pulse bg-muted/40" />)}
        </div>
      )}

      {dados && (
        <>
          {dados.errors.length > 0 && (
            <p className="rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/10 px-3 py-2 text-sm" role="status">
              {t('platform.overview.partial')}
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <StatTile
              label={t('platform.metrics.mrr')}
              value={receita?.mrr.value != null ? dinheiro(receita.mrr.value) : '—'}
              delta={receita ? receita.mrr.delta : undefined}
              deltaPct={receita?.mrr.pct ?? null}
              formatDelta={dinheiro}
              hint={receita ? t('platform.metrics.payingHint', { count: receita.payingCount }) : falhou}
              onClick={() => onNavigate('revenue')}
              actionLabel={abrir('platform.tabs.revenue')}
            />
            <StatTile
              label={t('platform.metrics.received')}
              value={receita?.received.value != null ? dinheiro(receita.received.value) : '—'}
              delta={receita ? receita.received.delta : undefined}
              deltaPct={receita?.received.pct ?? null}
              formatDelta={dinheiro}
              hint={receita ? t('platform.metrics.receivedHint') : falhou}
              onClick={() => onNavigate('revenue')}
              actionLabel={abrir('platform.tabs.revenue')}
            />
            <StatTile
              label={t('platform.overview.overdue')}
              value={inad ? formatMoney(inad.totalOverdueCents, inad.totalsByCurrency[0]?.currency || moeda) : '—'}
              hint={inad
                ? t('platform.overview.overdueHint', { count: inad.count, old: inad.byBucket['30+'] ?? 0 })
                : falhou}
              onClick={() => onNavigate('delinquency')}
              actionLabel={abrir('platform.tabs.delinquency')}
            />
            <StatTile
              label={t('platform.overview.alertsFailed')}
              value={alertas ? String(alertas.failed) : '—'}
              hint={alertas ? t('platform.overview.alertsFailedHint', { days: alertas.windowDays }) : falhou}
              onClick={() => onNavigate('alertHistory')}
              actionLabel={abrir('platform.tabs.settings')}
            />
            <StatTile
              label={t('platform.overview.cancellations')}
              value={cancel ? String(cancel.scheduled) : '—'}
              hint={cancel
                ? [
                    t('platform.overview.cancellationsHint', { pending: cancel.pending }),
                    cancel.nextScheduledAt ? t('platform.overview.nextCancellation', { date: formatDate(cancel.nextScheduledAt) }) : null
                  ].filter(Boolean).join(' · ')
                : falhou}
              onClick={() => onNavigate('subscriptions')}
              actionLabel={abrir('platform.tabs.subscriptions')}
            />
            <StatTile
              label={t('platform.overview.newTenants')}
              value={novos ? String(novos.count) : '—'}
              delta={novos ? novos.delta : undefined}
              deltaPct={novos?.pct ?? null}
              formatDelta={(n) => String(n)}
              hint={novos ? t('platform.overview.newTenantsHint', { previous: novos.previous ?? 0 }) : falhou}
              onClick={() => onNavigate('tenants')}
              actionLabel={abrir('platform.tabs.tenants')}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ListCard
              title={t('platform.overview.renewals', { days: dias })}
              block={dados.renewals}
              empty={t('platform.overview.renewalsEmpty', { days: dias })}
              failed={falhou}
              onSeeAll={() => onNavigate('subscriptions')}
              render={(item: PlatformOverviewRenewal) => (
                <li key={`r${item.tenant.id}`} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{item.tenant.name || item.tenant.slug || `#${item.tenant.id}`}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.plan.name || t('platform.overview.noPlan')}
                      {item.billingCycle === 'annual' && ` · ${t('platform.overview.annual')}`}
                      {item.pendingPlanChange && ` · ${t('platform.overview.pendingChange')}`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm tabular-nums">{formatMoney(item.amountCents, item.currency)}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(item.renewsAt)} · {t(item.cardAutopay ? 'platform.overview.autopay' : 'platform.overview.manualPay')}
                    </p>
                  </div>
                </li>
              )}
            />
            <ListCard
              title={t('platform.overview.trials', { days: dias })}
              block={dados.trials}
              empty={t('platform.overview.trialsEmpty', { days: dias })}
              failed={falhou}
              onSeeAll={() => onNavigate('subscriptions')}
              render={(item: PlatformOverviewTrial) => (
                <li key={`t${item.tenant.id}`} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{item.tenant.name || item.tenant.slug || `#${item.tenant.id}`}</p>
                    <p className="text-xs text-muted-foreground">{item.plan.name || t('platform.overview.noPlan')}</p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p className="text-sm text-foreground">{formatDate(item.trialEndsAt)}</p>
                    <p>{t(item.cardSaved ? 'platform.overview.cardSaved' : 'platform.overview.noCard')}</p>
                  </div>
                </li>
              )}
            />
          </div>
        </>
      )}
    </section>
  )
}

function ListCard<T>({ title, block, empty, failed, onSeeAll, render }: {
  title: string
  block: { total: number; items: T[] } | null
  empty: string
  failed: string
  onSeeAll: () => void
  render: (item: T) => React.ReactNode
}) {
  const { t } = useTranslation()
  const resto = block ? block.total - block.items.length : 0
  return (
    <div className="modern-card min-w-0 p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="section-heading">{title}</h3>
        <button type="button" className="shrink-0 text-sm font-semibold text-primary hover:underline" onClick={onSeeAll}>
          {t('platform.overview.seeAll')}
        </button>
      </div>
      {block === null && <p className="py-4 text-sm text-destructive">{failed}</p>}
      {block && block.items.length === 0 && <p className="py-4 text-sm text-muted-foreground">{empty}</p>}
      {block && block.items.length > 0 && (
        <ul className="divide-y divide-border">{block.items.map(render)}</ul>
      )}
      {resto > 0 && <p className="pt-2 text-xs text-muted-foreground">{t('platform.overview.more', { count: resto })}</p>}
    </div>
  )
}

export default PlatformOverviewTab
