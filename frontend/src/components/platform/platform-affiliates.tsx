'use client'

import { Fragment, useCallback, useEffect, useId, useState } from 'react'
import {
  affiliatesAPI,
  type AffiliateDefaults,
  type AffiliateDetail,
  type AffiliateInput,
  type AffiliatePayoutView,
  type AffiliateView
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import {
  AFFILIATE_STATUS_KEYS,
  COMMISSION_STATUS_KEYS,
  PAYOUT_STATUS_KEYS,
  PIX_KEY_TYPES,
  affiliateBadgeClass,
  bpToPercent,
  parseMonths,
  payoutActions,
  percentToBp,
  type PixKeyType
} from '@/lib/affiliates'
import { displayDate } from '@/lib/date-format'
import { formatMoney } from '@/lib/money'
import { parseAmountToCents } from '@/lib/utils'

const brl = (cents: number | null | undefined) => formatMoney(cents ?? 0, 'BRL')

const FORM_VAZIO = {
  name: '', email: '', taxId: '', pixKey: '', pixKeyType: '' as PixKeyType | '', rate: '', months: '', code: '', notes: '', approve: true
}
type Formulario = typeof FORM_VAZIO

function formDe(a: AffiliateView): Formulario {
  return {
    name: a.name,
    email: a.email,
    taxId: a.taxId ?? '',
    pixKey: a.pixKey ?? '',
    pixKeyType: a.pixKeyType ?? '',
    rate: bpToPercent(a.rateBp),
    months: a.months === null ? '' : String(a.months),
    code: a.code,
    notes: a.notes ?? '',
    approve: a.status === 'active'
  }
}

async function copiar(texto: string) {
  try {
    await navigator.clipboard.writeText(texto)
    return true
  } catch {
    return false
  }
}

/**
 * A aba Afiliados do console (0126): o cadastro e a aprovação de quem divulga
 * o produto, os padrões do programa, e o fechamento mensal — o lote que o
 * agendador monta, que alguém daqui revisa e aprova, e só então manda o Pix.
 */
export function PlatformAffiliates() {
  const { t } = useTranslation()
  const toast = useToast()
  const formId = useId()
  const [affiliates, setAffiliates] = useState<AffiliateView[]>([])
  const [defaults, setDefaults] = useState<AffiliateDefaults | null>(null)
  const [payouts, setPayouts] = useState<AffiliatePayoutView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<Formulario>(FORM_VAZIO)
  const [formErro, setFormErro] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<AffiliateDetail | null>(null)
  const [padroes, setPadroes] = useState({ rate: '', months: '', min: '' })

  const carregar = useCallback(async () => {
    setLoading(true)
    const [lista, lotes] = await Promise.all([affiliatesAPI.list(), affiliatesAPI.payouts()])
    if (lista.success && lista.data) {
      setAffiliates(lista.data.affiliates)
      setDefaults(lista.data.defaults)
      setPadroes({
        rate: bpToPercent(lista.data.defaults.rateBp),
        months: String(lista.data.defaults.months),
        min: (lista.data.defaults.payoutMinCents / 100).toFixed(2).replace('.', ',')
      })
      setError(null)
    } else {
      setError(lista.message || t('affiliates.loadFailed'))
    }
    if (lotes.success && lotes.data) setPayouts(lotes.data.payouts)
    setLoading(false)
  }, [t])

  useEffect(() => { void carregar() }, [carregar])

  const abrirDetalhe = async (id: number) => {
    if (openId === id) { setOpenId(null); setDetail(null); return }
    setOpenId(id)
    setDetail(null)
    const res = await affiliatesAPI.detail(id)
    if (res.success && res.data) setDetail(res.data)
    else toast.error(res.message || t('affiliates.loadFailed'))
  }

  const salvar = async () => {
    setFormErro(null)
    const rateBp = percentToBp(form.rate)
    const months = parseMonths(form.months)
    if (rateBp === undefined) return setFormErro(t('affiliates.error.rate'))
    if (months === undefined) return setFormErro(t('affiliates.error.months'))
    if (form.pixKey.trim() && !form.pixKeyType) return setFormErro(t('affiliates.error.pixType'))
    const input: AffiliateInput = {
      name: form.name.trim(),
      email: form.email.trim(),
      taxId: form.taxId.trim(),
      pixKey: form.pixKey.trim(),
      pixKeyType: form.pixKeyType,
      rateBp,
      months,
      notes: form.notes,
      ...(form.code.trim() ? { code: form.code.trim() } : {})
    }
    setSaving(true)
    try {
      const res = editing === 'new'
        ? await affiliatesAPI.create({ ...input, ...(form.approve ? { status: 'active' as const } : {}) })
        : await affiliatesAPI.update(Number(editing), input)
      if (res.success) {
        toast.success(t(editing === 'new' ? 'affiliates.created' : 'affiliates.updated'))
        setEditing(null)
        setForm(FORM_VAZIO)
        await carregar()
      } else {
        setFormErro(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const mudarStatus = async (a: AffiliateView, status: 'active' | 'suspended') => {
    setBusy(`a${a.id}`)
    try {
      const res = await affiliatesAPI.update(a.id, { status })
      if (res.success) {
        toast.success(t('affiliates.updated'))
        await carregar()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusy(null)
    }
  }

  const linkDeSenha = async (a: AffiliateView) => {
    setBusy(`a${a.id}`)
    try {
      const res = await affiliatesAPI.passwordLink(a.id)
      if (res.success && res.data) {
        const url = `${window.location.origin}${res.data.path}`
        if (await copiar(url)) toast.success(t('affiliates.passwordLinkCopied'))
        else window.prompt(t('affiliates.passwordLink'), url)
        await carregar()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusy(null)
    }
  }

  const salvarPadroes = async () => {
    const rate = percentToBp(padroes.rate)
    const months = parseMonths(padroes.months)
    const min = padroes.min.trim() ? parseAmountToCents(padroes.min) : 0
    if (rate === undefined || rate === null) return toast.error(t('affiliates.error.rate'))
    if (months === undefined || months === null) return toast.error(t('affiliates.error.months'))
    if (min === null) return toast.error(t('affiliates.error.minPayout'))
    setBusy('padroes')
    try {
      const res = await affiliatesAPI.saveDefaults({ affiliateRateBp: rate, affiliateMonths: months, affiliatePayoutMinCents: min })
      if (res.success) {
        toast.success(t('affiliates.settings.saved'))
        await carregar()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusy(null)
    }
  }

  const montar = async () => {
    setBusy('montar')
    try {
      const res = await affiliatesAPI.build()
      if (res.success && res.data) {
        toast.success(t('affiliates.payouts.built', { count: res.data.created.length }))
        await carregar()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusy(null)
    }
  }

  const acao = async (p: AffiliatePayoutView, qual: 'approve' | 'send' | 'refresh' | 'mark-paid' | 'cancel') => {
    const pode = payoutActions(p)
    const corpo: { confirmNotSent?: boolean; note?: string } = {}
    if ((qual === 'send' || qual === 'cancel') && pode.needsConfirm) {
      if (!window.confirm(t('affiliates.payouts.uncertainConfirm'))) return
      corpo.confirmNotSent = true
    }
    if (qual === 'send' && !window.confirm(t('affiliates.payouts.sendConfirm', { amount: brl(p.amountCents), name: p.affiliateName ?? `#${p.affiliateId}` }))) return
    if (qual === 'cancel' && !window.confirm(t('affiliates.payouts.cancelConfirm'))) return
    if (qual === 'mark-paid') {
      const nota = window.prompt(t('affiliates.payouts.markPaidPrompt'), '')
      if (nota === null) return
      corpo.note = nota
    }
    setBusy(`p${p.id}`)
    try {
      const res = await affiliatesAPI.payoutAction(p.id, qual, corpo)
      if (res.success && res.data) {
        if (res.data.payout.status === 'failed') {
          toast.error(t('affiliates.payouts.error', { error: res.data.payout.error ?? res.data.payout.errorCode ?? '' }))
        } else {
          toast.success(t('affiliates.payouts.done'))
        }
        await carregar()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusy(null)
    }
  }

  const campo = (chave: keyof Formulario, rotulo: string, extra: { hint?: string; inputMode?: 'numeric' | 'decimal' | 'email'; maxLength?: number } = {}) => (
    <div>
      <label htmlFor={`${formId}-${chave}`} className="mb-1 block text-sm font-medium">{rotulo}</label>
      <input
        id={`${formId}-${chave}`}
        value={String(form[chave])}
        onChange={(e) => setForm({ ...form, [chave]: e.target.value })}
        className="modern-input w-full"
        inputMode={extra.inputMode}
        maxLength={extra.maxLength ?? 160}
        autoComplete="off"
      />
      {extra.hint && <p className="field-hint">{extra.hint}</p>}
    </div>
  )

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="section-heading">{t('affiliates.title')}</h2>
          <p className="section-description">{t('affiliates.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="modern-button"
            onClick={() => {
              setEditing(editing === 'new' ? null : 'new')
              setForm(FORM_VAZIO)
              setFormErro(null)
            }}
          >
            <Icon name={editing === 'new' ? 'x' : 'contacts'} size={17} />
            {t(editing === 'new' ? 'common.cancel' : 'affiliates.new')}
          </button>
          <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void carregar()}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {defaults && (
        <form
          className="modern-card p-5"
          onSubmit={(e) => { e.preventDefault(); void salvarPadroes() }}
        >
          <h3 className="mb-3 text-sm font-semibold">{t('affiliates.settings.title')}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor={`${formId}-drate`} className="mb-1 block text-sm font-medium">{t('affiliates.settings.rate')}</label>
              <input id={`${formId}-drate`} className="modern-input w-full" inputMode="decimal" value={padroes.rate} onChange={(e) => setPadroes({ ...padroes, rate: e.target.value })} />
            </div>
            <div>
              <label htmlFor={`${formId}-dmonths`} className="mb-1 block text-sm font-medium">{t('affiliates.settings.months')}</label>
              <input id={`${formId}-dmonths`} className="modern-input w-full" inputMode="numeric" value={padroes.months} onChange={(e) => setPadroes({ ...padroes, months: e.target.value })} />
            </div>
            <div>
              <label htmlFor={`${formId}-dmin`} className="mb-1 block text-sm font-medium">{t('affiliates.settings.minPayout')}</label>
              <input id={`${formId}-dmin`} className="modern-input w-full" inputMode="decimal" value={padroes.min} onChange={(e) => setPadroes({ ...padroes, min: e.target.value })} />
            </div>
          </div>
          <p className="field-hint">{t('affiliates.settings.hint')}</p>
          <button type="submit" className="modern-button-secondary mt-3" disabled={busy === 'padroes'}>
            {busy === 'padroes' ? t('common.saving') : t('common.save')}
          </button>
        </form>
      )}

      {editing !== null && (
        <form className="modern-card p-5 sm:p-6" onSubmit={(e) => { e.preventDefault(); void salvar() }}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {campo('name', t('affiliates.name'))}
            {campo('email', t('affiliates.email'), { inputMode: 'email' })}
            {campo('taxId', t('affiliates.taxId'), { maxLength: 20 })}
            <div>
              <label htmlFor={`${formId}-pixtype`} className="mb-1 block text-sm font-medium">{t('affiliates.pixKeyType')}</label>
              <select
                id={`${formId}-pixtype`}
                value={form.pixKeyType}
                onChange={(e) => setForm({ ...form, pixKeyType: e.target.value as PixKeyType | '' })}
                className="modern-input w-full"
              >
                <option value="">—</option>
                {PIX_KEY_TYPES.map((tipo) => <option key={tipo} value={tipo}>{tipo}</option>)}
              </select>
            </div>
            {campo('pixKey', t('affiliates.pixKey'), { maxLength: 140 })}
            {campo('rate', t('affiliates.rate'), { inputMode: 'decimal', hint: t('affiliates.rateHint', { rate: bpToPercent(defaults?.rateBp) }), maxLength: 6 })}
            {campo('months', t('affiliates.months'), { inputMode: 'numeric', hint: t('affiliates.monthsHint', { months: defaults?.months ?? '' }), maxLength: 3 })}
            {campo('code', t('affiliates.code'), { hint: t('affiliates.codeHint'), maxLength: 15 })}
            {campo('notes', t('affiliates.notes'), { maxLength: 500 })}
          </div>
          {editing === 'new' && (
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.approve} onChange={(e) => setForm({ ...form, approve: e.target.checked })} />
              {t('affiliates.approveOnCreate')}
            </label>
          )}
          {formErro && <p role="alert" className="mt-3 text-sm text-destructive">{formErro}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" className="modern-button" disabled={saving}>
              {saving ? t('common.saving') : t(editing === 'new' ? 'affiliates.create' : 'common.save')}
            </button>
            {editing !== 'new' && (
              <button type="button" className="modern-button-secondary" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
            )}
          </div>
        </form>
      )}

      {loading && !affiliates.length ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : error !== null ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !affiliates.length ? (
        <p className="text-sm text-muted-foreground">{t('affiliates.empty')}</p>
      ) : (
        <ul className="space-y-3">
          {affiliates.map((a) => (
            <li key={a.id} className="modern-card min-w-0 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="wrap-break-word font-semibold text-foreground">{a.name}</p>
                  <p className="break-all text-sm text-muted-foreground">{a.email}</p>
                </div>
                <span className={affiliateBadgeClass(a.status)}>{t(AFFILIATE_STATUS_KEYS[a.status])}</span>
              </div>
              <p className="mt-2 text-sm">
                <span className="font-mono">{a.code}</span>
                {' · '}
                {t('affiliates.terms', { rate: bpToPercent(a.effectiveRateBp), months: a.effectiveMonths ?? '' })}
                {' · '}
                {t('affiliates.referred', { count: a.referredCount })}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('affiliates.totals', { accrued: brl(a.totals.accruedCents), inPayout: brl(a.totals.inPayoutCents), paid: brl(a.totals.paidCents) })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {a.status !== 'active' && (
                  <button type="button" className="modern-button-secondary" disabled={busy === `a${a.id}`} onClick={() => void mudarStatus(a, 'active')}>
                    <Icon name="check" size={16} />
                    {t(a.status === 'pending' ? 'affiliates.approve' : 'affiliates.reactivate')}
                  </button>
                )}
                {a.status === 'active' && (
                  <button type="button" className="modern-button-secondary" disabled={busy === `a${a.id}`} onClick={() => void mudarStatus(a, 'suspended')}>
                    <Icon name="lock" size={16} />
                    {t('affiliates.suspend')}
                  </button>
                )}
                {a.signupUrl && (
                  <button
                    type="button"
                    className="modern-button-secondary"
                    onClick={() => void copiar(a.signupUrl as string).then((ok) => (ok ? toast.success(t('affiliates.linkCopied')) : window.prompt(t('affiliates.copyLink'), a.signupUrl ?? '')))}
                  >
                    <Icon name="copy" size={16} />
                    {t('affiliates.copyLink')}
                  </button>
                )}
                <button type="button" className="modern-button-secondary" disabled={busy === `a${a.id}`} onClick={() => void linkDeSenha(a)}>
                  <Icon name="unlock" size={16} />
                  {t('affiliates.passwordLink')}
                </button>
                <button
                  type="button"
                  className="modern-button-secondary"
                  onClick={() => { setEditing(a.id); setForm(formDe(a)); setFormErro(null) }}
                >
                  <Icon name="edit" size={16} />
                  {t('common.edit')}
                </button>
                <button type="button" className="modern-button-secondary" aria-expanded={openId === a.id} onClick={() => void abrirDetalhe(a.id)}>
                  <Icon name={openId === a.id ? 'chevron-down' : 'chevron-right'} size={16} />
                  {t('common.details')}
                </button>
              </div>
              {openId === a.id && (
                <div className="mt-4 space-y-4">
                  {!detail ? (
                    <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
                  ) : (
                    <Fragment>
                      <div>
                        <h4 className="mb-2 text-sm font-semibold">{t('affiliates.referrals')}</h4>
                        {!detail.referrals.length ? (
                          <p className="text-sm text-muted-foreground">{t('affiliatePortal.noReferrals')}</p>
                        ) : (
                          <ul className="space-y-1 text-sm">
                            {detail.referrals.map((r) => (
                              <li key={r.tenantId} className="flex flex-wrap justify-between gap-2">
                                <span className="wrap-break-word">{r.name} <span className="text-muted-foreground">({r.slug})</span></span>
                                <span className="text-muted-foreground">
                                  {t('affiliates.window', { date: displayDate(r.windowEndsAt) ?? '—' })} · {brl(r.commissionCents)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div>
                        <h4 className="mb-2 text-sm font-semibold">{t('affiliates.commissions')}</h4>
                        {!detail.commissions.length ? (
                          <p className="text-sm text-muted-foreground">{t('affiliatePortal.noCommissions')}</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="modern-table">
                              <tbody>
                                {detail.commissions.map((c) => (
                                  <tr key={c.id}>
                                    <td>{displayDate(c.accruedAt) ?? '—'}</td>
                                    <td className="wrap-break-word">{c.kind === 'clawback' ? t('affiliates.kind.clawback') : c.providerName}</td>
                                    <td>{brl(c.baseCents ?? 0)} × {bpToPercent(c.rateBp)}%</td>
                                    <td className="font-semibold">{brl(c.amountCents)}</td>
                                    <td><span className={affiliateBadgeClass(c.status)}>{t(COMMISSION_STATUS_KEYS[c.status])}</span></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </Fragment>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="section-heading">{t('affiliates.payouts.title')}</h3>
            <p className="section-description">{t('affiliates.payouts.description')}</p>
          </div>
          <button type="button" className="modern-button-secondary" disabled={busy === 'montar'} onClick={() => void montar()}>
            <Icon name="invoice" size={17} />
            {t('affiliates.payouts.build')}
          </button>
        </div>
        {!payouts.length ? (
          <p className="text-sm text-muted-foreground">{t('affiliates.payouts.empty')}</p>
        ) : (
          <ul className="space-y-3">
            {payouts.map((p) => {
              const pode = payoutActions(p)
              const ocupado = busy === `p${p.id}`
              return (
                <li key={p.id} className="modern-card min-w-0 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="wrap-break-word font-semibold">{p.affiliateName ?? `#${p.affiliateId}`} · {p.period}</p>
                      <p className="text-sm text-muted-foreground">
                        {brl(p.amountCents)} · {t('affiliates.payouts.count', { count: p.commissionCount })}
                        {p.pixKeyType ? ` · Pix ${p.pixKeyType}` : ''}
                      </p>
                    </div>
                    <span className={affiliateBadgeClass(p.status)}>{t(PAYOUT_STATUS_KEYS[p.status])}</span>
                  </div>
                  {pode.reapprove && <p className="mt-2 text-sm text-destructive">{t('affiliates.payouts.pixKeyChanged')}</p>}
                  {p.error && <p className="mt-2 break-all text-sm text-destructive">{p.error}</p>}
                  {p.paidNote && <p className="mt-2 wrap-break-word text-sm text-muted-foreground">{p.paidNote}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {pode.approve && (
                      <button type="button" className="modern-button" disabled={ocupado} onClick={() => void acao(p, 'approve')}>
                        <Icon name="check" size={16} />{t('affiliates.payouts.approve')}
                      </button>
                    )}
                    {(pode.send || pode.retry) && (
                      <button type="button" className="modern-button" disabled={ocupado} onClick={() => void acao(p, 'send')}>
                        <Icon name="forward" size={16} />{t(pode.retry ? 'affiliates.payouts.retry' : 'affiliates.payouts.send')}
                      </button>
                    )}
                    {pode.refresh && (
                      <button type="button" className="modern-button-secondary" disabled={ocupado} onClick={() => void acao(p, 'refresh')}>
                        <Icon name="refresh" size={16} />{t('affiliates.payouts.refresh')}
                      </button>
                    )}
                    {pode.markPaid && (
                      <button type="button" className="modern-button-secondary" disabled={ocupado} onClick={() => void acao(p, 'mark-paid')}>
                        <Icon name="invoice" size={16} />{t('affiliates.payouts.markPaid')}
                      </button>
                    )}
                    {pode.cancel && (
                      <button type="button" className="modern-button-secondary" disabled={ocupado} onClick={() => void acao(p, 'cancel')}>
                        <Icon name="x" size={16} />{t('affiliates.payouts.cancel')}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
