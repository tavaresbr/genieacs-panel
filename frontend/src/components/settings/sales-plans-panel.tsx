'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type SalesPlan, type SalesPlanInput, type SalesPlanProfile } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { formatMoney } from '@/lib/money'
import { parseAmountToCents } from '@/lib/utils'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

const PROFILES: SalesPlanProfile[] = ['economico', 'equilibrado', 'premium']
const PROFILE_KEY: Record<SalesPlanProfile, TranslationKey> = {
  economico: 'settings.chatbot.profileEconomico',
  equilibrado: 'settings.chatbot.profileEquilibrado',
  premium: 'settings.chatbot.profilePremium'
}
const PROFILE_CLASS: Record<SalesPlanProfile, string> = {
  economico: 'modern-badge-success',
  equilibrado: 'modern-badge-info',
  premium: 'modern-badge-warning'
}

interface Rascunho {
  id: number | null
  name: string
  speed: string
  price: string
  includes: string
  profile: SalesPlanProfile
  active: boolean
}

const vazio = (): Rascunho => ({ id: null, name: '', speed: '', price: '', includes: '', profile: 'equilibrado', active: true })

const doPlano = (plano: SalesPlan): Rascunho => ({
  id: plano.id,
  name: plano.name,
  speed: plano.speedMbps === null ? '' : String(plano.speedMbps),
  price: plano.priceCents === null ? '' : (plano.priceCents / 100).toFixed(2).replace('.', ','),
  includes: plano.includes,
  profile: plano.profile,
  active: plano.active
})

