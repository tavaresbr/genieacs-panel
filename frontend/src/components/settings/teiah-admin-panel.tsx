import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
  teiahAPI,
  type TeiahGuards,
  type TeiahReconsultPreview,
  type TeiahReconsultResult,
  type TeiahUsage,
  type TeiahWorsened
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { usePasswordPrompt } from '@/components/ui/password-prompt'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { riskBadge } from '@/lib/teiah'
import { parseAmountToCents } from '@/lib/utils'

type Form = { monthlyLimit: string; priceCpf: string; priceAddress: string; alertWorsening: boolean }

const asText = (value: number | null) => (value === null ? '' : String(value).replace('.', ','))
/** What was typed, in reais; NaN when it is not an amount. */
const asNumber = (value: string) => {
  const cents = parseAmountToCents(value)
  return cents === null ? Number.NaN : cents / 100
}

/** The share of the limit spent, 0..100, for the bar. */
export function usageShare(usage: Pick<TeiahUsage, 'spent' | 'limit'>): number | null {
  if (usage.limit === null || usage.limit <= 0) return null
  return Math.min(100, Math.round((usage.spent / usage.limit) * 100))
}

/**
 * The admins' TeiaH controls: the monthly spending limit and the prices the
 * panel counts against it, the alert when a client's risk gets worse, the
 * reconsult of clients consulted more than 6 months ago, and the list of
 * clients whose risk went up. Everything that changes or spends asks for the
 * admin's own password; the server checks it again.
 */
