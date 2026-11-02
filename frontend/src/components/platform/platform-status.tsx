'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import {
  statusAPI, type ConsoleStatus, type StatusComponentCode, type StatusIncident, type StatusIncidentImpact,
  type StatusIncidentKind, type StatusIncidentStatus,
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import {
  COMPONENT_LABEL_KEYS, IMPACT_LABEL_KEYS, INCIDENT_STATUS_LABEL_KEYS, OVERALL_LABEL_KEYS, STATE_LABEL_KEYS,
  STATUS_COMPONENT_CODES, STATUS_IMPACTS, formatUptime, localInputToIso, nextStatuses, stateBadgeClass,
  stateTone, toneBg,
} from '@/lib/status-page'

interface Formulario {
  kind: StatusIncidentKind
  title: string
  message: string
  components: StatusComponentCode[]
  impact: StatusIncidentImpact
  startsAt: string
  endsAt: string
  notifyProviders: boolean
}

const VAZIO: Formulario = {
  kind: 'incident', title: '', message: '', components: [], impact: 'minor', startsAt: '', endsAt: '', notifyProviders: false,
}

/** O erro do servidor como frase; o código desconhecido cai no genérico. */
const ERRO_KEYS = {
  invalid_title: 'platform.status.invalidTitle',
  invalid_message: 'platform.status.invalidMessage',
  invalid_components: 'platform.status.invalidComponents',
  invalid_window: 'platform.status.invalidWindow',
  already_resolved: 'platform.status.alreadyResolved',
} as const

/**
 * A aba Status do console (0127): as verificações automáticas de cada
 * componente, com o detalhe que a página pública não mostra, e os incidentes e
 * manutenções — abrir, publicar atualização, resolver, ligar o aviso aos
 * provedores. Cada gesto vai para a trilha da plataforma no servidor.
 */
