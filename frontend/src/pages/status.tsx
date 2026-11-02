'use client'

import { useCallback, useEffect, useState } from 'react'
import { statusAPI, type PublicStatus, type StatusComponent, type StatusIncident } from '@/lib/api'
import { BrandMark } from '@/components/brand-mark'
import { useTranslation } from '@/contexts/language-context'
import {
  COMPONENT_LABEL_KEYS, IMPACT_LABEL_KEYS, INCIDENT_STATUS_LABEL_KEYS, OVERALL_LABEL_KEYS, STATE_LABEL_KEYS,
  dayTone, formatUptime, stateBadgeClass, stateTone, toneBg,
} from '@/lib/status-page'

/** De quanto em quanto tempo a página se atualiza sozinha (o servidor guarda 30 s). */
const REFRESH_MS = 60_000

/**
 * A página de status da plataforma (0127), aberta a qualquer um no endereço
 * da plataforma: se cada serviço está no ar agora, a barra de 90 dias de cada
 * um e os incidentes e manutenções como foram escritos para o público.
 *
 * Nada de dentro chega aqui — o servidor não manda erro, latência, versão nem
 * provedor —, então a página só desenha o que recebe.
 */
export default function StatusPage() {
  const { t, locale, formatDateTime } = useTranslation()
  const [dados, setDados] = useState<PublicStatus | null>(null)
  const [erro, setErro] = useState(false)

  const carregar = useCallback(async () => {
    try {
      const res = await statusAPI.public()
      if (res.success && res.data) {
        setDados(res.data)
        setErro(false)
      } else {
        setErro(true)
      }
    } catch {
      setErro(true)
    }
  }, [])

  useEffect(() => {
    void carregar()
    const timer = window.setInterval(() => { void carregar() }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [carregar])

  const nomes = (codes: string[]) => codes
    .map((c) => (c in COMPONENT_LABEL_KEYS ? t(COMPONENT_LABEL_KEYS[c as keyof typeof COMPONENT_LABEL_KEYS]) : c))
    .join(', ')

  const incidenteCard = (incidente: StatusIncident) => (
    <article key={incidente.id} className="modern-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-foreground">{incidente.title}</h3>
        <span className={incidente.status === 'resolved' ? 'modern-badge-success' : 'modern-badge-warning'}>
          {t(INCIDENT_STATUS_LABEL_KEYS[incidente.status])}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('statusPage.affects', { components: nomes(incidente.components) })}
        {incidente.kind === 'incident' && incidente.impact !== 'none' && ` · ${t(IMPACT_LABEL_KEYS[incidente.impact])}`}
      </p>
      {incidente.kind === 'maintenance' && incidente.startsAt && incidente.endsAt && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('statusPage.window', { start: formatDateTime(incidente.startsAt), end: formatDateTime(incidente.endsAt) })}
        </p>
      )}
      {incidente.updates.length > 0 && (
        <ol className="mt-3 space-y-2 border-s border-border ps-3">
          {incidente.updates.map((u, i) => (
            <li key={`${u.createdAt}-${i}`} className="text-sm">
              <span className="font-medium text-foreground">{t(INCIDENT_STATUS_LABEL_KEYS[u.status])}</span>
              {u.createdAt && <span className="ms-2 text-xs text-muted-foreground">{formatDateTime(u.createdAt)}</span>}
              <p className="mt-0.5 whitespace-pre-line leading-6 text-muted-foreground">
                {u.message || (incidente.kind === 'maintenance' && u.status === 'resolved' ? t('statusPage.maintenanceDone') : '')}
              </p>
            </li>
          ))}
        </ol>
      )}
    </article>
  )

  const componenteLinha = (componente: StatusComponent) => (
    <li key={componente.code} className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span aria-hidden="true" className={`inline-block size-2.5 rounded-full ${toneBg(stateTone(componente.status))}`} />
          {t(COMPONENT_LABEL_KEYS[componente.code])}
        </span>
        <span className={stateBadgeClass(componente.status)}>{t(STATE_LABEL_KEYS[componente.status])}</span>
      </div>
      <div className="mt-3 flex h-8 items-stretch gap-px" role="img" aria-label={componente.uptime === null
        ? t('statusPage.noData')
        : t('statusPage.uptime', { value: formatUptime(componente.uptime, locale) })}
      >
        {componente.days.map((d) => (
          <span
            key={d.date}
            title={d.uptime === null
              ? t('statusPage.dayNoData', { date: d.date })
              : t('statusPage.dayTooltip', { date: d.date, value: formatUptime(d.uptime, locale) })}
            className={`min-w-0 flex-1 rounded-sm ${toneBg(dayTone(d.uptime))}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{t('statusPage.daysAgo')}</span>
        <span>
          {componente.uptime === null
            ? t('statusPage.noData')
            : t('statusPage.uptime', { value: formatUptime(componente.uptime, locale) })}
        </span>
        <span>{t('statusPage.today')}</span>
      </div>
    </li>
  )

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <header className="text-center">
          <BrandMark className={`mx-auto size-11 ${!dados && !erro ? 'animate-pulse' : ''}`} />
          <h1 className="mt-5 text-xl font-bold text-foreground">{t('statusPage.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('statusPage.subtitle')}</p>
        </header>

        {!dados && !erro && (
          <p className="mt-8 text-center text-sm text-muted-foreground" role="status" aria-live="polite">{t('common.loading')}</p>
        )}
        {!dados && erro && (
          <p className="mt-8 text-center text-sm text-muted-foreground" role="alert">{t('statusPage.failed')}</p>
        )}

        {dados && (
          <>
            <section className="modern-card mt-8 flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5" aria-live="polite">
              <span className="flex items-center gap-3 text-base font-semibold text-foreground">
                <span aria-hidden="true" className={`inline-block size-3 rounded-full ${toneBg(stateTone(dados.status))}`} />
                {t(OVERALL_LABEL_KEYS[dados.status])}
              </span>
              <span className="text-xs text-muted-foreground">{t('statusPage.updatedAt', { date: formatDateTime(dados.updatedAt) })}</span>
            </section>

            {dados.activeIncidents.length > 0 && (
              <section className="mt-8">
                <h2 className="section-heading">{t('statusPage.active')}</h2>
                <div className="mt-3 space-y-3">
                  {dados.activeIncidents.map(incidenteCard)}
                </div>
              </section>
            )}

            {dados.scheduledMaintenance.length > 0 && (
              <section className="mt-8">
                <h2 className="section-heading">{t('statusPage.scheduled')}</h2>
                <div className="mt-3 space-y-3">
                  {dados.scheduledMaintenance.map(incidenteCard)}
                </div>
              </section>
            )}

            <section className="modern-card mt-8 px-4 sm:px-5">
              <ul className="divide-y divide-border">
                {dados.components.map(componenteLinha)}
              </ul>
            </section>

            <section className="mt-8">
              <h2 className="section-heading">{t('statusPage.history')}</h2>
              {dados.history.length === 0
                ? <p className="mt-3 text-sm text-muted-foreground">{t('statusPage.noHistory')}</p>
                : (
                  <div className="mt-3 space-y-3">
                    {dados.history.map(incidenteCard)}
                  </div>
                )}
            </section>
          </>
        )}
      </div>
    </main>
  )
}
