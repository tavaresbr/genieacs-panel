'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { platformReportsAPI, type MonthlyMetrics, type MonthlyMetricsMonth } from '@/lib/api'
import { BarChart } from '@/components/charts/bar-chart'
import { PieChart } from '@/components/charts/pie-chart'
import { SeriesChart } from '@/components/charts/series-chart'
import { Icon } from '@/components/ui/icon'
import { StatTile } from '@/components/ui/stat-tile'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { monthLabel, monthOverMonth } from '@/lib/revenue-report'

/**
 * Os gráficos mês a mês da aba Receita (`GET /platform/metrics/monthly`): MRR,
 * recebido, novos e cancelados, inadimplência e receita por plano. Os meses
 * são os de Brasília, como o relatório mensal que sai no dia 1º.
 *
 * Só os componentes de `components/charts`, sem biblioteca nova. Os valores
 * em dinheiro vão em reais inteiros para as barras e a pizza (que mostram o
 * número cru); as linhas usam o `SeriesChart`, que formata o valor.
 */

const OPCOES_MESES = [6, 12, 24] as const
const CORES = [
  'hsl(var(--primary))',
  'hsl(var(--status-info))',
  'hsl(var(--status-success))',
  'hsl(var(--status-warning))',
  'hsl(var(--status-danger))',
  'hsl(var(--muted-foreground))'
]

/** O instante (em segundos) do dia 15 do mês, para o eixo do `SeriesChart`. */
const meioDoMes = (month: string) => {
  const [ano, mes] = month.split('-').map(Number)
  return Math.floor(Date.UTC(ano, mes - 1, 15) / 1000)
}
const reais = (cents: number) => Math.round(cents / 100)