export function PlatformStatus() {
  const { t, locale, formatDateTime } = useTranslation()
  const toast = useToast()
  const formId = useId()
  const [dados, setDados] = useState<ConsoleStatus | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [verificando, setVerificando] = useState(false)
  const [form, setForm] = useState<Formulario | null>(null)
  const [salvando, setSalvando] = useState(false)
  const [rascunhos, setRascunhos] = useState<Record<number, { status: StatusIncidentStatus; message: string }>>({})

  const carregar = useCallback(async () => {
    const res = await statusAPI.overview().catch(() => null)
    if (res?.success && res.data) {
      setDados(res.data)
      setErro(null)
    } else {
      setErro(res?.message || t('platform.status.loadFailed'))
    }
  }, [t])

  useEffect(() => { void carregar() }, [carregar])

  const mensagemDeErro = (code: string | undefined, fallback?: string) => (
    code && code in ERRO_KEYS ? t(ERRO_KEYS[code as keyof typeof ERRO_KEYS]) : (fallback || t('platform.status.failed'))
  )

  const verificarAgora = async () => {
    setVerificando(true)
    try {
      const res = await statusAPI.runChecks()
      if (res.success && res.data) setDados(res.data)
      else toast.error(res.message || t('platform.status.failed'))
    } finally {
      setVerificando(false)
    }
  }

  const publicar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form) return
    setSalvando(true)
    try {
      const res = await statusAPI.create({
        kind: form.kind,
        title: form.title.trim(),
        message: form.message.trim(),
        components: form.components,
        impact: form.impact,
        notifyProviders: form.notifyProviders,
        ...(form.kind === 'maintenance'
          ? { startsAt: localInputToIso(form.startsAt), endsAt: localInputToIso(form.endsAt) }
          : {}),
      })
      if (res.success) {
        toast.success(t('platform.status.created'))
        setForm(null)
        await carregar()
      } else {
        toast.error(mensagemDeErro(res.code, res.message))
      }
    } finally {
      setSalvando(false)
    }
  }

  const postar = async (incidente: StatusIncident, status: StatusIncidentStatus) => {
    const rascunho = rascunhos[incidente.id]
    const message = (rascunho?.message ?? '').trim()
    if (!message) { toast.error(t('platform.status.invalidMessage')); return }
    setSalvando(true)
    try {
      const res = await statusAPI.postUpdate(incidente.id, { status, message })
      if (res.success) {
        toast.success(t('platform.status.updatePosted'))
        setRascunhos((r) => { const { [incidente.id]: _, ...resto } = r; return resto })
        await carregar()
      } else {
        toast.error(mensagemDeErro(res.code, res.message))
      }
    } finally {
      setSalvando(false)
    }
  }

  const alternarAviso = async (incidente: StatusIncident) => {
    setSalvando(true)
    try {
      const res = await statusAPI.update(incidente.id, { notifyProviders: !incidente.notifyProviders })
      if (res.success) await carregar()
      else toast.error(mensagemDeErro(res.code, res.message))
    } finally {
      setSalvando(false)
    }
  }

  const abrirForm = (kind: StatusIncidentKind) => setForm({ ...VAZIO, kind, impact: kind === 'maintenance' ? 'none' : 'minor' })

  const nomes = (codes: StatusComponentCode[]) => codes.map((c) => t(COMPONENT_LABEL_KEYS[c])).join(', ')

  if (!dados) {
    return erro
      ? <p className="text-sm text-destructive" role="alert">{erro}</p>
      : <p className="text-sm text-muted-foreground" role="status">{t('common.loading')}</p>
  }

  return (
    <div className="space-y-6">
      <section className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-heading">{t('platform.status.title')}</h2>
            <p className="field-hint mt-1">{t('platform.status.hint')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a className="modern-button-secondary" href="/status" target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={16} />
              {t('platform.status.openPublic')}
            </a>
            <button type="button" className="modern-button-secondary" disabled={verificando} onClick={() => void verificarAgora()}>
              <Icon name="refresh" size={16} className={verificando ? 'animate-spin' : ''} />
              {t('platform.status.runChecks')}
            </button>
          </div>
        </div>
        <p className="mt-4 flex items-center gap-2 text-sm font-semibold text-foreground">
          <span aria-hidden="true" className={`inline-block size-2.5 rounded-full ${toneBg(stateTone(dados.status))}`} />
          {t(OVERALL_LABEL_KEYS[dados.status])}
        </p>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {dados.components.map((c) => {
            const ultima = c.checks?.[0]
            return (
              <li key={c.code} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{t(COMPONENT_LABEL_KEYS[c.code])}</span>
                  <span className={stateBadgeClass(c.status)}>{t(STATE_LABEL_KEYS[c.status])}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.uptime === null ? t('statusPage.noData') : t('statusPage.uptime', { value: formatUptime(c.uptime, locale) })}
                </p>
                {ultima ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('platform.status.lastCheck', { time: ultima.checkedAt ? formatDateTime(ultima.checkedAt) : '—' })}
                    {ultima.latencyMs !== null && ` · ${t('platform.status.latency', { ms: ultima.latencyMs })}`}
                    {ultima.detail && <span className="ms-1 font-mono">· {ultima.detail}</span>}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">{t('platform.status.noChecks')}</p>
                )}
                {c.checks && c.checks.length > 0 && (
                  <div className="mt-2 flex gap-0.5" aria-hidden="true">
                    {[...c.checks].reverse().map((k, i) => (
                      <span key={`${k.checkedAt}-${i}`} className={`h-3 w-2 rounded-sm ${toneBg(k.ok ? 'good' : 'bad')}`} title={k.checkedAt ?? ''} />
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-heading">{t('platform.status.incidents')}</h2>
          {!form && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="modern-button" onClick={() => abrirForm('incident')}>
                {t('platform.status.newIncident')}
              </button>
              <button type="button" className="modern-button-secondary" onClick={() => abrirForm('maintenance')}>
                {t('platform.status.newMaintenance')}
              </button>
            </div>
          )}
        </div>

        {form && (
          <form className="mt-4 space-y-4 rounded-md border border-border p-4" onSubmit={(e) => void publicar(e)}>
            <p className="text-sm font-semibold text-foreground">
              {t(form.kind === 'maintenance' ? 'platform.status.newMaintenance' : 'platform.status.newIncident')}
            </p>
            <div className="space-y-1">
              <label htmlFor={`${formId}-title`} className="text-sm font-medium">{t('platform.status.form.title')}</label>
              <input
                id={`${formId}-title`}
                className="modern-input w-full"
                maxLength={160}
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{t('platform.status.form.components')}</legend>
              <div className="flex flex-wrap gap-3">
                {STATUS_COMPONENT_CODES.map((c) => (
                  <label key={c} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.components.includes(c)}
                      onChange={(e) => setForm({
                        ...form,
                        components: e.target.checked ? [...form.components, c] : form.components.filter((x) => x !== c),
                      })}
                    />
                    {t(COMPONENT_LABEL_KEYS[c])}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={`${formId}-impact`} className="text-sm font-medium">{t('platform.status.form.impact')}</label>
                <select
                  id={`${formId}-impact`}
                  className="modern-input w-full"
                  value={form.impact}
                  onChange={(e) => setForm({ ...form, impact: e.target.value as StatusIncidentImpact })}
                >
                  {STATUS_IMPACTS.map((i) => <option key={i} value={i}>{t(IMPACT_LABEL_KEYS[i])}</option>)}
                </select>
              </div>
            </div>
            {form.kind === 'maintenance' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor={`${formId}-start`} className="text-sm font-medium">{t('platform.status.form.startsAt')}</label>
                  <input
                    id={`${formId}-start`}
                    type="datetime-local"
                    className="modern-input w-full"
                    value={form.startsAt}
                    onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${formId}-end`} className="text-sm font-medium">{t('platform.status.form.endsAt')}</label>
                  <input
                    id={`${formId}-end`}
                    type="datetime-local"
                    className="modern-input w-full"
                    value={form.endsAt}
                    onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                  />
                </div>
              </div>
            )}
            <div className="space-y-1">
              <label htmlFor={`${formId}-message`} className="text-sm font-medium">{t('platform.status.form.message')}</label>
              <textarea
                id={`${formId}-message`}
                className="modern-input min-h-24 w-full"
                maxLength={2000}
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={form.notifyProviders}
                onChange={(e) => setForm({ ...form, notifyProviders: e.target.checked })}
              />
              <span>
                {t('platform.status.form.notify')}
                <span className="field-hint block">{t('platform.status.form.notifyHint')}</span>
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="modern-button" disabled={salvando}>{t('platform.status.form.submit')}</button>
              <button type="button" className="modern-button-secondary" onClick={() => setForm(null)}>{t('common.cancel')}</button>
            </div>
          </form>
        )}

        {dados.incidents.length === 0 && !form && (
          <p className="mt-4 text-sm text-muted-foreground">{t('platform.status.empty')}</p>
        )}

        <ul className="mt-4 space-y-4">
          {dados.incidents.map((i) => {
            const aberto = i.status !== 'resolved'
            const rascunho = rascunhos[i.id] ?? { status: i.status, message: '' }
            const avisados = Object.values(i.notified ?? {}).reduce((a, b) => a + (b ?? 0), 0)
            return (
              <li key={i.id} className="rounded-md border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{i.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(i.kind === 'maintenance' ? 'platform.status.kindMaintenance' : 'platform.status.kindIncident')}
                      {' · '}{nomes(i.components)}
                      {' · '}{t(IMPACT_LABEL_KEYS[i.impact])}
                      {i.kind === 'maintenance' && i.startsAt && i.endsAt
                        && ` · ${t('statusPage.window', { start: formatDateTime(i.startsAt), end: formatDateTime(i.endsAt) })}`}
                    </p>
                  </div>
                  <span className={aberto ? 'modern-badge-warning' : 'modern-badge-success'}>{t(INCIDENT_STATUS_LABEL_KEYS[i.status])}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{t(i.notifyProviders ? 'platform.status.notifyOn' : 'platform.status.notifyOff')}</span>
                  {avisados > 0 && <span>· {t('platform.status.notified', { count: avisados })}</span>}
                  {aberto && (
                    <button type="button" className="modern-button-secondary min-h-8 px-2 py-1 text-xs" disabled={salvando} onClick={() => void alternarAviso(i)}>
                      {t(i.notifyProviders ? 'platform.status.disableNotify' : 'platform.status.enableNotify')}
                    </button>
                  )}
                </div>
                {i.updates.length > 0 && (
                  <ol className="mt-3 space-y-1 border-s border-border ps-3 text-sm">
                    {i.updates.map((u, n) => (
                      <li key={`${u.createdAt}-${n}`}>
                        <span className="font-medium">{t(INCIDENT_STATUS_LABEL_KEYS[u.status])}</span>
                        {u.createdAt && <span className="ms-2 text-xs text-muted-foreground">{formatDateTime(u.createdAt)}</span>}
                        <p className="whitespace-pre-line text-muted-foreground">
                          {u.message || (i.kind === 'maintenance' && u.status === 'resolved' ? t('statusPage.maintenanceDone') : '')}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
                {aberto && (
                  <div className="mt-3 space-y-2">
                    <textarea
                      aria-label={t('platform.status.form.message')}
                      className="modern-input min-h-16 w-full"
                      maxLength={2000}
                      value={rascunho.message}
                      onChange={(e) => setRascunhos((r) => ({ ...r, [i.id]: { ...rascunho, message: e.target.value } }))}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={t('platform.status.form.status')}
                        className="modern-input"
                        value={rascunho.status}
                        onChange={(e) => setRascunhos((r) => ({ ...r, [i.id]: { ...rascunho, status: e.target.value as StatusIncidentStatus } }))}
                      >
                        {nextStatuses(i.kind).filter((s) => s !== 'resolved').map((s) => (
                          <option key={s} value={s}>{t(INCIDENT_STATUS_LABEL_KEYS[s])}</option>
                        ))}
                      </select>
                      <button type="button" className="modern-button-secondary" disabled={salvando} onClick={() => void postar(i, rascunho.status)}>
                        {t('platform.status.postUpdate')}
                      </button>
                      <button type="button" className="modern-button" disabled={salvando} onClick={() => void postar(i, 'resolved')}>
                        {t('platform.status.resolve')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