/** O catálogo de planos que a IA de vendas oferece (no máximo 2 por conversa). */
export function SalesPlansPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [planos, setPlanos] = useState<SalesPlan[] | null>(null)
  const [rascunho, setRascunho] = useState<Rascunho | null>(null)
  const [busy, setBusy] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Abrir o formulário leva a tela até ele e põe o cursor no nome: sem isso, quem edita um
  // plano do meio de uma lista longa não vê nada acontecer.
  const abertoId = rascunho === null ? undefined : (rascunho.id ?? 'novo')
  useEffect(() => {
    if (abertoId === undefined) return
    formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    nameRef.current?.focus({ preventScroll: true })
  }, [abertoId])

  const carregar = useCallback(async () => {
    const res = await whatsappAPI.listSalesPlans()
    if (res.success && res.data) setPlanos(res.data)
    else toast.error(res.message || t('settings.chatbot.plansLoadFailed'))
  }, [t, toast])

  useEffect(() => { void carregar() }, [carregar])

  const salvar = async () => {
    if (!rascunho) return
    // Vazio é "sem preço" (a IA não oferece); algo que não se lê sem adivinhar é erro.
    const priceCents = rascunho.price.trim() ? parseAmountToCents(rascunho.price) : null
    if (rascunho.price.trim() && priceCents === null) { toast.error(t('settings.chatbot.plansPriceInvalid')); return }
    const input: SalesPlanInput = {
      name: rascunho.name,
      speedMbps: rascunho.speed.trim() ? Number(rascunho.speed) : null,
      priceCents,
      includes: rascunho.includes,
      profile: rascunho.profile,
      active: rascunho.active
    }
    setBusy(true)
    const res = rascunho.id === null ? await whatsappAPI.createSalesPlan(input) : await whatsappAPI.updateSalesPlan(rascunho.id, input)
    setBusy(false)
    if (res.success) {
      toast.success(t('settings.chatbot.plansSaved'))
      setRascunho(null)
      await carregar()
    } else toast.error(res.message || whatsappErrorMessage(t, res.code))
  }

  const apagar = async (plano: SalesPlan) => {
    if (!window.confirm(t('settings.chatbot.plansDeleteConfirm', { name: plano.name }))) return
    const res = await whatsappAPI.deleteSalesPlan(plano.id)
    if (res.success) { toast.success(t('settings.chatbot.plansDeleted')); await carregar() }
    else toast.error(res.message || whatsappErrorMessage(t, res.code))
  }

  const importar = async () => {
    setBusy(true)
    const res = await whatsappAPI.importSalesPlansFromSgp()
    setBusy(false)
    if (res.success) { toast.success(res.message || t('settings.chatbot.plansSaved')); await carregar() }
    else toast.error(res.message || whatsappErrorMessage(t, res.code))
  }

  const patch = (parte: Partial<Rascunho>) => setRascunho((atual) => (atual ? { ...atual, ...parte } : atual))

  const formulario = rascunho ? (
    <form
      ref={formRef}
      className="grid gap-4 rounded-md border border-border p-4"
      onSubmit={(event) => { event.preventDefault(); void salvar() }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="plan-name" className="field-label">{t('settings.chatbot.plansName')}</label>
          <input id="plan-name" ref={nameRef} className="modern-input w-full" maxLength={80} required value={rascunho.name} onChange={(e) => patch({ name: e.target.value })} />
        </div>
        <div>
          <label htmlFor="plan-profile" className="field-label">{t('settings.chatbot.plansProfile')}</label>
          <select id="plan-profile" className="modern-input w-full" value={rascunho.profile} onChange={(e) => patch({ profile: e.target.value as SalesPlanProfile })}>
            {PROFILES.map((p) => <option key={p} value={p}>{t(PROFILE_KEY[p])}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="plan-speed" className="field-label">{t('settings.chatbot.plansSpeed')}</label>
          <input id="plan-speed" className="modern-input w-full" inputMode="numeric" value={rascunho.speed} onChange={(e) => patch({ speed: e.target.value.replace(/\D/g, '') })} />
        </div>
        <div>
          <label htmlFor="plan-price" className="field-label">{t('settings.chatbot.plansPrice')}</label>
          <input id="plan-price" className="modern-input w-full" inputMode="decimal" placeholder="89,90" value={rascunho.price} onChange={(e) => patch({ price: e.target.value })} />
        </div>
      </div>
      <div>
        <label htmlFor="plan-includes" className="field-label">{t('settings.chatbot.plansIncludes')}</label>
        <input id="plan-includes" className="modern-input w-full" maxLength={300} value={rascunho.includes} onChange={(e) => patch({ includes: e.target.value })} />
        <p className="field-hint">{t('settings.chatbot.plansIncludesHint')}</p>
      </div>
      <label className="flex min-h-10 cursor-pointer items-center gap-3 lg:min-h-0">
        <input type="checkbox" className="h-5 w-5 accent-[hsl(var(--primary))]" checked={rascunho.active} onChange={(e) => patch({ active: e.target.checked })} />
        <span className="text-sm">{t('settings.chatbot.plansActive')}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="modern-button" disabled={busy}>{t('settings.chatbot.plansSave')}</button>
        <button type="button" className="modern-button-secondary" onClick={() => setRascunho(null)}>{t('common.cancel')}</button>
      </div>
    </form>
  ) : null

  return (
    <section className="modern-card p-5 sm:p-6" aria-labelledby="sales-plans-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="sales-plans-title" className="section-heading">{t('settings.chatbot.plansTitle')}</h2>
          <p className="field-hint mt-1">{t('settings.chatbot.plansIntro')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => void importar()}>
            {t('settings.chatbot.plansImport')}
          </button>
          <button type="button" className="modern-button" disabled={busy} onClick={() => setRascunho(vazio())}>
            {t('settings.chatbot.plansAdd')}
          </button>
        </div>
      </div>

      {rascunho?.id === null && <div className="mt-4">{formulario}</div>}

      {planos !== null && planos.length === 0 && (
        <p className="mt-4 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3 text-sm text-muted-foreground">
          {t('settings.chatbot.plansEmpty')}
        </p>
      )}

      {planos !== null && planos.length > 0 && (
        <ul className="mt-4 divide-y divide-border">
          {planos.map((plano) => {
            const semPreco = plano.priceCents === null || plano.priceCents <= 0
            if (rascunho?.id === plano.id) return <li key={plano.id} className="py-3">{formulario}</li>
            return (
              <li key={plano.id} className={`flex flex-wrap items-center justify-between gap-3 py-3 ${plano.active ? '' : 'opacity-50'}`}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span className="wrap-anywhere">{plano.name}</span>
                    <span className={`${PROFILE_CLASS[plano.profile]} whitespace-nowrap text-xs`}>{t(PROFILE_KEY[plano.profile])}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {plano.speedMbps ? `${t('settings.chatbot.plansMbps', { n: String(plano.speedMbps) })} · ` : ''}
                    {semPreco
                      ? <span className="text-[hsl(var(--warning))]">{t('settings.chatbot.plansNoPrice')}</span>
                      : formatMoney(plano.priceCents, 'BRL')}
                  </p>
                  {plano.includes && <p className="field-hint wrap-anywhere">{plano.includes}</p>}
                </div>
                <div className="flex gap-2">
                  <button type="button" className="modern-button-secondary" onClick={() => setRascunho(doPlano(plano))}>{t('settings.chatbot.plansEdit')}</button>
                  <button type="button" className="modern-button-secondary" onClick={() => void apagar(plano)}>{t('settings.chatbot.plansDelete')}</button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

    </section>
  )
}

export default SalesPlansPanel
