import type { BillingCycle, Plan, PlanPriceChange } from '@/lib/api'

/**
 * As contas puras do reajuste de preço com data de vigência (0122), fora do
 * componente para serem testadas sem DOM.
 */

/** A antecedência padrão do aviso, em dias — a mesma do servidor. */
export const DEFAULT_NOTICE_DAYS = 30

/** `YYYY-MM-DD` de `hoje` + `dias`, no calendário local de quem opera. */
export function isoDaysFromToday(dias: number, hoje: Date = new Date()): string {
  const d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + dias)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** O preço de hoje do ciclo, ou nulo quando o plano não o oferece. */
export function currentCyclePrice(plan: Pick<Plan, 'priceCents' | 'priceYearlyCents'>, cycle: BillingCycle): number | null {
  if (cycle === 'annual') return plan.priceYearlyCents != null && plan.priceYearlyCents > 0 ? plan.priceYearlyCents : null
  return plan.priceCents > 0 ? plan.priceCents : null
}

/**
 * Os ciclos cujo preço a edição direta do plano muda — cada um com o preço
 * novo. É o que decide se a tela pede a confirmação com quantos provedores a
 * mudança pega. Tirar o anual (nulo) ou zerar não entra: não é reajuste.
 */
export function directPriceEdits(
  plan: Pick<Plan, 'priceCents' | 'priceYearlyCents'>,
  monthlyCents: number,
  annualCents: number | null
): Array<[BillingCycle, number]> {
  const mudancas: Array<[BillingCycle, number]> = []
  if (monthlyCents > 0 && monthlyCents !== plan.priceCents) mudancas.push(['monthly', monthlyCents])
  if (annualCents !== null && annualCents > 0 && annualCents !== plan.priceYearlyCents) mudancas.push(['annual', annualCents])
  return mudancas
}

/**
 * O reajuste AGENDADO de um ciclo do plano, se há. Com ele, o servidor recusa
 * mudar o preço desse ciclo à mão (409 `price_change_scheduled`): a tela
 * avisa antes de mandar, e aponta o "Cancelar reajuste".
 */
export function scheduledChangeFor(
  plan: Pick<Plan, 'priceChanges'>,
  cycle: BillingCycle
): PlanPriceChange | null {
  return (plan.priceChanges ?? []).find((c) => c.status === 'scheduled' && c.cycle === cycle) ?? null
}
