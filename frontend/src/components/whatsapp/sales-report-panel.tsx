'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type SaleLostReason, type SalesReport } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

const PERIODS = [7, 30, 90] as const
type Period = (typeof PERIODS)[number]
const REASONS: SaleLostReason[] = ['price', 'competitor', 'no_coverage', 'no_interest', 'other']

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="modern-card min-w-0 p-4 sm:p-5">
      <p className="metric-label">{label}</p>
      <p className="metric-value mt-3 wrap-break-word text-xl text-foreground sm:text-3xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** As vendas que a IA entregou à equipe e como terminaram. Só leitura. */
export function SalesReportPanel() {
  const { t, intlLocale } = useTranslation()
  const [days, setDays] = useState<Period>(30)
  const [report, setReport] = useState<SalesReport | null>(null)
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async (periodo: Period) => {
    setError('')
    const res = await whatsappAPI.getSalesReport(periodo)
    if (!alive.current) return
    if (res.success && res.data) setReport(res.data)
    else setError(whatsappErrorMessage(t, res.code))
  }, [t])

  useEffect(() => { void load(days) }, [days, load])

  const numero = (n: number) => new Intl.NumberFormat(intlLocale).format(n)
  const maxMotivo = report ? Math.max(1, ...REASONS.map((r) => report.lostReasons[r])) : 1

  return (
    <section className="grid gap-5">
      <div className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="section-heading">{t('whatsapp.salesReport.title')}</h2>
            <p className="field-hint mt-1">{t('whatsapp.salesReport.description')}</p>
          </div>
          <div className="tab-rail" role="radiogroup" aria-label={t('whatsapp.botReport.period')}>
            {PERIODS.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={days === p} data-active={days === p} className="tab-button" onClick={() => setDays(p)}>
                {t('whatsapp.botReport.lastDays', { count: p })}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-[hsl(var(--status-danger))]">{error}</p>}
        {report === null && !error && <p className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>}
        {report !== null && report.leads === 0 && <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.salesReport.empty')}</p>}
      </div>

      {report && report.leads > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <Tile label={t('whatsapp.salesReport.leads')} value={numero(report.leads)} />
            <Tile label={t('whatsapp.salesReport.won')} value={numero(report.won)} hint={t('whatsapp.salesReport.open') + `: ${numero(report.open)}`} />
            <Tile label={t('whatsapp.salesReport.lost')} value={numero(report.lost)} />
            <Tile
              label={t('whatsapp.salesReport.conversion')}
              value={report.conversionRate === null ? '—' : `${new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 }).format(report.conversionRate)}%`}
              hint={t('whatsapp.salesReport.conversionHint')}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="modern-card p-5 sm:p-6">
              <h3 className="section-heading">{t('whatsapp.salesReport.lostReasons')}</h3>
              {report.lost === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.salesReport.none')}</p>
              ) : (
                <ul className="mt-3 grid gap-3">
                  {REASONS.map((r) => (
                    <li key={r}>
                      <div className="flex justify-between text-sm">
                        <span>{t(`whatsapp.closeSale.${r}` as TranslationKey)}</span>
                        <span className="tabular-nums">{numero(report.lostReasons[r])}</span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-[hsl(var(--surface-subtle))]" aria-hidden="true">
                        <div className="h-2 rounded-full bg-[hsl(var(--primary))]" style={{ width: `${(report.lostReasons[r] / maxMotivo) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="grid content-start gap-5">
              <div className="modern-card p-5 sm:p-6">
                <h3 className="section-heading">{t('whatsapp.salesReport.topPlans')}</h3>
                {report.topPlans.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.salesReport.none')}</p>
                ) : (
                  <ul className="mt-3 grid gap-2 text-sm">
                    {report.topPlans.map((p) => (
                      <li key={p.planId} className="flex justify-between gap-3">
                        <span className="wrap-anywhere">{p.name ?? `#${p.planId}`}</span>
                        <span className="tabular-nums">{numero(p.sales)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="modern-card p-5 sm:p-6">
                <h3 className="section-heading">{t('whatsapp.salesReport.topKnowledge')}</h3>
                {report.topKnowledge.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.salesReport.none')}</p>
                ) : (
                  <ul className="mt-3 grid gap-2 text-sm">
                    {report.topKnowledge.map((k) => (
                      <li key={k.id} className="flex justify-between gap-3">
                        <span className="wrap-anywhere">{k.title}</span>
                        <span className="tabular-nums">{t('whatsapp.salesReport.uses', { n: numero(k.uses) })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

export default SalesReportPanel
