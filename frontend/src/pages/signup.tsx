'use client'

import { useState } from 'react'
import { Link } from 'react-router'
import { authAPI, type SignupResult } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'
import { useTenant } from '@/contexts/tenant-context'

/**
 * An ISP signing up on its own. Only reachable where the deployment gives
 * providers subdomains (`panelBaseDomain`), because the answer to a signup is
 * an ADDRESS: the new provider's panel lives at `slug.<base>`, and this host
 * cannot sign the person in there — a token stored here would be refused on
 * that host. So the screen ends with the address and a link, not a session.
 */
export default function Signup() {
  const { t } = useTranslation()
  const { tenant, name: hostName } = useTenant()
  const base = tenant?.panelBaseDomain ?? null
  const [form, setForm] = useState({ providerName: '', slug: '', username: '', password: '', confirm: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<SignupResult | null>(null)

  const slugFromName = (value: string) => value
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (form.providerName.trim().length < 1) return setError(t('signup.error.name'))
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(form.slug) || form.slug.length < 3) return setError(t('signup.error.slug'))
    if (form.username.trim().length < 3) return setError(t('setup.error.usernameTooShort'))
    if (form.password.length < 8) return setError(t('setup.error.passwordTooShort'))
    if (form.password !== form.confirm) return setError(t('setup.error.passwordMismatch'))
    setLoading(true)
    try {
      const res = await authAPI.signup({
        providerName: form.providerName.trim(), slug: form.slug, username: form.username.trim(), password: form.password
      })
      if (res.success && res.data) setDone(res.data)
      else setError(res.message || t('signup.error.failed'))
    } catch {
      setError(t('login.error.unreachable'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-background px-4 pb-10 pt-16 sm:px-8 lg:items-center">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <BrandMark className="size-10" title={hostName} />
            <div>
              <div className="font-bold">{hostName}</div>
              <div className="text-[0.65rem] font-bold uppercase tracking-[0.13em] text-muted-foreground">{t('app.genieacsOperations')}</div>
            </div>
          </div>
          <LanguageSwitcher className="ml-auto" />
        </div>

        <div className="auth-panel">
          {!base ? (
            <p className="text-sm text-muted-foreground">{t('signup.unavailable')}</p>
          ) : done ? (
            <div className="space-y-4">
              <p className="page-kicker">{t('signup.doneKicker')}</p>
              <h1 className="text-2xl font-bold text-foreground">{t('signup.doneTitle', { name: done.tenant.name })}</h1>
              <p className="text-sm leading-6 text-muted-foreground">{t('signup.doneText')}</p>
              {done.panelUrl && (
                <a href={done.panelUrl} className="modern-button w-full">
                  <Icon name="external" size={17} />
                  {done.panelUrl.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
          ) : (
            <>
              <div className="mb-7">
                <p className="page-kicker">{t('signup.kicker')}</p>
                <h1 className="text-2xl font-bold text-foreground">{t('signup.title')}</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('signup.subtitle')}</p>
              </div>
              <form className="space-y-5" onSubmit={submit} noValidate>
                {error && (
                  <div id="signup-error" className="alert-error flex gap-2.5" role="alert">
                    <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                <div>
                  <label htmlFor="providerName" className="field-label">{t('signup.providerName')}</label>
                  <input
                    id="providerName" className="modern-input" required autoFocus maxLength={128}
                    value={form.providerName}
                    onChange={(e) => setForm((f) => ({ ...f, providerName: e.target.value, slug: f.slug === slugFromName(f.providerName) ? slugFromName(e.target.value) : f.slug }))}
                  />
                </div>
                <div>
                  <label htmlFor="slug" className="field-label">{t('signup.slug')}</label>
                  <div className="flex items-center gap-2">
                    <input
                      id="slug" className="modern-input font-mono" required maxLength={63}
                      value={form.slug}
                      onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                      aria-describedby="slug-hint"
                    />
                    <span className="shrink-0 text-sm text-muted-foreground">.{base}</span>
                  </div>
                  <p id="slug-hint" className="field-hint">{t('platform.slugHint')}</p>
                </div>
                <div>
                  <label htmlFor="username" className="field-label">{t('signup.username')}</label>
                  <input id="username" className="modern-input" required autoComplete="username" value={form.username}
                    onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="password" className="field-label">{t('login.password')}</label>
                  <input id="password" type="password" className="modern-input" required autoComplete="new-password" value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="confirm" className="field-label">{t('setup.confirmPassword')}</label>
                  <input id="confirm" type="password" className="modern-input" required autoComplete="new-password" value={form.confirm}
                    onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))} />
                </div>
                <button type="submit" disabled={loading} className="modern-button w-full">
                  {loading ? t('signup.submitting') : t('signup.submit')}
                </button>
              </form>
            </>
          )}
        </div>
        <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
          <Link to="/login" className="underline">{t('signup.backToLogin')}</Link>
        </p>
      </div>
    </main>
  )
}