export function TeiahAdminPanel() {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const passwordPrompt = usePasswordPrompt()
  const [usage, setUsage] = useState<TeiahUsage | null>(null)
  const [guards, setGuards] = useState<TeiahGuards | null>(null)
  const [form, setForm] = useState<Form>({ monthlyLimit: '', priceCpf: '', priceAddress: '', alertWorsening: false })
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<TeiahReconsultPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TeiahReconsultResult | null>(null)
  const [worsened, setWorsened] = useState<TeiahWorsened[]>([])
  const [error, setError] = useState<string | null>(null)

  const money = (value: number) => formatMoney(Math.round(value * 100), 'BRL')

  const apply = useCallback((next: { guards: TeiahGuards; usage: TeiahUsage }) => {
    setGuards(next.guards)
    setUsage(next.usage)
    setForm({
      monthlyLimit: asText(next.guards.monthlyLimit),
      priceCpf: asText(next.guards.priceCpf),
      priceAddress: asText(next.guards.priceAddress),
      alertWorsening: next.guards.alertWorsening
    })
  }, [])

  const load = useCallback(async () => {
    const [current, list] = await Promise.all([teiahAPI.getGuards(), teiahAPI.worsened()])
    if (current.success && current.data) apply(current.data)
    else setError(current.message || t('settings.teiah.admin.loadFailed'))
    if (list.success && list.data) setWorsened(list.data.items)
  }, [apply, t])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    const limit = form.monthlyLimit.trim() === '' ? null : asNumber(form.monthlyLimit)
    const priceCpf = asNumber(form.priceCpf)
    const priceAddress = asNumber(form.priceAddress)
    if ((limit !== null && !(limit >= 0)) || !(priceCpf >= 0) || !(priceAddress >= 0)) {
      setError(t('settings.teiah.admin.invalid'))
      return
    }
    const password = await passwordPrompt.ask(t('settings.teiah.admin.saveConfirm'))
    if (!password) return
    setSaving(true)
    setError(null)
    try {
      const res = await teiahAPI.updateGuards({ monthlyLimit: limit, priceCpf, priceAddress, alertWorsening: form.alertWorsening }, password)
      if (!res.success || !res.data) {
        setError(res.message || t('settings.teiah.admin.saveFailed'))
        return
      }
      apply(res.data)
      toast.success(t('settings.teiah.admin.saved'))
    } finally {
      setSaving(false)
    }
  }

  const loadPreview = async () => {
    setPreviewing(true)
    setError(null)
    setResult(null)
    try {
      const res = await teiahAPI.reconsultPreview()
      if (!res.success || !res.data) {
        setError(res.message || t('settings.teiah.admin.loadFailed'))
        return
      }
      setPreview(res.data)
    } finally {
      setPreviewing(false)
    }
  }

  const run = async () => {
    if (!preview || preview.batch === 0) return
    const password = await passwordPrompt.ask(t('settings.teiah.admin.reconsultConfirm', {
      count: preview.batch,
      cost: money(preview.estimatedCost)
    }))
    if (!password) return
    setRunning(true)
    setError(null)
    try {
      const res = await teiahAPI.reconsultRun(password)
      if (!res.success || !res.data) {
        setError(res.message || t('settings.teiah.admin.reconsultFailed'))
        return
      }
      setResult(res.data)
      setPreview(null)
      await load()
    } finally {
      setRunning(false)
    }
  }

  const share = usage ? usageShare(usage) : null

  return (
    <div className="mt-6 border-t border-border pt-5" data-testid="teiah-admin">
      <h3 className="flex items-center gap-2 font-semibold">
        <Icon name="lock" size={16} /> {t('settings.teiah.admin.title')}
      </h3>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('settings.teiah.admin.hint')}</p>
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}

      {usage && (
        <div className="mt-4 rounded-md border border-border p-3" data-testid="teiah-usage">
          <p className="metric-label">{t('settings.teiah.admin.usage', { month: `${usage.month.slice(5, 7)}/${usage.month.slice(0, 4)}` })}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {money(usage.spent)}
            {usage.limit !== null && <span className="text-sm font-normal text-muted-foreground"> / {money(usage.limit)}</span>}
            <span className="ms-2 text-sm font-normal text-muted-foreground">{t('settings.teiah.admin.usageCount', { count: usage.count })}</span>
          </p>
          {share !== null && (
            <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={`h-full ${usage.reached ? 'bg-destructive' : usage.near ? 'bg-[hsl(var(--status-warning))]' : 'bg-primary'}`}
                style={{ width: `${share}%` }}
              />
            </div>
          )}
          {usage.reached && <p className="mt-2 text-sm text-destructive">{t('settings.teiah.admin.reached')}</p>}
          {!usage.reached && usage.near && <p className="mt-2 text-sm text-[hsl(var(--status-warning))]">{t('settings.teiah.admin.near')}</p>}
          <p className="mt-2 text-xs text-muted-foreground">{t('settings.teiah.admin.usageHint')}</p>
        </div>
      )}

      {guards && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <label className="field-label" htmlFor="teiah-limit">{t('settings.teiah.admin.limit')}</label>
            <input
              id="teiah-limit"
              inputMode="decimal"
              className="modern-input w-full"
              placeholder={t('settings.teiah.admin.noLimit')}
              value={form.monthlyLimit}
              onChange={(event) => setForm((current) => ({ ...current, monthlyLimit: event.target.value }))}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="teiah-price-cpf">{t('settings.teiah.admin.priceCpf')}</label>
            <input
              id="teiah-price-cpf"
              inputMode="decimal"
              className="modern-input w-full"
              value={form.priceCpf}
              onChange={(event) => setForm((current) => ({ ...current, priceCpf: event.target.value }))}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="teiah-price-address">{t('settings.teiah.admin.priceAddress')}</label>
            <input
              id="teiah-price-address"
              inputMode="decimal"
              className="modern-input w-full"
              value={form.priceAddress}
              onChange={(event) => setForm((current) => ({ ...current, priceAddress: event.target.value }))}
            />
          </div>
          <label className="flex items-start gap-3 sm:col-span-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.alertWorsening}
              onChange={(event) => setForm((current) => ({ ...current, alertWorsening: event.target.checked }))}
            />
            <span className="text-sm">
              <span className="block font-semibold">{t('settings.teiah.admin.alert')}</span>
              <span className="text-muted-foreground">{t('settings.teiah.admin.alertHint')}</span>
            </span>
          </label>
          <div className="sm:col-span-3">
            <button type="button" className="modern-button" disabled={saving} onClick={() => void save()} data-testid="teiah-guards-save">
              <Icon name="lock" size={16} /> {t('settings.teiah.admin.save')}
            </button>
          </div>
        </div>
      )}

      <div className="mt-6">
        <p className="text-sm font-semibold">{t('settings.teiah.admin.reconsultTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('settings.teiah.admin.reconsultHint')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="modern-button-secondary" disabled={previewing || running} onClick={() => void loadPreview()} data-testid="teiah-reconsult-preview">
            <Icon name="search" size={16} /> {t('settings.teiah.admin.reconsultPreview')}
          </button>
          {preview && preview.batch > 0 && (
            <button type="button" className="modern-button" disabled={running} onClick={() => void run()} data-testid="teiah-reconsult-run">
              <Icon name="refresh" size={16} className={running ? 'animate-spin' : ''} /> {t('settings.teiah.admin.reconsultRun', { count: preview.batch })}
            </button>
          )}
        </div>
        {preview && (
          <div className="mt-2 text-sm" data-testid="teiah-reconsult-summary">
            {preview.count === 0
              ? <p className="text-muted-foreground">{t('settings.teiah.admin.reconsultNone')}</p>
              : (
                <>
                  <p>{t('settings.teiah.admin.reconsultEstimate', { count: preview.count, batch: preview.batch, cost: money(preview.estimatedCost) })}</p>
                  {preview.usage.limit !== null && preview.usage.spent + preview.estimatedCost > preview.usage.limit && (
                    <p className="mt-1 text-[hsl(var(--status-warning))]">{t('settings.teiah.admin.reconsultOverLimit')}</p>
                  )}
                  <ul className="mt-1 list-disc ps-5 text-muted-foreground">
                    {preview.sample.map((item) => (
                      <li key={item.key}>{item.name ?? item.key} · {formatDateTime(item.consultedAt)}</li>
                    ))}
                  </ul>
                </>
              )}
          </div>
        )}
        {result && (
          <p className="mt-2 text-sm" role="status" data-testid="teiah-reconsult-result">
            {t('settings.teiah.admin.reconsultDone', { processed: result.processed, failed: result.failed, worsened: result.worsened.length, remaining: result.remaining })}
            {result.stoppedByLimit && <span className="block text-destructive">{t('settings.teiah.admin.reconsultStopped')}</span>}
          </p>
        )}
      </div>

      <div className="mt-6">
        <p className="text-sm font-semibold">{t('settings.teiah.admin.worsenedTitle')}</p>
        {worsened.length === 0
          ? <p className="mt-1 text-sm text-muted-foreground">{t('settings.teiah.admin.worsenedNone')}</p>
          : (
            <table className="mt-1 w-full text-sm" data-testid="teiah-worsened">
              <tbody>
                {worsened.map((item, index) => (
                  <tr key={`${item.key}-${index}`} className="border-t border-border">
                    <td className="py-1 pe-2 wrap-anywhere">
                      <Link className="text-primary hover:underline" to={`/contacts/${encodeURIComponent(item.key)}`}>{item.name ?? item.key}</Link>
                    </td>
                    <td className="py-1 pe-2 whitespace-nowrap">
                      <span className={riskBadge(item.from)}>{item.from ?? '—'}</span>
                      {' → '}
                      <span className={riskBadge(item.to)}>{item.to ?? '—'}</span>
                    </td>
                    <td className="py-1 pe-2 tabular-nums">{item.score ?? '—'}</td>
                    <td className="py-1 text-muted-foreground whitespace-nowrap">{formatDateTime(item.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {passwordPrompt.element}
    </div>
  )
}
