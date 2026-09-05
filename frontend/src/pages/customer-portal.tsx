import { FormEvent, useCallback, useEffect, useState } from 'react'
import { BrandMark } from '@/components/brand-mark'
import { Icon } from '@/components/ui/icon'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'
import { getActiveLocale, translate } from '@/lib/i18n'

type PortalOverview = {
  customerId: string
  status: 'online' | 'offline'
  lastInform: string | null
  lastBoot: string | null
  registered: string | null
  ont: {
    manufacturer: unknown
    model: unknown
    serialNumber: unknown
    hardwareVersion: unknown
    softwareVersion: unknown
    uptimeSeconds: unknown
  }
  optical: { rxPower: unknown; temperature: unknown }
  connectedDevices: unknown
  wifi: Array<{
    index: number
    ssid: unknown
    enabled: boolean | null
    connectedDevices: unknown
    hasSavedPassword?: boolean
  }>
  generatedAt: string
}

type ApiResult<T> = { success: boolean; message?: string; data?: T }
type WifiEditor = { index: number; ssid: string; password: string }

async function portalRequest<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const response = await fetch(`/api/customer${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json')
    ? await response.json()
    : { success: false, message: translate(getActiveLocale(), 'portal.invalidResponse') }
  if (!response.ok) return { ...result, success: false }
  return result
}

function MetricCard({
  icon, label, value, helper
}: {
  icon: string
  label: string
  value: string
  helper?: string
}) {
  return (
    <article className="modern-card p-4 sm:p-5">
      <div className="mb-5 flex items-center justify-between">
        <p className="metric-label">{label}</p>
        <span className="rounded-md bg-secondary p-2 text-primary"><Icon name={icon} size={18} /></span>
      </div>
      <p className="break-words text-xl font-bold tracking-tight">{value}</p>
      {helper && <p className="mt-1 text-xs text-muted-foreground">{helper}</p>}
    </article>
  )
}

export default function CustomerPortal() {
  const { t, formatDateTime } = useTranslation()
  const [checkingSession, setCheckingSession] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [customerId, setCustomerId] = useState('')
  const [password, setPassword] = useState('')
  const [showLoginPassword, setShowLoginPassword] = useState(false)
  const [overview, setOverview] = useState<PortalOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [wifiEditor, setWifiEditor] = useState<WifiEditor | null>(null)
  const [wifiSaving, setWifiSaving] = useState(false)
  const [showWifiPassword, setShowWifiPassword] = useState(false)
  const [visibleSavedPasswordIndex, setVisibleSavedPasswordIndex] = useState<number | null>(null)
  const [revealedWifiPasswords, setRevealedWifiPasswords] = useState<Record<number, string>>({})
  const [revealingWifiPasswordIndex, setRevealingWifiPasswordIndex] = useState<number | null>(null)
  const [wifiFeedback, setWifiFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  const notReported = t('portal.notReported')

  /** Values arrive from the ONT as unknown JSON, so anything unusable reads as "not reported". */
  const text = (value: unknown) => {
    if (value === null || value === undefined || value === '') return notReported
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    return notReported
  }

  const dateTime = (value: string | null) => {
    if (!value) return notReported
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? notReported
      : formatDateTime(date, { dateStyle: 'medium', timeStyle: 'short' })
  }

  const uptime = (value: unknown) => {
    const seconds = Number(value)
    if (!Number.isFinite(seconds) || seconds < 0) return notReported
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return [
      days ? t('portal.uptime.days', { count: days }) : '',
      hours ? t('portal.uptime.hours', { count: hours }) : '',
      t('portal.uptime.minutes', { count: minutes }),
    ].filter(Boolean).join(' ')
  }

  const loadOverview = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await portalRequest<PortalOverview>('/overview')
      if (!result.success || !result.data) {
        if (result.message?.toLowerCase().includes('session')) setAuthenticated(false)
        setError(result.message || t('portal.error.overview'))
        return
      }
      setOverview(result.data)
    } catch {
      setError(t('portal.error.unreachable'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    let cancelled = false
    void portalRequest<{ customerId: string }>('/session')
      .then((result) => {
        if (cancelled) return
        setAuthenticated(result.success)
        if (result.success) void loadOverview()
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false)
      })
    return () => { cancelled = true }
  }, [loadOverview])

  useEffect(() => {
    if (!authenticated) return
    const timer = window.setInterval(() => void loadOverview(), 60_000)
    return () => window.clearInterval(timer)
  }, [authenticated, loadOverview])

  useEffect(() => {
    if (authenticated) return
    setOverview(null)
    setWifiEditor(null)
    setShowWifiPassword(false)
    setVisibleSavedPasswordIndex(null)
    setRevealedWifiPasswords({})
    setRevealingWifiPasswordIndex(null)
    setWifiFeedback(null)
  }, [authenticated])

  const login = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const result = await portalRequest<{ customerId: string }>('/login', {
        method: 'POST',
        body: JSON.stringify({ customerId, password }),
      })
      if (!result.success) {
        setError(result.message || t('portal.login.invalidCredentials'))
        return
      }
      setAuthenticated(true)
      setPassword('')
      setShowLoginPassword(false)
      await loadOverview()
    } catch {
      setError(t('portal.error.retry'))
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    await portalRequest('/logout', { method: 'POST' })
    setAuthenticated(false)
    setOverview(null)
    setCustomerId('')
    setPassword('')
    setShowLoginPassword(false)
  }

  const openWifiEditor = (index: number, ssid: unknown) => {
    setWifiEditor({ index, ssid: text(ssid), password: '' })
    setShowWifiPassword(false)
    setVisibleSavedPasswordIndex(null)
    setWifiFeedback(null)
  }

  const toggleSavedWifiPassword = async (index: number) => {
    if (visibleSavedPasswordIndex === index) {
      setVisibleSavedPasswordIndex(null)
      return
    }
    if (revealedWifiPasswords[index]) {
      setVisibleSavedPasswordIndex(index)
      return
    }

    setRevealingWifiPasswordIndex(index)
    setWifiFeedback(null)
    try {
      const result = await portalRequest<{ password: string }>(`/wifi/${index}/password`)
      if (!result.success || !result.data?.password) {
        if (result.message?.toLowerCase().includes('session')) setAuthenticated(false)
        setWifiFeedback({
          type: 'error',
          message: result.message || t('portal.wifi.error.revealFailed')
        })
        return
      }
      setRevealedWifiPasswords((current) => ({
        ...current,
        [index]: result.data!.password
      }))
      setVisibleSavedPasswordIndex(index)
    } catch {
      setWifiFeedback({
        type: 'error',
        message: t('portal.error.retry')
      })
    } finally {
      setRevealingWifiPasswordIndex(null)
    }
  }

  const saveWifi = async (event: FormEvent) => {
    event.preventDefault()
    if (!wifiEditor) return
    const ssid = wifiEditor.ssid.trim()
    if (!ssid || ssid.length > 32) {
      setWifiFeedback({ type: 'error', message: t('portal.wifi.error.ssidLength') })
      return
    }
    if (wifiEditor.password && !/^[\x20-\x7e]{8,63}$/.test(wifiEditor.password)) {
      setWifiFeedback({ type: 'error', message: t('portal.wifi.error.passwordLength') })
      return
    }

    setWifiSaving(true)
    setWifiFeedback(null)
    try {
      const result = await portalRequest<{ index: number; ssid: string }>('/wifi', {
        method: 'PUT',
        body: JSON.stringify({
          index: wifiEditor.index,
          ssid,
          password: wifiEditor.password
        }),
      })
      if (!result.success) {
        if (result.message?.toLowerCase().includes('session')) setAuthenticated(false)
        setWifiFeedback({
          type: 'error',
          message: result.message || t('portal.wifi.error.saveFailed')
        })
        return
      }
      setOverview((current) => current ? {
        ...current,
        wifi: current.wifi.map((network) => (
          network.index === wifiEditor.index
            ? {
                ...network,
                ssid,
                hasSavedPassword: Boolean(wifiEditor.password) || network.hasSavedPassword
              }
            : network
        ))
      } : current)
      setWifiEditor(null)
      setShowWifiPassword(false)
      setWifiFeedback({
        type: 'success',
        message: result.message || t('portal.wifi.success')
      })
    } catch {
      setWifiFeedback({
        type: 'error',
        message: t('portal.error.retry')
      })
    } finally {
      setWifiSaving(false)
    }
  }

  if (checkingSession) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-5">
        <div className="text-center" aria-live="polite">
          <BrandMark className="mx-auto h-12 w-12" title="SkyGenPanel" />
          <Icon name="refresh" className="mx-auto mt-5 animate-spin text-primary" />
          <p className="mt-2 text-sm text-muted-foreground">{t('portal.checkingSession')}</p>
        </div>
      </main>
    )
  }

  if (!authenticated) {
    return (
      <main className="min-h-screen bg-background px-4 py-8 sm:flex sm:items-center sm:justify-center">
        <div className="mx-auto w-full max-w-md">
          <header className="mb-8 flex items-center gap-3">
            <BrandMark className="h-12 w-12 shrink-0" title="SkyGenPanel" />
            <div className="min-w-0">
              <p className="text-lg font-bold">SkyGenPanel</p>
              <p className="text-sm text-muted-foreground">{t('portal.name')}</p>
            </div>
            <LanguageSwitcher className="ml-auto shrink-0" />
          </header>
          <section className="modern-card p-5 sm:p-7">
            <p className="page-kicker">{t('portal.login.kicker')}</p>
            <h1 className="text-2xl font-bold">{t('portal.login.title')}</h1>
            <p className="mb-6 mt-2 text-sm leading-6 text-muted-foreground">
              {t('portal.login.subtitle')}
            </p>
            <form className="space-y-4" onSubmit={login}>
              <div>
                <label className="field-label" htmlFor="customer-id">{t('portal.login.customerId')}</label>
                <input
                  id="customer-id"
                  className="modern-input font-mono uppercase"
                  value={customerId}
                  onChange={(event) => setCustomerId(event.target.value.toUpperCase())}
                  autoComplete="username"
                  maxLength={19}
                  placeholder="CSG-XXXXXXX-XXXXXX"
                  required
                />
              </div>
              <div>
                <label className="field-label" htmlFor="customer-password">{t('portal.login.password')}</label>
                <div className="relative">
                  <input
                    id="customer-password"
                    className="modern-input pr-12 font-mono"
                    type={showLoginPassword ? 'text' : 'password'}
                    inputMode="text"
                    pattern="[A-Za-z0-9]{6}"
                    maxLength={6}
                    value={password}
                    onChange={(event) => setPassword(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6))}
                    autoComplete="current-password"
                    placeholder={t('portal.login.passwordPlaceholder')}
                    required
                  />
                  <button
                    type="button"
                    className="absolute right-1 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                    onClick={() => setShowLoginPassword((visible) => !visible)}
                    aria-label={showLoginPassword ? t('portal.login.hidePassword') : t('portal.login.showPassword')}
                    aria-pressed={showLoginPassword}
                  >
                    <Icon name={showLoginPassword ? 'eye-off' : 'eye'} size={18} />
                  </button>
                </div>
              </div>
              {error && (
                <div className="rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-foreground" role="alert">
                  {error}
                </div>
              )}
              <button className="modern-button w-full" type="submit" disabled={loading}>
                {loading ? <Icon name="refresh" size={17} className="animate-spin" /> : <Icon name="lock" size={17} />}
                {loading ? t('portal.login.submitting') : t('portal.login.submit')}
              </button>
            </form>
          </section>
          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            {t('portal.login.footer')}
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="h-10 w-10 shrink-0" title="SkyGenPanel" />
            <div className="min-w-0">
              <p className="font-bold">{t('portal.name')}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{overview?.customerId || customerId}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LanguageSwitcher />
            <button type="button" className="modern-button-secondary shrink-0 px-3" onClick={logout}>
              <Icon name="logout" size={17} /> <span className="hidden sm:inline">{t('portal.signOut')}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="page-kicker">{t('portal.overview.kicker')}</p>
            <h1 className="page-title">{t('portal.overview.title')}</h1>
            <p className="page-description">{t('portal.overview.description')}</p>
          </div>
          <button type="button" className="modern-button-secondary" onClick={() => void loadOverview()} disabled={loading}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
            {t('portal.overview.refresh')}
          </button>
        </div>

        {error && (
          <section className="modern-card mb-5 border-destructive/40 p-4" role="alert">
            <div className="flex items-start gap-3">
              <Icon name="warning" className="mt-0.5 shrink-0 text-destructive" />
              <div>
                <h2 className="font-semibold">{t('portal.overview.errorTitle')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                <button type="button" className="mt-3 text-sm font-semibold text-primary hover:underline" onClick={() => void loadOverview()}>
                  {t('common.retry')}
                </button>
              </div>
            </div>
          </section>
        )}

        {!overview && loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('portal.overview.loadingAria')}>
            {[0, 1, 2, 3].map((item) => <div key={item} className="h-36 animate-pulse rounded-[var(--radius)] bg-muted" />)}
          </div>
        ) : overview ? (
          <>
            {overview.status === 'offline' && (
              <div className="mb-4 rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/10 p-4 text-sm">
                {t('portal.overview.offlineWarning')}
              </div>
            )}
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('portal.overview.metricsAria')}>
              <MetricCard
                icon="power"
                label={t('portal.metric.status')}
                value={overview.status === 'online' ? t('portal.metric.statusOnline') : t('portal.metric.statusOffline')}
                helper={t('portal.metric.lastInform', { time: dateTime(overview.lastInform) })}
              />
              <MetricCard icon="signal" label={t('portal.metric.rxPower')} value={`${text(overview.optical.rxPower)}${text(overview.optical.rxPower) === notReported ? '' : ' dBm'}`} />
              <MetricCard icon="thermometer" label={t('portal.metric.temperature')} value={`${text(overview.optical.temperature)}${text(overview.optical.temperature) === notReported ? '' : ' °C'}`} />
              <MetricCard icon="phone" label={t('portal.metric.connectedDevices')} value={text(overview.connectedDevices)} helper={t('portal.metric.connectedDevicesHelper')} />
            </section>

            <div className="mt-5 grid gap-5 lg:grid-cols-[1.05fr_.95fr]">
              <section className="modern-card p-5 sm:p-6">
                <h2 className="section-heading">{t('portal.ont.title')}</h2>
                <p className="section-description mb-5">{t('portal.ont.description')}</p>
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  {[
                    [t('portal.ont.manufacturer'), text(overview.ont.manufacturer)],
                    [t('portal.ont.model'), text(overview.ont.model)],
                    [t('portal.ont.serialNumber'), text(overview.ont.serialNumber)],
                    [t('portal.ont.hardware'), text(overview.ont.hardwareVersion)],
                    [t('portal.ont.software'), text(overview.ont.softwareVersion)],
                    [t('portal.ont.uptime'), uptime(overview.ont.uptimeSeconds)],
                    [t('portal.ont.lastBoot'), dateTime(overview.lastBoot)],
                    [t('portal.ont.registered'), dateTime(overview.registered)],
                  ].map(([label, value]) => (
                    <div key={label} className="border-b border-border pb-3">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
                      <dd className="mt-1 break-words font-mono text-sm">{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section className="modern-card p-5 sm:p-6">
                <h2 className="section-heading">{t('portal.wifi.title')}</h2>
                <p className="section-description mb-5">{t('portal.wifi.description')}</p>
                {wifiFeedback && (
                  <div
                    className={`mb-4 rounded-md border p-3 text-sm ${
                      wifiFeedback.type === 'success'
                        ? 'border-[hsl(var(--status-success))]/40 bg-[hsl(var(--status-success))]/10'
                        : 'border-destructive/40 bg-destructive/10'
                    }`}
                    role={wifiFeedback.type === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                  >
                    {wifiFeedback.message}
                  </div>
                )}
                {overview.wifi.length ? (
                  <div className="space-y-3">
                    {overview.wifi.map((network) => (
                      <article key={network.index} className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{text(network.ssid)}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{t('portal.wifi.networkLabel', { index: network.index })}</p>
                          </div>
                          <span className={
                            network.enabled === false
                              ? 'modern-badge-error'
                              : network.enabled === true
                                ? 'modern-badge-success'
                                : 'modern-badge'
                          }>
                            {
                              network.enabled === false
                                ? t('portal.wifi.disabled')
                                : network.enabled === true
                                  ? t('portal.wifi.enabled')
                                  : t('portal.wifi.statusUnknown')
                            }
                          </span>
                        </div>
                        <p className="mt-3 text-sm text-muted-foreground">
                          <strong className="text-foreground">{text(network.connectedDevices)}</strong> {t('portal.wifi.connectedDevices')}
                        </p>
                        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">{t('portal.wifi.savedPassword')}</p>
                            <p className="mt-1 truncate font-mono text-sm">
                              {network.hasSavedPassword
                                ? (
                                    visibleSavedPasswordIndex === network.index &&
                                    revealedWifiPasswords[network.index]
                                      ? revealedWifiPasswords[network.index]
                                      : '••••••••••••'
                                  )
                                : t('portal.wifi.noSavedPassword')}
                            </p>
                          </div>
                          {network.hasSavedPassword && (
                            <button
                              type="button"
                              className="inline-flex size-10 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                              disabled={revealingWifiPasswordIndex === network.index}
                              onClick={() => void toggleSavedWifiPassword(network.index)}
                              aria-label={
                                visibleSavedPasswordIndex === network.index
                                  ? t('portal.wifi.hideSavedPassword')
                                  : t('portal.wifi.showSavedPassword')
                              }
                              aria-pressed={visibleSavedPasswordIndex === network.index}
                            >
                              <Icon
                                name={
                                  revealingWifiPasswordIndex === network.index
                                    ? 'refresh'
                                    : visibleSavedPasswordIndex === network.index
                                      ? 'eye-off'
                                      : 'eye'
                                }
                                size={18}
                                className={revealingWifiPasswordIndex === network.index ? 'animate-spin' : ''}
                              />
                            </button>
                          )}
                        </div>
                        <p className="mt-1.5 text-[0.68rem] leading-5 text-muted-foreground">
                          {t('portal.wifi.savedPasswordHint')}
                        </p>
                        {wifiEditor?.index === network.index ? (
                          <form className="mt-4 space-y-4 border-t border-border pt-4" onSubmit={saveWifi}>
                            <div>
                              <label className="field-label" htmlFor={`wifi-ssid-${network.index}`}>{t('portal.wifi.ssidLabel')}</label>
                              <input
                                id={`wifi-ssid-${network.index}`}
                                className="modern-input"
                                value={wifiEditor.ssid}
                                maxLength={32}
                                onChange={(event) => setWifiEditor((current) => (
                                  current ? { ...current, ssid: event.target.value } : current
                                ))}
                                autoComplete="off"
                                required
                              />
                              <p className="field-hint">{t('portal.wifi.ssidHint')}</p>
                            </div>
                            <div>
                              <label className="field-label" htmlFor={`wifi-password-${network.index}`}>{t('portal.wifi.newPassword')}</label>
                              <div className="relative">
                                <input
                                  id={`wifi-password-${network.index}`}
                                  className="modern-input pr-12 font-mono"
                                  type={showWifiPassword ? 'text' : 'password'}
                                  value={wifiEditor.password}
                                  minLength={wifiEditor.password ? 8 : undefined}
                                  maxLength={63}
                                  onChange={(event) => setWifiEditor((current) => (
                                    current ? { ...current, password: event.target.value } : current
                                  ))}
                                  autoComplete="new-password"
                                  placeholder={t('portal.wifi.newPasswordPlaceholder')}
                                />
                                <button
                                  type="button"
                                  className="absolute right-1 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                                  onClick={() => setShowWifiPassword((visible) => !visible)}
                                  aria-label={showWifiPassword ? t('portal.wifi.hidePassword') : t('portal.wifi.showPassword')}
                                  aria-pressed={showWifiPassword}
                                >
                                  <Icon name={showWifiPassword ? 'eye-off' : 'eye'} size={18} />
                                </button>
                              </div>
                              <p className="field-hint">{t('portal.wifi.passwordHint')}</p>
                            </div>
                            <div className="rounded-md border border-[hsl(var(--status-warning))]/35 bg-[hsl(var(--status-warning))]/10 p-3 text-xs leading-5">
                              {t('portal.wifi.disconnectWarning')}
                            </div>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                              <button
                                type="button"
                                className="modern-button-secondary"
                                disabled={wifiSaving}
                                onClick={() => setWifiEditor(null)}
                              >
                                {t('common.cancel')}
                              </button>
                              <button
                                type="submit"
                                className="modern-button"
                                disabled={
                                  wifiSaving ||
                                  (!wifiEditor.password && wifiEditor.ssid.trim() === text(network.ssid))
                                }
                              >
                                <Icon name={wifiSaving ? 'refresh' : 'check'} size={17} className={wifiSaving ? 'animate-spin' : ''} />
                                {wifiSaving ? t('portal.wifi.saving') : t('portal.wifi.save')}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="modern-button-secondary mt-4 w-full"
                            onClick={() => openWifiEditor(network.index, network.ssid)}
                          >
                            <Icon name="edit" size={17} /> {t('portal.wifi.edit')}
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border p-6 text-center">
                    <Icon name="wifi" className="mx-auto text-muted-foreground" />
                    <p className="mt-2 text-sm font-semibold">{t('portal.wifi.empty')}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{t('portal.wifi.emptyHint')}</p>
                  </div>
                )}
              </section>
            </div>
            <p className="mt-5 text-center text-xs text-muted-foreground">
              {t('portal.footer.updated', { time: dateTime(overview.generatedAt) })}
            </p>
          </>
        ) : null}
      </div>
    </main>
  )
}
