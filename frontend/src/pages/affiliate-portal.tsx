'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { affiliatePortalAPI, type AffiliatePortalOverview } from '@/lib/api'
import { BrandMark } from '@/components/brand-mark'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import {
  COMMISSION_STATUS_KEYS, PAYOUT_STATUS_KEYS, affiliateBadgeClass, bpToPercent, passwordTokenFromHash
} from '@/lib/affiliates'
import { displayDate } from '@/lib/date-format'
import { formatMoney } from '@/lib/money'

const brl = (cents: number) => formatMoney(cents, 'BRL')

/**
 * O portal do afiliado (0124), em `/afiliados` no endereço da plataforma.
 *
 * Sessão própria — cookie httpOnly do portal, nunca o token do painel ou do
 * console que este navegador tenha guardado (`affiliatePortalAPI`). Três
 * estados: o link de definir senha (`#senha=<token>`, tirado da barra assim
 * que lido), o login, e o painel: o link de indicação, os indicados com o
 * nome mascarado, o extrato e os lotes.
 */
export default function AffiliatePortalPage() {
  const { t } = useTranslation()
  const id = useId()
  const [token] = useState(() => passwordTokenFromHash(typeof window === 'undefined' ? '' : window.location.hash))
  const [estado, setEstado] = useState<'carregando' | 'senha' | 'login' | 'painel'>(token ? 'senha' : 'carregando')
  const [dados, setDados] = useState<AffiliatePortalOverview | null>(null)
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [confirma, setConfirma] = useState('')
  const [erro, setErro] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [copiado, setCopiado] = useState(false)
  const lido = useRef(false)

  const carregar = useCallback(async () => {
    const res = await affiliatePortalAPI.overview()
    if (res.success && res.data) {
      setDados(res.data)
      setEstado('painel')
    } else {
      setEstado('login')
    }
  }, [])

  useEffect(() => {
    if (lido.current) return
    lido.current = true
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
    if (!token) void carregar()
  }, [carregar, token])

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault()
    setErro('')
    setEnviando(true)
    try {
      const res = await affiliatePortalAPI.login(email.trim(), senha)
      if (res.success) {
        setSenha('')
        await carregar()
      } else {
        setErro(res.code === 'invalid_credentials' ? t('affiliatePortal.invalid') : (res.message || t('affiliatePortal.failed')))
      }
    } finally {
      setEnviando(false)
    }
  }

  const definir = async (e: React.FormEvent) => {
    e.preventDefault()
    setErro('')
    if (senha.length < 10 || senha.length > 128) return setErro(t('affiliatePortal.passwordWeak'))
    if (senha !== confirma) return setErro(t('affiliatePortal.passwordMismatch'))
    if (!token) return setErro(t('affiliatePortal.linkInvalid'))
    setEnviando(true)
    try {
      const res = await affiliatePortalAPI.setPassword(token, senha)
      setSenha('')
      setConfirma('')
      if (res.success) await carregar()
      else setErro(res.code === 'weak_password' ? t('affiliatePortal.passwordWeak') : t('affiliatePortal.linkInvalid'))
    } finally {
      setEnviando(false)
    }
  }

  const sair = async () => {
    await affiliatePortalAPI.logout()
    setDados(null)
    setEstado('login')
  }

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    } catch {
      window.prompt(t('affiliatePortal.yourLink'), texto)
    }
  }

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className={`size-10 shrink-0 ${estado === 'carregando' ? 'animate-pulse' : ''}`} />
            <h1 className="wrap-break-word text-xl font-bold text-foreground">{t('affiliatePortal.title')}</h1>
          </div>
          {estado === 'painel' && (
            <button type="button" className="modern-button-secondary" onClick={() => void sair()}>
              <Icon name="logout" size={16} />
              {t('affiliatePortal.signOut')}
            </button>
          )}
        </div>

        {estado === 'carregando' && (
          <p className="mt-8 text-sm text-muted-foreground" role="status" aria-live="polite">{t('common.loading')}</p>
        )}

        {(estado === 'login' || estado === 'senha') && (
          <form
            className="modern-card mx-auto mt-8 max-w-md space-y-4 p-5 sm:p-6"
            onSubmit={(e) => void (estado === 'senha' ? definir(e) : entrar(e))}
            noValidate
          >
            <h2 className="text-base font-semibold">{t(estado === 'senha' ? 'affiliatePortal.setPasswordTitle' : 'affiliatePortal.loginTitle')}</h2>
            {estado === 'login' && (
              <div>
                <label htmlFor={`${id}-email`} className="mb-1 block text-sm font-medium">{t('affiliatePortal.email')}</label>
                <input id={`${id}-email`} type="email" autoComplete="username" className="modern-input w-full" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
            )}
            <div>
              <label htmlFor={`${id}-senha`} className="mb-1 block text-sm font-medium">{t('affiliatePortal.password')}</label>
              <input
                id={`${id}-senha`}
                type="password"
                autoComplete={estado === 'senha' ? 'new-password' : 'current-password'}
                className="modern-input w-full"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                maxLength={128}
                required
              />
              {estado === 'senha' && <p className="field-hint">{t('affiliatePortal.setPasswordHint')}</p>}
            </div>
            {estado === 'senha' && (
              <div>
                <label htmlFor={`${id}-confirma`} className="mb-1 block text-sm font-medium">{t('affiliatePortal.confirmPassword')}</label>
                <input id={`${id}-confirma`} type="password" autoComplete="new-password" className="modern-input w-full" value={confirma} onChange={(e) => setConfirma(e.target.value)} maxLength={128} required />
              </div>
            )}
            {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
            <button type="submit" className="modern-button w-full" disabled={enviando}>
              {enviando ? t('common.loading') : t(estado === 'senha' ? 'affiliatePortal.savePassword' : 'affiliatePortal.signIn')}
            </button>
          </form>
        )}

        {estado === 'painel' && dados && (
          <div className="mt-8 space-y-6">
            <section className="modern-card p-5">
              <p className="wrap-break-word font-semibold">{dados.profile.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('affiliatePortal.terms', { rate: bpToPercent(dados.profile.rateBp), months: dados.profile.months })}
              </p>
              <h2 className="mt-4 text-sm font-semibold">{t('affiliatePortal.yourLink')}</h2>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <code className="min-w-0 flex-1 break-all rounded bg-muted px-3 py-2 text-sm">
                  {dados.profile.signupUrl ?? `${window.location.origin}/signup?aff=${dados.profile.code}`}
                </code>
                <button
                  type="button"
                  className="modern-button-secondary"
                  onClick={() => void copiar(dados.profile.signupUrl ?? `${window.location.origin}/signup?aff=${dados.profile.code}`)}
                >
                  <Icon name={copiado ? 'check' : 'copy'} size={16} />
                  {t(copiado ? 'common.copied' : 'common.copy')}
                </button>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                {dados.profile.pixKey
                  ? t('affiliatePortal.pix', { type: dados.profile.pixKeyType ?? '', key: dados.profile.pixKey })
                  : t('affiliatePortal.noPix')}
              </p>
            </section>

            <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {([
                ['affiliatePortal.toReceive', dados.totals.accruedCents],
                ['affiliatePortal.inPayout', dados.totals.inPayoutCents],
                ['affiliatePortal.paid', dados.totals.paidCents]
              ] as const).map(([rotulo, valor]) => (
                <div key={rotulo} className="modern-card p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{t(rotulo)}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{brl(valor)}</p>
                </div>
              ))}
            </section>
            <p className="text-sm text-muted-foreground">{t('affiliatePortal.minPayout', { amount: brl(dados.payoutMinCents) })}</p>

            <section>
              <h2 className="mb-2 text-base font-semibold">{t('affiliatePortal.referrals')}</h2>
              {!dados.referrals.length ? (
                <p className="text-sm text-muted-foreground">{t('affiliatePortal.noReferrals')}</p>
              ) : (
                <ul className="modern-card divide-y divide-border">
                  {dados.referrals.map((r, i) => (
                    <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                      <span className="wrap-break-word font-medium">{r.name}</span>
                      <span className="text-muted-foreground">
                        {t('affiliatePortal.until', { date: displayDate(r.windowEndsAt) ?? '—' })} · {brl(r.commissionCents)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold">{t('affiliatePortal.statement')}</h2>
              {!dados.commissions.length ? (
                <p className="text-sm text-muted-foreground">{t('affiliatePortal.noCommissions')}</p>
              ) : (
                <div className="modern-card overflow-x-auto">
                  <table className="modern-table">
                    <tbody>
                      {dados.commissions.map((c) => (
                        <tr key={c.id}>
                          <td>{displayDate(c.accruedAt) ?? '—'}</td>
                          <td className="wrap-break-word">{c.kind === 'clawback' ? t('affiliates.kind.clawback') : c.providerName}</td>
                          <td className="tabular-nums">{brl(c.amountCents)}</td>
                          <td><span className={affiliateBadgeClass(c.status)}>{t(COMMISSION_STATUS_KEYS[c.status])}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold">{t('affiliatePortal.payouts')}</h2>
              {!dados.payouts.length ? (
                <p className="text-sm text-muted-foreground">{t('affiliatePortal.noPayouts')}</p>
              ) : (
                <ul className="modern-card divide-y divide-border">
                  {dados.payouts.map((p) => (
                    <li key={p.period} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                      <span className="font-medium">{p.period}</span>
                      <span className="tabular-nums">{brl(p.amountCents)}</span>
                      <span className={affiliateBadgeClass(p.status)}>{t(PAYOUT_STATUS_KEYS[p.status])}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  )
}
