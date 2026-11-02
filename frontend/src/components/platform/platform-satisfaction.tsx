'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { npsAPI, type NpsReport, type NpsRiskSignal, type NpsWave } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { monthLabel } from '@/lib/revenue-report'
import { NPS_SCORES, distributionMax, formatNps, npsCategory, npsTone, subscriptionHref } from '@/lib/nps'

/**
 * A satisfação dos provedores (NPS, 0123), na aba Receita do console, desde o
 * início do período da aba: o NPS (promotores menos detratores), a
 * distribuição das notas, a evolução por mês, os comentários, os detratores
 * com o sinal de risco (atraso, cartão recusado, cancelamento ou pausa) e o
 * "Enviar pesquisa" para um provedor.
 */
export const NPS_SIGNAL_KEYS: Record<NpsRiskSignal, TranslationKey> = {
  overdue: 'platform.nps.signal.overdue',
  card_refused: 'platform.nps.signal.card_refused',
  cancellation: 'platform.nps.signal.cancellation',
  paused: 'platform.nps.signal.paused'
}

export const NPS_WAVE_KEYS: Record<NpsWave, TranslationKey> = {
  d30: 'platform.nps.wave.d30',
  d90: 'platform.nps.wave.d90',
  manual: 'platform.nps.wave.manual'
}

const SEND_ERROR_KEYS: Record<string, TranslationKey> = {
  recent: 'platform.nps.sendError.recent',
  no_destination: 'platform.nps.sendError.no_destination',
  no_link: 'platform.nps.sendError.no_link',
  send_failed: 'platform.nps.sendError.send_failed'
}

const TOM_DO_NPS = {
  good: 'text-[hsl(var(--status-success))]',
  bad: 'text-[hsl(var(--status-danger))]',
  neutral: 'text-foreground'
} as const

const COR_DA_NOTA = {
  promoter: 'bg-[hsl(var(--status-success))]',
  passive: 'bg-[hsl(var(--status-warning))]',
  detractor: 'bg-[hsl(var(--status-danger))]'
} as const

