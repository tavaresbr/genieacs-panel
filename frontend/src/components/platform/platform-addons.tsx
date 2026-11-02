'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { addonsAPI, type ConsoleAddonView } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { EMPTY_ADDON_FORM, addonFormOf, addonPayloadFrom, type AddonForm } from '@/lib/addons'

/**
 * O catálogo de add-ons pagos no console (0127), na aba Planos: criar, mudar
 * o preço e as portas, ligar a exigência (`gated`) e apagar o que nunca foi
 * contratado. Código, tipo, recurso e teto ficam fixos depois de criados.
 *
 * `gated` desligado é o padrão, e é o que deixa vender o add-on sem tirar o
 * recurso de quem já o usa: ligado, quem não tem o add-on (e não está em
 * teste com acesso) passa a ver o recurso bloqueado.
 */
export function PlatformAddons() {
  const { t } = useTranslation()
  const toast = useToast()
  const ids = useId()
  const [addons, setAddons] = useState<ConsoleAddonView[] | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [form, setForm] = useState<AddonForm>(EMPTY_ADDON_FORM)
  const [editando, setEditando] = useState<number | null>(null)
  const [aberto, setAberto] = useState(false)
  const [salvando, setSalvando] = useState(false)

  const carregar = useCallback(async () => {
    const res = await addonsAPI.catalog()
    if (res.success && res.data) {
      setAddons(res.data.addons)
      setErro(null)
    } else {
      setErro(res.message || t('platform.addons.loadFailed'))
    }
  }, [t])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const fechar = () => {
    setAberto(false)
    setEditando(null)
    setForm(EMPTY_ADDON_FORM)
  }

  // Ligar a porta de um add-on de recurso tira o recurso de quem não o tem:
  // o console avisa quantos provedores ativos perderiam o acesso (a conta do
  // servidor, `gateImpactCount`) e pede confirmação antes de salvar.
  const atual = editando !== null ? addons?.find((a) => a.id === editando) ?? null : null
  const ligandoPorta = form.kind === 'feature' && form.gated && !atual?.gated
  const impacto = ligandoPorta ? (atual?.gateImpactCount ?? null) : null

  const salvar = async (event: React.FormEvent) => {
    event.preventDefault()
    const lido = addonPayloadFrom(form, { editing: editando !== null })
    if ('error' in lido) {
      toast.error(t(lido.error))
      return
    }
    if (impacto !== null && impacto > 0 && !window.confirm(t('platform.addons.form.gatedImpact', { count: impacto }))) return
    setSalvando(true)
    try {
      const res = editando !== null
        ? await addonsAPI.update(editando, lido.payload)
        : await addonsAPI.create(lido.payload)
      if (res.success) {
        toast.success(t('platform.addons.saved'))
        fechar()
        await carregar()
      } else {
        toast.error(res.code === 'addon_code_taken' ? t('platform.addons.codeTaken') : (res.message || t('platform.addons.saveFailed')))
      }
    } finally {
      setSalvando(false)
    }
  }

  const apagar = async (addon: ConsoleAddonView) => {
    if (!window.confirm(t('platform.addons.deleteConfirm', { name: addon.name }))) return
    const res = await addonsAPI.remove(addon.id)
    if (res.success) {
      toast.success(t('platform.addons.deleted'))
      await carregar()
    } else {
      toast.error(res.code === 'addon_in_use' ? t('platform.addons.inUse') : (res.message || t('platform.addons.saveFailed')))
    }
  }

  const campo = (chave: keyof AddonForm) => `${ids}-${chave}`
  const set = <K extends keyof AddonForm>(chave: K, valor: AddonForm[K]) => setForm((f) => ({ ...f, [chave]: valor }))

  return (
    <section className="modern-card mt-6 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-heading">{t('platform.addons.title')}</h2>
        <button
          type="button"
          className={aberto ? 'modern-button-secondary' : 'modern-button'}
          onClick={() => (aberto ? fechar() : setAberto(true))}
        >
          {t(aberto ? 'common.cancel' : 'platform.addons.new')}
        </button>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('platform.addons.subtitle')}</p>

      {aberto && (
        <form onSubmit={(e) => void salvar(e)} className="mt-4 grid grid-cols-1 gap-3 rounded-md border border-border p-4 md:grid-cols-2">
          <div>
            <label htmlFor={campo('code')} className="field-label">{t('platform.addons.form.code')}</label>
            <input id={campo('code')} className="modern-input w-full font-mono" value={form.code} disabled={editando !== null}
              onChange={(e) => set('code', e.target.value.toLowerCase())} autoComplete="off" />
          </div>
          <div>
            <label htmlFor={campo('name')} className="field-label">{t('platform.addons.form.name')}</label>
            <input id={campo('name')} className="modern-input w-full" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label htmlFor={campo('description')} className="field-label">{t('platform.addons.form.description')}</label>
            <input id={campo('description')} className="modern-input w-full" value={form.description}
              onChange={(e) => set('description', e.target.value)} />
          </div>
          <div>
            <label htmlFor={campo('price')} className="field-label">{t('platform.addons.form.price')}</label>
            <input id={campo('price')} className="modern-input w-full" inputMode="decimal" value={form.price}
              onChange={(e) => set('price', e.target.value)} />
          </div>
          <div>
            <label htmlFor={campo('priceYearly')} className="field-label">{t('platform.addons.form.priceYearly')}</label>
            <input id={campo('priceYearly')} className="modern-input w-full" inputMode="decimal" value={form.priceYearly}
              onChange={(e) => set('priceYearly', e.target.value)} placeholder={t('platform.addons.form.priceYearlyHint')} />
          </div>
          <div>
            <label htmlFor={campo('kind')} className="field-label">{t('platform.addons.form.kind')}</label>
            <select id={campo('kind')} className="modern-input w-full" value={form.kind} disabled={editando !== null}
              onChange={(e) => set('kind', e.target.value === 'limit' ? 'limit' : 'feature')}>
              <option value="feature">{t('platform.addons.kind.feature')}</option>
              <option value="limit">{t('platform.addons.kind.limit')}</option>
            </select>
          </div>
          {form.kind === 'feature' ? (
            <div>
              <label htmlFor={campo('feature')} className="field-label">{t('platform.addons.form.feature')}</label>
              <input id={campo('feature')} className="modern-input w-full font-mono" value={form.feature} disabled={editando !== null}
                onChange={(e) => set('feature', e.target.value)} placeholder="whatsapp, ai" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={campo('limitResource')} className="field-label">{t('platform.addons.form.limitResource')}</label>
                <select id={campo('limitResource')} className="modern-input w-full" value={form.limitResource} disabled={editando !== null}
                  onChange={(e) => set('limitResource', e.target.value as AddonForm['limitResource'])}>
                  <option value="operators">{t('platform.addons.resource.operators')}</option>
                  <option value="subscribers">{t('platform.addons.resource.subscribers')}</option>
                  <option value="devices">{t('platform.addons.resource.devices')}</option>
                </select>
              </div>
              <div>
                <label htmlFor={campo('limitAmount')} className="field-label">{t('platform.addons.form.limitAmount')}</label>
                <input id={campo('limitAmount')} className="modern-input w-full" inputMode="numeric" value={form.limitAmount}
                  disabled={editando !== null} onChange={(e) => set('limitAmount', e.target.value)} />
              </div>
            </div>
          )}
          <div>
            <label htmlFor={campo('sort')} className="field-label">{t('platform.addons.form.sort')}</label>
            <input id={campo('sort')} className="modern-input w-full" inputMode="numeric" value={form.sort}
              onChange={(e) => set('sort', e.target.value)} />
          </div>
          <div className="flex flex-col gap-2 md:col-span-2">
            {form.kind === 'feature' && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={form.gated} onChange={(e) => set('gated', e.target.checked)} />
                <span>
                  {t('platform.addons.form.gated')}
                  <span className="block text-xs text-muted-foreground">{t('platform.addons.form.gatedHint')}</span>
                  <span className="block text-xs text-muted-foreground">{t('platform.addons.form.gatedBackground')}</span>
                </span>
              </label>
            )}
            {impacto !== null && (
              <p className="text-sm text-destructive" role="alert" data-testid="addon-gate-impact">
                {t('platform.addons.form.gatedImpact', { count: impacto })}
              </p>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.trialAccess} onChange={(e) => set('trialAccess', e.target.checked)} />
              {t('platform.addons.form.trialAccess')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
              {t('platform.addons.form.active')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.public} onChange={(e) => set('public', e.target.checked)} />
              {t('platform.addons.form.public')}
            </label>
          </div>
          <div className="md:col-span-2">
            <button type="submit" className="modern-button" disabled={salvando}>
              {salvando ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </form>
      )}

      {erro && <p className="mt-3 text-sm text-destructive">{erro}</p>}
      {addons && !addons.length && <p className="mt-3 text-sm text-muted-foreground">{t('platform.addons.empty')}</p>}
      {addons && addons.length > 0 && (
        <ul className="mt-4 divide-y divide-border">
          {addons.map((addon) => (
            <li key={addon.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-foreground">
                  {addon.name} <span className="font-mono text-xs text-muted-foreground">{addon.code}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {addon.kind === 'feature'
                    ? t('platform.addons.featureLine', { feature: addon.feature ?? '' })
                    : t('platform.addons.limitLine', {
                      amount: addon.limitAmount ?? 0,
                      resource: t(`platform.addons.resource.${addon.limitResource ?? 'operators'}`)
                    })}
                  {' · '}
                  {formatMoney(addon.priceCents, addon.currency)}
                  {addon.priceYearlyCents !== null && ` · ${t('platform.addons.yearly', { amount: formatMoney(addon.priceYearlyCents, addon.currency) })}`}
                  {' · '}
                  {t('platform.addons.activeCount', { count: addon.activeCount })}
                </p>
              </div>
              <span className="flex flex-wrap items-center gap-2">
                {addon.gated && <span className="modern-badge-warning">{t('platform.addons.gated')}</span>}
                {!addon.active && <span className="modern-badge">{t('platform.addons.inactive')}</span>}
                {addon.active && !addon.public && <span className="modern-badge">{t('platform.addons.hidden')}</span>}
                <button type="button" className="modern-button-secondary" onClick={() => {
                  setEditando(addon.id)
                  setForm(addonFormOf(addon))
                  setAberto(true)
                }}>
                  {t('common.edit')}
                </button>
                {addon.activeCount === 0 && (
                  <button type="button" className="modern-button-secondary" onClick={() => void apagar(addon)}>
                    {t('common.delete')}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
