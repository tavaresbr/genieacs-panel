import type { AddonPayload, AddonView, TenantAddonOption } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import { parseAmountToCents } from '@/lib/utils'

/**
 * As peças puras dos add-ons pagos (0126): o estado de um cartão da tela de
 * Plano, o que ele oferece fazer e o formulário do catálogo no console. Fora
 * dos componentes para os testes fixarem sem React.
 */

/** O estado de um add-on para o provedor. */
export type AddonState = 'available' | 'active' | 'cancelScheduled' | 'free' | 'unavailable'

export function addonState(option: Pick<TenantAddonOption, 'subscription' | 'available'>): AddonState {
  const linha = option.subscription
  if (linha && linha.status === 'active') {
    if (linha.free) return 'free'
    if (linha.cancelAt) return 'cancelScheduled'
    return 'active'
  }
  return option.available ? 'available' : 'unavailable'
}

export const ADDON_STATE_KEYS: Record<AddonState, TranslationKey> = {
  available: 'addons.state.available',
  active: 'addons.state.active',
  cancelScheduled: 'addons.state.cancelScheduled',
  free: 'addons.state.free',
  unavailable: 'addons.state.unavailable'
}

export function addonStateBadge(state: AddonState): string {
  if (state === 'active' || state === 'free') return 'modern-badge-success'
  if (state === 'cancelScheduled') return 'modern-badge-warning'
  return 'modern-badge'
}

/** O botão do cartão: ativar, reativar (desfaz o agendamento), cancelar na renovação — ou nenhum. */
export function addonAction(state: AddonState): 'activate' | 'reactivate' | 'cancel' | null {
  if (state === 'available') return 'activate'
  if (state === 'cancelScheduled') return 'reactivate'
  if (state === 'active') return 'cancel'
  return null
}

/** Os códigos de recusa que a tela traduz; o resto mostra a frase do servidor. */
export const ADDON_REFUSAL_KEYS: Record<string, TranslationKey> = {
  addon_not_found: 'addons.error.notFound',
  paid_plan_required: 'addons.error.paidPlanRequired',
  not_changeable: 'addons.error.notChangeable',
  busy: 'addons.error.busy'
}

/** O formulário do catálogo no console, como texto digitado. */
export interface AddonForm {
  code: string
  name: string
  description: string
  price: string
  priceYearly: string
  kind: 'feature' | 'limit'
  feature: string
  limitResource: 'operators' | 'subscribers' | 'devices'
  limitAmount: string
  gated: boolean
  trialAccess: boolean
  active: boolean
  public: boolean
  sort: string
}

export const EMPTY_ADDON_FORM: AddonForm = {
  code: '',
  name: '',
  description: '',
  price: '',
  priceYearly: '',
  kind: 'feature',
  feature: '',
  limitResource: 'operators',
  limitAmount: '',
  gated: false,
  trialAccess: true,
  active: true,
  public: true,
  sort: '0'
}

/** O formulário preenchido com um add-on do catálogo, para editar. */
export function addonFormOf(addon: AddonView): AddonForm {
  const reais = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2).replace('.', ','))
  return {
    code: addon.code,
    name: addon.name,
    description: addon.description ?? '',
    price: reais(addon.priceCents),
    priceYearly: reais(addon.priceYearlyCents),
    kind: addon.kind,
    feature: addon.feature ?? '',
    limitResource: addon.limitResource ?? 'operators',
    limitAmount: addon.limitAmount === null ? '' : String(addon.limitAmount),
    gated: addon.gated,
    trialAccess: addon.trialAccess,
    active: addon.active,
    public: addon.public,
    sort: String(addon.sort)
  }
}

/**
 * O corpo da criação (ou, com `editing`, da edição — só o que pode mudar), ou
 * a chave do erro do formulário.
 */
export function addonPayloadFrom(form: AddonForm, { editing = false } = {}): { payload: AddonPayload } | { error: TranslationKey } {
  const preco = parseAmountToCents(form.price)
  if (preco === null) return { error: 'platform.addons.form.invalidPrice' }
  let anual: number | null = null
  if (form.priceYearly.trim()) {
    anual = parseAmountToCents(form.priceYearly)
    if (anual === null) return { error: 'platform.addons.form.invalidPrice' }
  }
  if (!form.name.trim()) return { error: 'platform.addons.form.nameRequired' }
  const ordem = Number(form.sort || '0')
  const comum: AddonPayload = {
    name: form.name.trim(),
    description: form.description.trim() || null,
    priceCents: preco,
    priceYearlyCents: anual,
    gated: form.kind === 'feature' ? form.gated : false,
    trialAccess: form.trialAccess,
    active: form.active,
    public: form.public,
    sort: Number.isInteger(ordem) ? ordem : 0
  }
  if (editing) return { payload: comum }
  const code = form.code.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(code)) return { error: 'platform.addons.form.invalidCode' }
  if (form.kind === 'feature') {
    const feature = form.feature.trim().toLowerCase()
    if (!feature) return { error: 'platform.addons.form.featureRequired' }
    return { payload: { ...comum, code, kind: 'feature', feature } }
  }
  const quanto = Number(form.limitAmount)
  if (!Number.isInteger(quanto) || quanto < 1) return { error: 'platform.addons.form.invalidLimit' }
  return { payload: { ...comum, code, kind: 'limit', limitResource: form.limitResource, limitAmount: quanto } }
}