export function PlatformSatisfaction({ from }: { from?: string }) {
  const { t, locale, formatDate } = useTranslation()
  const toast = useToast()
  const providerId = useId()
  const [report, setReport] = useState<NpsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [escolhido, setEscolhido] = useState('')
  const [enviando, setEnviando] = useState(false)

  const load = useCallback(async () => {
    const res = await npsAPI.report(from)
    if (res.success && res.data) {
      setReport(res.data)
      setError(null)
    } else {
      setError(res.message || t('platform.nps.loadFailed'))
    }
  }, [from, t])

  useEffect(() => {
    void load()
  }, [load])

  const enviar = async () => {
    const id = Number(escolhido)
    if (!Number.isInteger(id) || id <= 0) return
    setEnviando(true)
    try {
      const res = await npsAPI.send(id)
      if (res.success) {
        toast.success(t('platform.nps.sent'))
        setEscolhido('')
        void load()
      } else {
        toast.error(t(SEND_ERROR_KEYS[res.code ?? ''] ?? 'platform.nps.sendFailed'))
      }
    } catch {
      toast.error(t('platform.nps.sendFailed'))
    } finally {
      setEnviando(false)
    }
  }

  const nomeDe = (tenant: { name: string | null; slug: string | null; id: number }) => tenant.name ?? tenant.slug ?? `#${tenant.id}`
  const resumo = report?.summary ?? null
  const maior = resumo ? distributionMax(resumo.distribution) : 1

  return (
    <section className="space-y-3" aria-labelledby="satisfaction-title">
      <div>
        <h2 id="satisfaction-title" className="section-heading">{t('platform.nps.title')}</h2>
        <p className="section-description">{t('platform.nps.description')}</p>
      </div>

      {error !== null && <p className="modern-card py-6 text-center text-sm text-destructive" role="alert">{error}</p>}
      {!report && error === null && (
        <p className="modern-card py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
      )}

      {report && resumo && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="modern-card p-3">
              <p className="metric-label">{t('platform.nps.score')}</p>
              <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${TOM_DO_NPS[npsTone(resumo.nps)]}`}>{formatNps(resumo.nps)}</p>
              <p className="field-hint">{t('platform.nps.responsesHint', { answered: resumo.answered, sent: resumo.sent })}</p>
            </div>
            <Numero label={t('platform.nps.promoters')} value={resumo.promoters} />
            <Numero label={t('platform.nps.passives')} value={resumo.passives} />
            <Numero label={t('platform.nps.detractors')} value={resumo.detractors}
              hint={t('platform.nps.atRiskCount', { count: report.atRisk })} />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="modern-card p-4">
              <h3 className="mb-3 text-sm font-semibold text-foreground">{t('platform.nps.distribution')}</h3>
              <ol className="flex h-32 items-end gap-1" aria-label={t('platform.nps.distribution')}>
                {NPS_SCORES.map((n) => {
                  const qtd = resumo.distribution[n] ?? 0
                  return (
                    <li key={n} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                      <span className="text-[10px] tabular-nums text-muted-foreground">{qtd || ''}</span>
                      <span
                        className={`w-full rounded-t ${COR_DA_NOTA[npsCategory(n)]}`}
                        style={{ height: `${Math.round((qtd / maior) * 80)}%`, minHeight: qtd ? 3 : 0 }}
                        aria-label={`${n}: ${qtd}`}
                      />
                      <span className="text-xs tabular-nums text-muted-foreground">{n}</span>
                    </li>
                  )
                })}
              </ol>
            </div>
            <div className="modern-card p-4">
              <h3 className="mb-2 text-sm font-semibold text-foreground">{t('platform.nps.trend')}</h3>
              <ul className="space-y-1 text-sm">
                {report.trend.filter((m) => m.responses > 0).length === 0 && (
                  <li className="py-4 text-center text-muted-foreground">{t('platform.nps.noData')}</li>
                )}
                {report.trend.filter((m) => m.responses > 0).map((mes) => (
                  <li key={mes.month} className="flex items-baseline justify-between gap-3">
                    <span className="text-muted-foreground">{monthLabel(mes.month, locale, 'long')}</span>
                    <span className="text-xs text-muted-foreground">{t('platform.nps.responsesCount', { count: mes.responses })}</span>
                    <span className={`w-12 text-right font-mono tabular-nums ${TOM_DO_NPS[npsTone(mes.nps)]}`}>{formatNps(mes.nps)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="modern-card p-4">
            <h3 className="text-sm font-semibold text-foreground">{t('platform.nps.detractorsTitle')}</h3>
            <p className="field-hint mb-2">{t('platform.nps.detractorsHint')}</p>
            {report.detractors.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{t('platform.nps.detractorsEmpty')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {report.detractors.map((d) => (
                  <li key={d.tenant.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="wrap-break-word font-medium">
                        {nomeDe(d.tenant)}
                        <span className="ms-2 font-mono tabular-nums text-[hsl(var(--status-danger))]">{d.score}</span>
                        {d.atRisk && <span className="modern-badge modern-badge-error ms-2">{t('platform.nps.atRisk')}</span>}
                      </p>
                      {d.comment && <p className="mt-0.5 text-xs wrap-break-word text-muted-foreground">{d.comment}</p>}
                      {d.signals.length > 0 && (
                        <p className="mt-1 flex flex-wrap gap-1">
                          {d.signals.map((s) => (
                            <span key={s} className="modern-badge modern-badge-warning">{t(NPS_SIGNAL_KEYS[s])}</span>
                          ))}
                        </p>
                      )}
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <p>{formatDate(d.answeredAt)} · {t(NPS_WAVE_KEYS[d.wave])}</p>
                      <a className="mt-1 inline-flex min-h-10 items-center font-semibold text-primary hover:underline lg:min-h-0" href={subscriptionHref(d.tenant)}>
                        {t('platform.nps.openSubscription')}
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="modern-card p-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">{t('platform.nps.comments')}</h3>
            {report.comments.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{t('platform.nps.commentsEmpty')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {report.comments.map((c) => (
                  <li key={c.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="min-w-0 wrap-break-word font-medium">
                        {nomeDe(c.tenant)}
                        <span className="ms-2 font-mono tabular-nums">{c.score}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{c.answeredAt ? formatDate(c.answeredAt) : '—'}</span>
                    </div>
                    <p className="mt-0.5 whitespace-pre-line wrap-break-word text-muted-foreground">{c.comment}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="modern-card p-4">
            <h3 className="text-sm font-semibold text-foreground">{t('platform.nps.sendTitle')}</h3>
            <p className="field-hint mb-2">{t('platform.nps.sendHint')}</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1 sm:max-w-sm">
                <label htmlFor={providerId} className="text-sm font-medium">{t('platform.nps.provider')}</label>
                <select id={providerId} className="modern-input w-full" value={escolhido} onChange={(e) => setEscolhido(e.target.value)}>
                  <option value="">{t('platform.nps.choose')}</option>
                  {report.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {nomeDe(p)}{p.lastAskedAt ? ` — ${t('platform.nps.lastAsked', { date: formatDate(p.lastAskedAt) })}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="modern-button" disabled={!escolhido || enviando} onClick={() => void enviar()}>
                {t('platform.nps.send')}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function Numero({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="modern-card p-3">
      <p className="metric-label">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}

export default PlatformSatisfaction
