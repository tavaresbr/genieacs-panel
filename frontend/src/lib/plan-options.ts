import type { ApiResponse, TenantChargeView, TenantPlanOption } from '@/lib/api'
import type { TranslationKey, TranslationVars } from '@/lib/i18n/dictionary'

/**
 * As decisões da tela "Plano e uso" que não dependem de React: qual botão
 * aparece em qual cartão, como se lê o período do preço e o que dizer quando o
 * plano escolhido não comporta o uso atual.
 *
 * Separadas da página para serem testadas sem DOM, e porque o muro do 402 faz
 * a mesma pergunta de "pagar agora" — as duas telas não podem discordar.
 */

/** Os recursos que um plano limita, na ordem em que a tela os lista. */
export const PLAN_RESOURCES = ['operators', 'subscribers', 'devices'] as const
export type PlanResource = (typeof PLAN_RESOURCES)[number]

const RESOURCE_KEYS: Record<PlanResource, TranslationKey> = {
  operators: 'platform.subscription.operators',
  subscribers: 'platform.subscription.subscribers',
  devices: 'platform.subscription.devices'
}

export function resourceLabelKey(resource: PlanResource): TranslationKey {
  return RESOURCE_KEYS[resource]
}

/**
 * O preço lido com o período dele: 30 dias é "por mês", 365 (ou 366) é "por
 * ano", e o resto se diz em dias. Um plano de 30 dias escrito "a cada 30 dias"
 * é correto e estranho; o catálogo aceita qualquer número, então a reserva
 * existe.
 */
export function periodLabel(periodDays: number, price: string): { key: TranslationKey; vars: TranslationVars } {
  if (periodDays === 30) return { key: 'plan.options.perMonth', vars: { price } }
  if (periodDays === 365 || periodDays === 366) return { key: 'plan.options.perYear', vars: { price } }
  return { key: 'plan.options.perDays', vars: { price, days: periodDays } }
}

/**
 * O 409 `over_limit` da troca de plano, lido: qual recurso não cabe, quanto se
 * usa e quanto o plano novo permite. Nulo quando a recusa é outra — ou quando
 * falta um dos números, e aí a tela fica com a frase do servidor, que já vem
 * traduzida.
 */
export function overLimitDetail(res: Pick<ApiResponse, 'code' | 'resource' | 'used' | 'limit'>) {
  if (res.code !== 'over_limit') return null
  if (!res.resource || !PLAN_RESOURCES.includes(res.resource)) return null
  if (typeof res.used !== 'number' || typeof res.limit !== 'number') return null
  return {
    key: 'plan.options.overLimit' as TranslationKey,
    resourceKey: RESOURCE_KEYS[res.resource],
    used: res.used,
    limit: res.limit
  }
}

/** O botão "Mudar para este plano": só em quem escreve, e nunca no plano atual. */
export function canSwitchTo(plan: TenantPlanOption, canWrite: boolean) {
  return canWrite && !plan.current
}

/**
 * "Pagar agora" só faz sentido com plano pago: no grátis o backend responderia
 * `free_plan`, e um botão que sempre falha é pior do que botão nenhum. Sem a
 * lista (ainda carregando, ou sem plano atual nela), não mostra.
 */
export function canPayNow(plans: TenantPlanOption[] | null | undefined, canWrite: boolean) {
  if (!canWrite || !plans) return false
  const atual = plans.find((p) => p.current)
  return Boolean(atual && atual.priceCents > 0)
}

/** As recusas do "pagar agora" que se resolvem no cadastro fiscal desta mesma tela. */
const BILLING_PROFILE_CODES = new Set(['missing_tax_id', 'invalid_tax_id', 'missing_name'])

export function needsBillingProfile(code: string | undefined) {
  return Boolean(code && BILLING_PROFILE_CODES.has(code))
}

/**
 * Gera a cobrança e leva a pessoa ao pagamento numa aba nova.
 *
 * A aba é aberta ANTES do primeiro `await`, de propósito: o navegador só deixa
 * abrir janela dentro do clique, e a resposta do gateway chega depois dele —
 * abrir ali seria bloqueado como pop-up. Então a aba nasce em branco, e recebe
 * o endereço quando ele chega; na recusa, fecha. Tem que ser chamada direto do
 * manipulador do clique, sem nada assíncrono antes.
 *
 * `opener` é zerado à mão porque `noopener` no `window.open` faz ele devolver
 * nulo, e sem a referência não haveria como navegar a aba depois.
 */
export async function payInNewTab(
  payNow: () => Promise<ApiResponse<{ charge: TenantChargeView }>>
): Promise<ApiResponse<{ charge: TenantChargeView }>> {
  let aba: Window | null
  try {
    aba = window.open('', '_blank')
    if (aba) aba.opener = null
  } catch {
    aba = null
  }
  const res = await payNow()
  const url = res.success ? res.data?.charge?.invoiceUrl : null
  if (url) {
    if (aba) aba.location.href = url
    // Bloqueado mesmo assim: tenta de novo; se não abrir, a lista de
    // cobranças recarregada mostra o botão "Pagar" com o mesmo endereço.
    else window.open(url, '_blank', 'noopener,noreferrer')
  } else {
    aba?.close()
  }
  return res
}

/**
 * `busy`: outra troca ou cobrança deste provedor está em andamento no
 * servidor. Não é falha — é "tente de novo em instantes", e a tela mostra a
 * frase do servidor sem o tom de erro.
 */
export function isBusy(code: string | undefined) {
  return code === 'busy'
}

/**
 * Os 402 em que "gerar cobrança e pagar" é a saída: atraso e teste vencido (o
 * período pago vencido chega como `subscription_past_due`, ver
 * `SubscriptionService.decide`). Suspenso e cancelado são decisão da
 * plataforma — pagar não os desfaz — e "sem assinatura" não tem o que cobrar.
 */
const PAYABLE_GATE_CODES = new Set<string>(['subscription_past_due', 'subscription_trial_expired'])

/**
 * O muro do 402 oferece "gerar cobrança e pagar"? Só quando o bloqueio se
 * resolve pagando, não há boleto em aberto (a lista já voltou — sem ela, um
 * segundo boleto poderia nascer), a pessoa escreve nas configurações e o plano
 * atual é pago. Sem o catálogo não se sabe o preço, e aí não oferece: no
 * grátis o backend responderia `free_plan`.
 */
export function canGenerateCharge(opts: {
  code: string
  paymentUrl: string | null
  chargesLoaded: boolean
  canWrite: boolean
  plans: TenantPlanOption[] | null
}) {
  if (!PAYABLE_GATE_CODES.has(opts.code)) return false
  if (opts.paymentUrl || !opts.chargesLoaded) return false
  return canPayNow(opts.plans, opts.canWrite)
}
