import type { ApiResponse, PendingPlan, SubscriptionStatus, SubscriptionView, TenantChargeView, TenantPlanOption } from '@/lib/api'
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
  return limitDetail('plan.options.overLimit', res)
}

/**
 * A descida agendada que não vai se aplicar enquanto o uso passar de um teto do
 * plano novo — lida com os mesmos números do `over_limit`. Nulo sem bloqueio,
 * ou com o bloqueio incompleto.
 */
export function pendingBlockedDetail(pending: Pick<PendingPlan, 'blockedBy'> | null | undefined) {
  if (!pending?.blockedBy) return null
  return limitDetail('plan.pending.blocked', pending.blockedBy)
}

function limitDetail(key: TranslationKey, info: { resource?: string; used?: number; limit?: number }) {
  const resource = info.resource as PlanResource | undefined
  if (!resource || !PLAN_RESOURCES.includes(resource)) return null
  if (typeof info.used !== 'number' || typeof info.limit !== 'number') return null
  return { key, resourceKey: RESOURCE_KEYS[resource], used: info.used, limit: info.limit }
}

/**
 * Os estados em que a assinatura aceita troca de plano e "pagar agora". Com
 * ela suspensa ou cancelada — ou sem assinatura — o backend responde 409 às
 * duas coisas: é decisão da plataforma, e um botão que sempre falha é pior do
 * que botão nenhum.
 */
const CHANGEABLE_STATUSES = new Set<SubscriptionStatus>(['trial', 'active', 'past_due'])

export function subscriptionAllowsChanges(subscription: Pick<SubscriptionView, 'status'> | null | undefined) {
  return Boolean(subscription && CHANGEABLE_STATUSES.has(subscription.status))
}

/**
 * A descida agendada já foi paga pelo preço menor: não se cancela nem se
 * substitui mais até se aplicar (o backend responderia `pending_locked`).
 */
export function isPendingLocked(pending: Pick<PendingPlan, 'locked'> | null | undefined) {
  return pending?.locked === true
}

/**
 * O botão "Mudar para este plano": só em quem escreve, com a assinatura num
 * estado que aceita troca, nunca no plano atual, nunca no que já está agendado
 * — pedir de novo o mesmo agendamento não muda nada, e o cancelamento tem o
 * botão próprio — e em nenhum plano enquanto o agendamento estiver travado.
 */
export function canSwitchTo(
  plan: TenantPlanOption,
  canWrite: boolean,
  subscription: Pick<SubscriptionView, 'status' | 'pendingPlan'> | null | undefined
) {
  if (!canWrite || plan.current || !subscriptionAllowsChanges(subscription)) return false
  const pending = subscription?.pendingPlan ?? null
  if (isPendingLocked(pending)) return false
  return plan.id !== pending?.id
}

/** O botão "Cancelar agendamento": quem escreve, com agendamento que ainda não foi pago. */
export function canCancelPending(
  pending: Pick<PendingPlan, 'locked'> | null | undefined,
  canWrite: boolean
) {
  return canWrite && Boolean(pending) && !isPendingLocked(pending)
}

export type PlanChangeKind = 'upgrade' | 'downgrade-now' | 'downgrade-scheduled' | 'same'

/**
 * O que a troca para `target` vai fazer, pela mesma regra do backend: subir de
 * preço vale na hora; descer vale na renovação quando a assinatura está
 * `active` e a renovação ainda não chegou, e na hora no teste, no atraso ou sem
 * data de renovação. Preço igual é tratado como subida — vale na hora.
 *
 * É só para a frase da confirmação: quem decide é o servidor, e o `message`
 * da resposta é o que a tela mostra depois.
 */
export function planChangeKind(
  current: Pick<TenantPlanOption, 'id' | 'priceCents'> | null | undefined,
  target: Pick<TenantPlanOption, 'id' | 'priceCents'>,
  subscription: Pick<SubscriptionView, 'status' | 'renewsAt'> | null | undefined,
  now: number = Date.now()
): PlanChangeKind {
  if (current && current.id === target.id) return 'same'
  if (!current || target.priceCents >= current.priceCents) return 'upgrade'
  const renova = subscription?.renewsAt ? new Date(subscription.renewsAt).getTime() : Number.NaN
  if (subscription?.status === 'active' && !Number.isNaN(renova) && renova > now) return 'downgrade-scheduled'
  return 'downgrade-now'
}

/** A chave da confirmação de cada tipo de troca. */
export function confirmKey(kind: Exclude<PlanChangeKind, 'same'>): TranslationKey {
  if (kind === 'downgrade-scheduled') return 'plan.options.confirmScheduled'
  if (kind === 'downgrade-now') return 'plan.options.confirmDowngradeNow'
  return 'plan.options.confirm'
}

/**
 * "Pagar agora" só faz sentido com plano pago: no grátis o backend responderia
 * `free_plan`, e um botão que sempre falha é pior do que botão nenhum. Sem a
 * lista (ainda carregando, ou sem plano atual nela), não mostra. Nem com a
 * assinatura suspensa, cancelada, ausente ou isenta de cobrança — o backend
 * responde 409.
 */
export function canPayNow(
  plans: TenantPlanOption[] | null | undefined,
  canWrite: boolean,
  subscription: Pick<SubscriptionView, 'status' | 'billingExempt'> | null | undefined
) {
  return canWrite && subscriptionAllowsChanges(subscription) && !isBillingExempt(subscription)
    && currentPlanIsPaid(plans)
}

/**
 * A plataforma isentou esta assinatura de cobrança: fica ativa, não vence e não
 * gera fatura até ser desligada. Some o "pagar agora" e o aviso de vencimento.
 * Campo ausente (servidor antigo) é não isento.
 */
export function isBillingExempt(subscription: Pick<SubscriptionView, 'billingExempt'> | null | undefined) {
  return subscription?.billingExempt === true
}

/** O 409 `billing_exempt` do "pagar agora": não há o que pagar. */
export function isBillingExemptRefusal(code: string | undefined) {
  return code === 'billing_exempt'
}

function currentPlanIsPaid(plans: TenantPlanOption[] | null | undefined) {
  const atual = plans?.find((p) => p.current)
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
 * `pending_locked`: a descida agendada já foi paga e não se mexe mais até se
 * aplicar. Como o `busy`, não é falha da tela — mostra a frase do servidor e
 * reabilita os botões.
 */
export function isPendingLockedRefusal(code: string | undefined) {
  return code === 'pending_locked'
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
  /** Isento de cobrança não tem fatura a gerar (o backend responde `billing_exempt`). */
  billingExempt?: boolean
}) {
  if (!PAYABLE_GATE_CODES.has(opts.code)) return false
  if (opts.billingExempt) return false
  if (opts.paymentUrl || !opts.chargesLoaded) return false
  // O código já garante um estado que se paga (atraso ou teste vencido).
  return opts.canWrite && currentPlanIsPaid(opts.plans)
}
