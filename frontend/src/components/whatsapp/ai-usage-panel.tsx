'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type AiUsageReport } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

const PERIODS = [7, 30, 90] as const
type Period = (typeof PERIODS)[number]

/** As tarefas que o modelo rápido pode assumir. */
const SIMPLE = new Set(['resumo', 'reescrever', 'classificar'])

const TASK_LABEL: Record<string, TranslationKey> = {
  conversa: 'whatsapp.aiUsage.task.conversa',
  sugestao: 'whatsapp.aiUsage.task.sugestao',
  rascunho: 'whatsapp.aiUsage.task.rascunho',
  resumo: 'whatsapp.aiUsage.task.resumo',
  reescrever: 'whatsapp.aiUsage.task.reescrever',
  classificar: 'whatsapp.aiUsage.task.classificar',
  visao: 'whatsapp.aiUsage.task.visao',
  teste: 'whatsapp.aiUsage.task.teste',
  outro: 'whatsapp.aiUsage.task.outro'
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="modern-card min-w-0 p-4 sm:p-5">
      <p className="metric-label">{label}</p>
      <p className="metric-value mt-3 wrap-break-word text-xl text-foreground sm:text-3xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Quanto a IA trabalhou: chamadas e tokens por tarefa. Só contagem; preço muda, então não há valor em dinheiro. */
export function AiUsagePanel() {
  const { t, intlLocale } = useTranslation()
  const [days, setDays] = useState<Period>(30)
  const [report, setReport] = useState<AiUsageReport | null>(null)
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async (periodo: Period) => {
    setError('')
    const res = await whatsappAPI.getAiUsage(periodo)
    if (!alive.current) return
    if (res.success && res.data) setReport(res.data)
    else setError(whatsappErrorMessage(t, res.code))
  }, [t])

  useEffect(() => { void load(days) }, [days, load])

  const compact = new Intl.NumberFormat(intlLocale, { notation: 'compact', maximumFractionDigits: 1 })
  const numero = (n: number) => compact.format(n)
  const taxa = (lidos: number, cache: number) => (lidos + cache > 0 ? `${Math.round((cache / (lidos + cache)) * 100)}%` : '—')
  const simples = report ? report.tasks.filter((x) => SIMPLE.has(x.task)).reduce((n, x) => n + x.calls, 0) : 0

  return (
    <section className="grid gap-5">
      <div className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="section-heading">{t('whatsapp.aiUsage.title')}</h2>
            <p className="field-hint mt-1">{t('whatsapp.aiUsage.description')}</p>
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
        {report !== null && report.total.calls === 0 && <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.aiUsage.empty')}</p>}
      </div>

      {report && report.total.calls > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <Tile label={t('whatsapp.aiUsage.calls')} value={numero(report.total.calls)} />
            <Tile label={t('whatsapp.aiUsage.read')} value={numero(report.total.inputTokens + report.total.cacheReadTokens)} />
            <Tile label={t('whatsapp.aiUsage.written')} value={numero(report.total.outputTokens)} />
            <Tile
              label={t('whatsapp.aiUsage.cache')}
              value={report.cacheHitRate === null ? '—' : `${new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 }).format(report.cacheHitRate)}%`}
              hint={t('whatsapp.aiUsage.cacheHint')}
            />
          </div>

          <div className="modern-card overflow-x-auto p-5 sm:p-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">{t('whatsapp.aiUsage.task')}</th>
                  <th scope="col" className="px-3 py-2 text-end font-semibold">{t('whatsapp.aiUsage.calls')}</th>
                  <th scope="col" className="px-3 py-2 text-end font-semibold">{t('whatsapp.aiUsage.read')}</th>
                  <th scope="col" className="px-3 py-2 text-end font-semibold">{t('whatsapp.aiUsage.written')}</th>
                  <th scope="col" className="ps-3 py-2 text-end font-semibold">{t('whatsapp.aiUsage.cache')}</th>
                </tr>
              </thead>
              <tbody>
                {report.tasks.map((x) => (
                  <tr key={x.task} className="border-t border-border tabular-nums">
                    <th scope="row" className="py-2 pe-3 text-start font-normal">{t(TASK_LABEL[x.task] ?? TASK_LABEL.outro)}</th>
                    <td className="px-3 py-2 text-end">{numero(x.calls)}</td>
                    <td className="px-3 py-2 text-end">{numero(x.inputTokens + x.cacheReadTokens)}</td>
                    <td className="px-3 py-2 text-end">{numero(x.outputTokens)}</td>
                    <td className="ps-3 py-2 text-end">{taxa(x.inputTokens, x.cacheReadTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!report.fastModelSet && simples > 0 && (
            <p className="rounded-lg border border-[hsl(var(--status-warning))]/60 bg-[hsl(var(--status-warning))]/10 px-4 py-3 text-sm">
              {t('whatsapp.aiUsage.tip', { count: simples })}
            </p>
          )}
        </>
      )}
    </section>
  )
}
