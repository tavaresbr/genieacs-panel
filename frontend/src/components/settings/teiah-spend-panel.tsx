import { useState } from 'react'
import { teiahAPI, type TeiahConsultationSummary, type TeiahSpendGroup } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { usePasswordPrompt } from '@/components/ui/password-prompt'

const today = () => new Date().toISOString().slice(0, 10)
const monthStart = () => `${today().slice(0, 7)}-01`

/**
 * "Consultas e gasto": what the TeiaH consultations cost, read from the TeiaH
 * history of the provider's key — the panel's and the site's alike — over a
 * period, by month, kind and user. Nothing is kept: each "Carregar" asks again.
 */
export function TeiahSpendPanel() {
  const { t, formatDateTime } = useTranslation()
  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(today)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<TeiahConsultationSummary | null>(null)
  const [exporting, setExporting] = useState(false)
  const passwordPrompt = usePasswordPrompt()

  const money = (value: number) => formatMoney(Math.round(value * 100), 'BRL')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await teiahAPI.consultationSummary(from, to)
      if (!res.success || !res.data) {
        setError(res.message || t('settings.teiah.spend.failed'))
        return
      }
      setSummary(res.data)
    } catch {
      setError(t('settings.teiah.spend.failed'))
    } finally {
      setLoading(false)
    }
  }

  /** The period's consultations as a CSV sheet: admin only, confirmed with the password. */
  const exportCsv = async () => {
    const password = await passwordPrompt.ask(t('settings.teiah.spend.exportConfirm'))
    if (!password) return
    setExporting(true)
    setError(null)
    try {
      const res = await teiahAPI.exportSpend(from, to, password)
      if (!res.success || !res.blob) {
        setError(res.message || t('settings.teiah.spend.failed'))
        return
      }
      const url = URL.createObjectURL(res.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = res.filename || `teiah-gastos-${from}-a-${to}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  const table = (title: string, rows: TeiahSpendGroup[], keyLabel: (key: string) => string) => (
    <div className="min-w-0">
      <p className="mb-1 text-sm font-semibold">{title}</p>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border">
              <td className="py-1 pe-2 wrap-anywhere">{keyLabel(row.key)}</td>
              <td className="py-1 pe-2 text-end tabular-nums">{row.count}</td>
              {summary?.costKnown && <td className="py-1 text-end tabular-nums">{money(row.cost)}</td>}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td className="py-1 text-muted-foreground">—</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )

  const monthLabel = (key: string) => {
    const match = key.match(/^(\d{4})-(\d{2})$/)
    return match ? `${match[2]}/${match[1]}` : key
  }

  return (
    <div className="mt-6 border-t border-border pt-5" data-testid="teiah-spend">
      <h3 className="font-semibold">{t('settings.teiah.spend.title')}</h3>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('settings.teiah.spend.hint')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="field-label" htmlFor="teiah-spend-from">{t('settings.teiah.spend.from')}</label>
          <input id="teiah-spend-from" type="date" className="modern-input" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="teiah-spend-to">{t('settings.teiah.spend.to')}</label>
          <input id="teiah-spend-to" type="date" className="modern-input" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
        </div>
        <button type="button" className="modern-button-secondary" disabled={loading || !from || !to} onClick={() => void load()} data-testid="teiah-spend-load">
          <Icon name="refresh" size={16} className={loading ? 'animate-spin' : ''} /> {t('settings.teiah.spend.load')}
        </button>
        <button type="button" className="modern-button-secondary" disabled={exporting || !from || !to} onClick={() => void exportCsv()} data-testid="teiah-spend-export">
          <Icon name="document" size={16} /> {t('settings.teiah.spend.export')}
        </button>
      </div>
      {passwordPrompt.element}
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      {summary && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <p className="metric-label">{t('settings.teiah.spend.total')}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{summary.total}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="metric-label">{t('settings.teiah.spend.cost')}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{summary.costKnown ? money(summary.totalCost) : '—'}</p>
              {!summary.costKnown && <p className="mt-1 text-xs text-muted-foreground">{t('settings.teiah.spend.noCost')}</p>}
            </div>
          </div>
          {summary.truncated && <p className="text-xs text-[hsl(var(--status-warning))]">{t('settings.teiah.spend.truncated')}</p>}
          <div className="grid gap-4 sm:grid-cols-3">
            {table(t('settings.teiah.spend.byMonth'), summary.byMonth, monthLabel)}
            {table(t('settings.teiah.spend.byType'), summary.byType, (key) => key)}
            {table(t('settings.teiah.spend.byUser'), summary.byUser, (key) => key)}
          </div>
          {summary.recent.length > 0 && (
            <div className="overflow-x-auto">
              <p className="mb-1 text-sm font-semibold">{t('settings.teiah.spend.recent')}</p>
              <table className="w-full text-sm">
                <tbody>
                  {summary.recent.map((item, index) => (
                    <tr key={index} className="border-t border-border">
                      <td className="py-1 pe-2 whitespace-nowrap">{item.createdAt ? formatDateTime(item.createdAt) : '—'}</td>
                      <td className="py-1 pe-2">{item.type ?? '—'}{item.origin ? ` · ${item.origin}` : ''}</td>
                      <td className="py-1 pe-2 wrap-anywhere">{item.userName ?? '—'}</td>
                      <td className="py-1 pe-2 text-muted-foreground">{item.status ?? ''}</td>
                      <td className="py-1 text-end tabular-nums">{item.cost !== null ? money(item.cost) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
