'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  PLATFORM_ALERT_STATUSES,
  platformAlertHistoryAPI,
  type PlatformAlertHistoryItem,
  type PlatformAlertHistoryPage,
  type PlatformAlertStatus
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { displayDateTime } from '@/lib/date-format'
import {
  ALERT_STATUS_BADGE,
  ALERT_STATUS_LABELS,
  EMPTY_HISTORY_FILTERS,
  HISTORY_EVENTS,
  buildHistoryQuery,
  canResend,
  historyErrorKey,
  historyEventLabel,
  pageCount,
  type HistoryFilters
} from '@/lib/platform-alert-history'

const POR_PAGINA = 25

function quando(valor: string | null) {
  if (!valor) return '—'
  return displayDateTime(valor) ?? '—'
}

/**
 * Configurações → Alertas → Histórico: a fila de alertas da plataforma como
 * ela está — o que saiu, o que falhou, o que foi pulado e por quê —, com o
 * "Reenviar" do que falhou ou foi pulado. Paginada por número de página: a
 * fila cresce pela frente, mas quem procura um alerta filtra por dia e estado.
 */
export function PlatformAlertHistory() {
  const { t } = useTranslation()
  const toast = useToast()
  const [filtros, setFiltros] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS)
  const [pagina, setPagina] = useState(1)
  const [dados, setDados] = useState<PlatformAlertHistoryPage | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [reenviando, setReenviando] = useState<number | null>(null)

  const carregar = useCallback(async () => {
    setCarregando(true)
    try {
      const res = await platformAlertHistoryAPI.list(buildHistoryQuery(filtros, pagina, POR_PAGINA))
      if (res.success && res.data) {
        setDados(res.data)
        setErro(null)
      } else {
        setErro(t(historyErrorKey(res.code)))
      }
    } catch {
      setErro(t('platform.alertHistory.loadFailed'))
    }
    setCarregando(false)
  }, [filtros, pagina, t])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const filtrar = (patch: Partial<HistoryFilters>) => {
    setFiltros((f) => ({ ...f, ...patch }))
    setPagina(1)
  }

  const reenviar = async (item: PlatformAlertHistoryItem) => {
    if (!window.confirm(t('platform.alertHistory.resendConfirm'))) return
    setReenviando(item.id)
    try {
      const res = await platformAlertHistoryAPI.resend(item.id)
      if (res.success && res.data) {
        toast.success(res.data.requeued > 0
          ? t('platform.alertHistory.resentDigest', { count: res.data.requeued })
          : t('platform.alertHistory.resent'))
      } else {
        toast.error(res.code ? t(historyErrorKey(res.code)) : t('platform.alertHistory.resendFailed'))
      }
    } catch {
      toast.error(t('platform.alertHistory.resendFailed'))
    }
    setReenviando(null)
    await carregar()
  }

  const paginas = pageCount(dados?.total ?? 0, POR_PAGINA)
  const alertas = dados?.alerts ?? []

  const provedor = (item: PlatformAlertHistoryItem) => {
    if (!item.tenant) return <span className="text-muted-foreground">{t('platform.alertHistory.platformBox')}</span>
    return (
      <>
        {item.tenant.name || item.tenant.slug || '—'}
        {item.tenant.slug && item.tenant.name && (
          <span className="ms-1 text-xs text-muted-foreground">({item.tenant.slug})</span>
        )}
      </>
    )
  }

  const estado = (status: PlatformAlertStatus) => (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${ALERT_STATUS_BADGE[status]}`}>
      {t(ALERT_STATUS_LABELS[status])}
    </span>
  )

  const botao = (item: PlatformAlertHistoryItem) => (canResend(item) ? (
    <button
      type="button"
      className="modern-button-secondary px-3 py-1 text-xs"
      disabled={reenviando !== null}
      onClick={() => void reenviar(item)}
    >
      {reenviando === item.id ? t('common.loading') : t('platform.alertHistory.resend')}
    </button>
  ) : null)

  return (
    <section className="rounded-md border border-border p-4">
      <div>
        <h2 className="font-semibold text-foreground">{t('platform.alertHistory.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.alertHistory.description')}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={t('platform.alertHistory.filters.status')}>
        <button
          type="button"
          aria-pressed={filtros.status === ''}
          onClick={() => filtrar({ status: '' })}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${filtros.status === '' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
        >
          {t('platform.alertHistory.filters.all')}
        </button>
        {PLATFORM_ALERT_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filtros.status === s}
            onClick={() => filtrar({ status: s })}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${filtros.status === s ? 'bg-primary text-primary-foreground' : ALERT_STATUS_BADGE[s]}`}
          >
            {t(ALERT_STATUS_LABELS[s])} ({dados?.counts[s] ?? 0})
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{t('platform.alertHistory.filters.event')}</span>
          <select
            className="modern-input w-full min-w-0"
            value={filtros.event}
            onChange={(e) => filtrar({ event: e.target.value as HistoryFilters['event'] })}
          >
            <option value="">{t('platform.alertHistory.filters.all')}</option>
            {HISTORY_EVENTS.map((ev) => (
              <option key={ev} value={ev}>{t(historyEventLabel(ev))}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{t('platform.alertHistory.filters.from')}</span>
          <input type="date" className="modern-input" value={filtros.from} onChange={(e) => filtrar({ from: e.target.value })} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{t('platform.alertHistory.filters.to')}</span>
          <input type="date" className="modern-input" value={filtros.to} onChange={(e) => filtrar({ to: e.target.value })} />
        </label>
        <button type="button" className="modern-button-secondary" onClick={() => { setFiltros(EMPTY_HISTORY_FILTERS); setPagina(1) }}>
          {t('platform.alertHistory.filters.clear')}
        </button>
      </div>

      {erro !== null && <p className="mt-4 text-sm text-destructive">{erro}</p>}

      {carregando && !dados ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : alertas.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('platform.alertHistory.empty')}</p>
      ) : (
        <>
          <ul className="mobile-card-list mt-4 divide-y divide-border border-t border-border">
            {alertas.map((item) => (
              <li key={item.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="font-semibold">{t(historyEventLabel(item.event))}</span>
                  {estado(item.status)}
                </div>
                <p className="mt-1 wrap-break-word">{item.summary}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {provedor(item)}{' · '}{quando(item.createdAt)}
                  {' · '}{t('platform.alertHistory.cols.attempts')}: {item.attempts}
                </p>
                {item.lastError && (
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.lastError}</p>
                )}
                {canResend(item) && <div className="mt-2">{botao(item)}</div>}
              </li>
            ))}
          </ul>
          <div className="desktop-table mt-4 overflow-x-auto">
            <table className="w-full min-w-176 text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pe-3 font-medium">{t('platform.alertHistory.cols.when')}</th>
                  <th className="py-2 pe-3 font-medium">{t('platform.alertHistory.cols.event')}</th>
                  <th className="py-2 pe-3 font-medium">{t('platform.alertHistory.cols.provider')}</th>
                  <th className="py-2 pe-3 font-medium">{t('platform.alertHistory.cols.summary')}</th>
                  <th className="py-2 pe-3 font-medium">{t('platform.alertHistory.cols.status')}</th>
                  <th className="py-2 pe-3 font-medium">{t('platform.alertHistory.cols.attempts')}</th>
                  <th className="py-2 pe-3 font-medium">{t('platform.alertHistory.cols.error')}</th>
                  <th className="py-2 pe-3 font-medium">{t('platform.alertHistory.cols.sentAt')}</th>
                  <th className="py-2 font-medium"><span className="sr-only">{t('platform.alertHistory.resend')}</span></th>
                </tr>
              </thead>
              <tbody>
                {alertas.map((item) => (
                  <tr key={item.id} className="border-t border-border align-top">
                    <td className="whitespace-nowrap py-2 pe-3 text-muted-foreground">{quando(item.createdAt)}</td>
                    <td className="py-2 pe-3">{t(historyEventLabel(item.event))}</td>
                    <td className="py-2 pe-3">{provedor(item)}</td>
                    <td className="py-2 pe-3 wrap-break-word">{item.summary}</td>
                    <td className="py-2 pe-3">{estado(item.status)}</td>
                    <td className="py-2 pe-3">{item.attempts}</td>
                    <td className="py-2 pe-3 break-all font-mono text-xs text-muted-foreground">{item.lastError || '—'}</td>
                    <td className="whitespace-nowrap py-2 pe-3 text-muted-foreground">
                      {item.status === 'pending' && item.nextAttemptAt
                        ? <span title={t('platform.alertHistory.cols.nextAttempt')}>{quando(item.nextAttemptAt)}</span>
                        : quando(item.sentAt)}
                    </td>
                    <td className="py-2">{botao(item)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          className="modern-button-secondary"
          disabled={carregando || pagina <= 1}
          onClick={() => setPagina((p) => Math.max(1, p - 1))}
        >
          {t('platform.alertHistory.prev')}
        </button>
        <span className="text-muted-foreground">{t('platform.alertHistory.page', { page: pagina, pages: paginas })}</span>
        <button
          type="button"
          className="modern-button-secondary"
          disabled={carregando || pagina >= paginas}
          onClick={() => setPagina((p) => p + 1)}
        >
          {t('platform.alertHistory.next')}
        </button>
      </div>
    </section>
  )
}

/**
 * Configurações → Alertas: a configuração e o histórico, lado a lado em duas
 * abas no topo do painel.
 */
export function PlatformAlertsPanel({ settings }: { settings: ReactNode }) {
  const { t } = useTranslation()
  const [aba, setAba] = useState<'settings' | 'history'>('settings')
  return (
    <div className="grid gap-4">
      <div className="flex gap-2" role="tablist" aria-label={t('platform.settings.alerts')}>
        {([
          ['settings', 'platform.alertHistory.tabSettings'],
          ['history', 'platform.alertHistory.tabHistory']
        ] as const).map(([chave, rotulo]) => (
          <button
            key={chave}
            type="button"
            role="tab"
            aria-selected={aba === chave}
            onClick={() => setAba(chave)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${aba === chave
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            {t(rotulo)}
          </button>
        ))}
      </div>
      {aba === 'settings' ? settings : <PlatformAlertHistory />}
    </div>
  )
}

export default PlatformAlertHistory