export function PlatformRevenueCharts() {
  const { t, intlLocale: locale } = useTranslation()
  const [meses, setMeses] = useState<number>(12)
  const [dados, setDados] = useState<MonthlyMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const selectId = useId()

  const load = useCallback(async (n: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await platformReportsAPI.monthlyMetrics(n)
      if (res.success && res.data) setDados(res.data)
      else {
        setDados(null)
        setError(res.message || t('platform.metrics.loadFailed'))
      }
    } catch {
      setDados(null)
      setError(t('platform.metrics.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load(meses)
  }, [load, meses])

  const moeda = dados?.currency || 'BRL'
  const serie = dados?.months ?? []
  const vazio = serie.every((m) => !m.mrrCents && !m.grossCents && !m.refundedCents && !m.newTenants
    && !m.canceledTenants && !m.overdueCents)
  const rotulo = (m: MonthlyMetricsMonth) => monthLabel(m.month, locale)
  const formatarTempo = (segundos: number) => {
    const d = new Date(segundos * 1000)
    return monthLabel(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, locale, 'long')
  }
  const dinheiro = (cents: number) => formatMoney(cents, moeda)
  const dinheiroDeReais = (valor: number) => formatMoney(Math.round(valor * 100), moeda)

  return (
    <section className="space-y-4" aria-labelledby="revenue-charts-title" aria-busy={loading}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="revenue-charts-title" className="section-heading">{t('platform.metrics.title')}</h2>
          <p className="field-hint">{t('platform.metrics.hint')}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={selectId} className="mb-1 block text-sm font-medium">{t('platform.metrics.months')}</label>
            <select
              id={selectId}
              className="modern-input w-32"
              value={meses}
              onChange={(e) => setMeses(Number(e.target.value))}
            >
              {OPCOES_MESES.map((n) => <option key={n} value={n}>{t('platform.metrics.lastMonths', { count: n })}</option>)}
            </select>
          </div>
          <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load(meses)}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {error !== null && !loading && (
        <p className="modern-card py-8 text-center text-sm text-destructive" role="alert">{error}</p>
      )}

      {loading && !dados && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="modern-card h-24 animate-pulse bg-muted/40" />)}
        </div>
      )}

      {dados && vazio && !loading && (
        <p className="modern-card py-8 text-center text-sm text-muted-foreground">{t('platform.metrics.empty')}</p>
      )}

      {dados && !vazio && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile
              label={t('platform.metrics.mrr')}
              variacao={monthOverMonth(serie, (m) => m.mrrCents)}
              format={dinheiro}
              hint={t('platform.metrics.payingHint', { count: serie.at(-1)?.payingCount ?? 0 })}
            />
            <MetricTile
              label={t('platform.metrics.received')}
              variacao={monthOverMonth(serie, (m) => m.receivedCents)}
              format={dinheiro}
              hint={t('platform.metrics.receivedHint')}
            />
            <MetricTile
              label={t('platform.metrics.newVsCanceled')}
              variacao={monthOverMonth(serie, (m) => m.newTenants - m.canceledTenants)}
              format={(n) => `${n > 0 ? '+' : ''}${n}`}
              hint={t('platform.metrics.newVsCanceledHint', {
                new: serie.at(-1)?.newTenants ?? 0,
                canceled: serie.at(-1)?.canceledTenants ?? 0,
                churn: churnTexto(serie.at(-1)?.churnRate ?? null, locale)
              })}
            />
            <MetricTile
              label={t('platform.metrics.overdue')}
              variacao={monthOverMonth(serie, (m) => m.overdueCents)}
              format={dinheiro}
              hint={t('platform.metrics.overdueHint', { count: serie.at(-1)?.overdueCount ?? 0 })}
              upIsBad
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title={t('platform.metrics.mrrChart')} hint={t('platform.metrics.approxHint')}>
              <SeriesChart
                points={serie.map((m) => ({ t: meioDoMes(m.month), value: m.mrrCents / 100 }))}
                formatValue={dinheiroDeReais}
                formatTime={formatarTempo}
                emptyLabel={t('platform.metrics.empty')}
                ariaLabel={t('platform.metrics.mrrChart')}
              />
            </ChartCard>
            <ChartCard title={t('platform.metrics.receivedChart')} hint={t('platform.metrics.inReais')}>
              <BarChart data={serie.map((m) => ({ name: rotulo(m), value: reais(m.receivedCents) }))} valueLabel={moeda} />
            </ChartCard>
            <ChartCard title={t('platform.metrics.newChart')}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="metric-label mb-1">{t('platform.metrics.new')}</p>
                  <BarChart data={serie.map((m) => ({ name: rotulo(m), value: m.newTenants }))} valueLabel={t('platform.metrics.new')} />
                </div>
                <div>
                  <p className="metric-label mb-1">{t('platform.metrics.canceled')}</p>
                  <BarChart data={serie.map((m) => ({ name: rotulo(m), value: m.canceledTenants }))} valueLabel={t('platform.metrics.canceled')} />
                </div>
              </div>
            </ChartCard>
            <ChartCard title={t('platform.metrics.overdueChart')} hint={t('platform.metrics.approxHint')}>
              <SeriesChart
                points={serie.map((m) => ({ t: meioDoMes(m.month), value: m.overdueCents / 100 }))}
                formatValue={dinheiroDeReais}
                formatTime={formatarTempo}
                emptyLabel={t('platform.metrics.empty')}
                ariaLabel={t('platform.metrics.overdueChart')}
              />
            </ChartCard>
            <ChartCard
              title={t('platform.metrics.byPlanChart', { month: monthLabel(dados.revenueByPlanMonth, locale, 'long') })}
              hint={t('platform.metrics.inReais')}
            >
              {dados.revenueByPlan.some((l) => l.receivedCents > 0) ? (
                <PieChart
                  data={dados.revenueByPlan.filter((l) => l.receivedCents > 0).map((l, i) => ({
                    name: l.name ?? t('platform.revenue.noPlan'),
                    value: reais(l.receivedCents),
                    color: CORES[i % CORES.length]
                  }))}
                  valueLabel={moeda}
                />
              ) : (
                <p className="empty-state-copy py-16 text-center">{t('platform.metrics.byPlanEmpty')}</p>
              )}
            </ChartCard>
          </div>
        </>
      )}
    </section>
  )
}

/** O `StatTile` com a variação mês a mês de `monthOverMonth`. */
function MetricTile({ label, variacao, format, hint, upIsBad = false }: {
  label: string
  variacao: { value: number | null; delta: number | null; pct: number | null }
  format: (value: number) => string
  hint?: string
  /** Na inadimplência, subir é ruim. */
  upIsBad?: boolean
}) {
  return (
    <StatTile
      label={label}
      value={variacao.value === null ? '-' : format(variacao.value)}
      delta={variacao.delta}
      deltaPct={variacao.pct}
      formatDelta={format}
      hint={hint}
      upIsBad={upIsBad}
    />
  )
}

function churnTexto(rate: number | null, locale: string) {
  if (rate === null) return '-'
  try {
    return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(rate)
  } catch {
    return `${(rate * 100).toFixed(1)}%`
  }
}

function ChartCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="modern-card min-w-0 p-4">
      <h3 className="section-heading">{title}</h3>
      {hint && <p className="field-hint mb-2">{hint}</p>}
      {children}
    </div>
  )
}

export default PlatformRevenueCharts
