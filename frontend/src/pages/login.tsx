'use client'

import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/contexts/auth-context'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'

export default function Login() {
  // `identifier` e não `username`: o campo aceita os dois, e chamar o estado
  // de nome de usuário faria a próxima pessoa a ler achar que só o nome passa.
  const [formData, setFormData] = useState({ identifier: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const navigate = useNavigate()
  const { login } = useAuth()
  const { t } = useTranslation()

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const ok = await login(formData.identifier, formData.password)
      if (ok) navigate('/dashboard')
      else setError(t('login.error.invalidCredentials'))
    } catch {
      setError(t('login.error.unreachable'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(22rem,0.8fr)_minmax(32rem,1.2fr)]">
      <section className="hidden flex-col justify-between bg-[#18211d] p-10 text-[#f4f3ed] lg:flex xl:p-14" aria-label={t('login.productInformation')}>
        <div className="flex items-center gap-3">
          <BrandMark className="size-11" />
          <div>
            <div className="text-lg font-bold">SkyGenPanel</div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-[#9aa9a2]">{t('app.genieacsOperations')}</div>
          </div>
        </div>
        <div className="max-w-lg">
          <div className="mb-5 h-px w-16 bg-[#d97706]" />
          <h1 className="text-4xl font-semibold leading-[1.12] tracking-[-0.035em] text-white">
            {t('login.hero.title')}
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-[#b8c4bd]">
            {t('login.hero.description')}
          </p>
        </div>
        <p className="text-xs leading-5 text-[#819087]">
          {t('login.hero.footer')}
        </p>
      </section>

      <main className="flex min-h-screen items-start justify-center px-4 pb-10 pt-16 sm:px-8 lg:items-center lg:py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 lg:hidden">
              <BrandMark className="size-10" title="SkyGenPanel" />
              <div>
                <div className="font-bold">SkyGenPanel</div>
                <div className="text-[0.65rem] font-bold uppercase tracking-[0.13em] text-muted-foreground">{t('app.genieacsOperations')}</div>
              </div>
            </div>
            <LanguageSwitcher className="ms-auto" />
          </div>

          <div className="auth-panel">
            <div className="mb-7">
              <p className="page-kicker">{t('login.kicker')}</p>
              <h1 className="text-2xl font-bold text-foreground">{t('login.title')}</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t('login.subtitle')}
              </p>
            </div>

            <form className="space-y-5" onSubmit={handleSubmit} noValidate>
              {error && (
                <div id="login-error" className="alert-error flex gap-2.5" role="alert">
                  <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label htmlFor="identifier" className="field-label">{t('login.identifier')}</label>
                {/* `text` e `username`, e deliberadamente não `email`: um
                    `type="email"` faria o navegador recusar o nome de usuário
                    que a maioria ainda digita, e `autoComplete="username"` é o
                    único valor que o gerenciador de senhas preenche com
                    qualquer um dos dois. */}
                <input
                  id="identifier"
                  name="identifier"
                  type="text"
                  autoComplete="username"
                  required
                  autoFocus
                  value={formData.identifier}
                  onChange={(event) => setFormData((value) => ({ ...value, identifier: event.target.value }))}
                  className="modern-input"
                  placeholder={t('login.identifierPlaceholder')}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'login-error' : 'identifier-hint'}
                />
                <p id="identifier-hint" className="field-hint">{t('login.identifierHint')}</p>
              </div>

              <div>
                <label htmlFor="password" className="field-label">{t('login.password')}</label>
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={formData.password}
                    onChange={(event) => setFormData((value) => ({ ...value, password: event.target.value }))}
                    className="modern-input pe-12"
                    placeholder={t('login.passwordPlaceholder')}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? 'login-error' : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute inset-y-0 end-0 flex w-11 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                  >
                    <Icon name={showPassword ? 'eye-off' : 'eye'} size={19} />
                  </button>
                </div>
              </div>

              <button type="submit" disabled={loading} className="modern-button w-full">
                {loading ? (
                  <>
                    <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    {t('login.submitting')}
                  </>
                ) : t('login.submit')}
              </button>
            </form>
          </div>
          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            {t('login.helpText')}
          </p>
        </div>
      </main>
    </div>
  )
}
