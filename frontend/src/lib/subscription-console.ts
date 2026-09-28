import type {
  ChargeConsoleView,
  SubscriptionConsoleRow,
  SubscriptionConsoleStatus,
  SubscriptionConsoleSummary
} from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import { parseAmountToCents } from '@/lib/utils'

/**
 * A lógica da aba Assinaturas do console, fora do componente para poder ser
 * testada sem DOM: conta de desconto, quais botões uma cobrança oferece,
 * filtro da lista e os rótulos do resumo.
 */

export type ChargeStatus = ChargeConsoleView['status']

/**
 * As três situações em que ainda há o que cobrar. `failed` entra porque é a
 * emissão que o gateway recusou: a dívida existe, só não chegou ao cliente.
 */
export const OPEN_CHARGE_STATUSES: readonly ChargeStatus[] = ['pending', 'failed', 'overdue']

export function isChargeOpen(status: ChargeStatus) {
  return OPEN_CHARGE_STATUSES.includes(status)
}

export interface ChargeActions {
  openInvoice: boolean
  copyLink: boolean
  settle: boolean
  changeDueDate: boolean
  changeAmount: boolean
  cancel: boolean
  reissue: boolean
}

/**
 * Quais ações uma cobrança oferece.
 *
 * Tudo o que mexe em dinheiro só vale para a cobrança em aberto — quitar uma
 * paga ou mudar o valor de uma cancelada é pedir ao servidor um 409. Reemitir é
 * o contrário: é justamente o caminho de volta da cancelada e da que falhou.
 * O link da fatura depende de ele existir; a emissão manual não tem página.
 */
export function chargeActions(charge: Pick<ChargeConsoleView, 'status' | 'invoiceUrl'>): ChargeActions {
  const open = isChargeOpen(charge.status)
  const link = open && Boolean(charge.invoiceUrl)
  return {
    openInvoice: link,
    copyLink: link,
    settle: open,
    changeDueDate: open,
    changeAmount: open,
    cancel: open,
    reissue: charge.status === 'canceled' || charge.status === 'failed'
  }
}

export type AmountMode = 'value' | 'discountAmount' | 'discountPercent'

export type AmountResult =
  | { ok: true; amountCents: number }
  | { ok: false; reason: 'invalid' | 'nonPositive' }

/**
 * Lê um percentual digitado: "10", "12,5", "12.5", "10%". Aceita só entre 0 e
 * 100, exclusivos — desconto de 0% não é desconto e de 100% zera a cobrança.
 *
 * É percentual e não dinheiro, por isso não passa por `parseAmountToCents`:
 * aqui não existe separador de milhar para confundir com o decimal.
 */
export function parsePercent(digitado: string): number | null {
  const texto = String(digitado ?? '').trim().replace(/%$/, '').trim().replace(/,/, '.')
  if (!/^\d+(\.\d+)?$/.test(texto)) return null
  const valor = Number(texto)
  return Number.isFinite(valor) ? valor : null
}

/**
 * O novo valor de uma cobrança, a partir do que foi digitado em um dos três
 * modos: valor novo, desconto em reais ou desconto em percentual.
 *
 * Arredonda para o centavo mais próximo (10% de R$ 99,99 dá R$ 89,99, não
 * 89,991) e nunca devolve zero nem negativo: uma cobrança de R$ 0 não é uma
 * cobrança, é um cancelamento com outro nome, e para isso há o botão certo.
 */
export function computeChargeAmount(baseCents: number, mode: AmountMode, digitado: string): AmountResult {
  if (mode === 'value') {
    const cents = parseAmountToCents(digitado)
    if (cents === null) return { ok: false, reason: 'invalid' }
    return cents > 0 ? { ok: true, amountCents: cents } : { ok: false, reason: 'nonPositive' }
  }
  if (mode === 'discountAmount') {
    const desconto = parseAmountToCents(digitado)
    if (desconto === null || desconto <= 0) return { ok: false, reason: 'invalid' }
    const cents = baseCents - desconto
    return cents > 0 ? { ok: true, amountCents: cents } : { ok: false, reason: 'nonPositive' }
  }
  const pct = parsePercent(digitado)
  if (pct === null || pct <= 0) return { ok: false, reason: 'invalid' }
  if (pct >= 100) return { ok: false, reason: 'nonPositive' }
  const cents = Math.round(baseCents * (1 - pct / 100))
  return cents > 0 ? { ok: true, amountCents: cents } : { ok: false, reason: 'nonPositive' }
}

/** Centavos no formato em que se digita um valor: "199,90", sem símbolo nem milhar. */
export function centsToInput(cents: number) {
  return (cents / 100).toFixed(2).replace('.', ',')
}

/** O estado de uma linha; o provedor sem assinatura é `none`. */
export function rowStatus(row: Pick<SubscriptionConsoleRow, 'subscription'>): SubscriptionConsoleStatus {
  return row.subscription?.status ?? 'none'
}

export interface RowFilter {
  /** Vazio é "todos". */
  statuses: readonly SubscriptionConsoleStatus[]
  onlyOpenCharge: boolean
  search: string
}

/** Minúsculas e sem acento: "Sao Joao" acha "São João". */
export function normalizeSearch(texto: string) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** A busca olha o nome e o slug do provedor. */
export function filterRows<T extends Pick<SubscriptionConsoleRow, 'tenant' | 'subscription' | 'openCharge'>>(
  rows: readonly T[],
  filter: RowFilter
): T[] {
  const termo = normalizeSearch(filter.search)
  return rows.filter((row) => {
    if (filter.statuses.length > 0 && !filter.statuses.includes(rowStatus(row))) return false
    if (filter.onlyOpenCharge && !row.openCharge) return false
    if (termo) {
      const alvo = normalizeSearch(`${row.tenant.name} ${row.tenant.slug}`)
      if (!alvo.includes(termo)) return false
    }
    return true
  })
}

/**
 * A ordem dos cartões do resumo e dos chips do filtro: primeiro quem paga,
 * depois quem ainda pode vir a pagar, e por último quem já não paga.
 */
export const CONSOLE_STATUS_ORDER: readonly SubscriptionConsoleStatus[] = [
  'active', 'trial', 'past_due', 'suspended', 'canceled', 'none'
]

export const CONSOLE_STATUS_LABEL_KEYS: Record<SubscriptionConsoleStatus, TranslationKey> = {
  active: 'platform.subs.status.active',
  trial: 'platform.subs.status.trial',
  past_due: 'platform.subs.status.pastDue',
  suspended: 'platform.subs.status.suspended',
  canceled: 'platform.subs.status.canceled',
  none: 'platform.subs.status.none'
}

/** Os cartões de contagem do resumo, na ordem da tela. Estado ausente conta zero. */
export function summaryStatusCards(summary: Pick<SubscriptionConsoleSummary, 'byStatus'> | null) {
  return CONSOLE_STATUS_ORDER.map((status) => ({
    status,
    labelKey: CONSOLE_STATUS_LABEL_KEYS[status],
    count: summary?.byStatus?.[status] ?? 0
  }))
}

export type GatewayBadge =
  | { kind: 'gateway'; name: string }
  | { kind: 'manual' }
  | { kind: 'unlinked'; name: string }

/**
 * Quem cobra este provedor. Sem gateway configurado a cobrança é manual (Pix
 * combinado, boleto do banco). Com gateway mas sem o cliente ligado lá, a
 * emissão automática não tem para quem emitir — é isso que o selo avisa.
 */
export function gatewayBadge(gateway: SubscriptionConsoleRow['gateway']): GatewayBadge {
  const nome = (gateway.gateway ?? '').trim()
  if (!nome || nome.toLowerCase() === 'manual') return { kind: 'manual' }
  const bonito = nome.toLowerCase() === 'asaas' ? 'Asaas' : nome
  return gateway.linked ? { kind: 'gateway', name: bonito } : { kind: 'unlinked', name: bonito }
}

/**
 * Qual prazo a linha mostra: o fim do teste para quem está em teste, a data até
 * a qual está pago para os demais.
 */
export function deadlineOf(subscription: SubscriptionConsoleRow['subscription']) {
  if (!subscription) return null
  if (subscription.storedStatus === 'trial' && subscription.trialEndsAt) {
    return { kind: 'trial' as const, date: subscription.trialEndsAt }
  }
  if (subscription.renewsAt) return { kind: 'paid' as const, date: subscription.renewsAt }
  return null
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

/** Uma data como o `<input type="date">` a quer, no fuso de quem olha. */
export function toIsoDay(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function todayIso(now: Date = new Date()) {
  return toIsoDay(now)
}

/**
 * Lê uma data do backend. "AAAA-MM-DD" puro vira meia-noite LOCAL: o `Date`
 * nativo a leria como meia-noite UTC, e no Brasil o vencimento de 10/10
 * apareceria como 09/10.
 */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null
  const soDia = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = soDia ? new Date(Number(soDia[1]), Number(soDia[2]) - 1, Number(soDia[3])) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDay(value: string | null | undefined) {
  const date = parseDay(value)
  return date ? date.toLocaleDateString() : '—'
}

/** A data de um prazo para preencher um `<input type="date">`, ou vazio. */
export function dayInputValue(value: string | null | undefined) {
  const date = parseDay(value)
  return date ? toIsoDay(date) : ''
}

/**
 * Um dia escolhido no `<input type="date">` como o instante em que o prazo
 * vence: o FIM daquele dia no fuso de quem escolheu. "Pago até 10/10" quer
 * dizer que o dia 10 inteiro está pago; mandar só "2026-10-10" o servidor leria
 * como meia-noite UTC — no Brasil, 21h do dia 9.
 */
export function endOfDayIso(day: string): string | null {
  const date = parseDay(day)
  if (!date) return null
  date.setHours(23, 59, 59, 0)
  return date.toISOString()
}

/** Lê o "+N dias" digitado: inteiro de 1 a 365 (o teto do backend), ou nulo. */
export function parseExtendDays(digitado: string): number | null {
  const texto = String(digitado ?? '').trim()
  if (!/^\d+$/.test(texto)) return null
  const dias = Number(texto)
  return dias >= 1 && dias <= 365 ? dias : null
}

/**
 * A cobrança já venceu? `overdue` é o que o gateway disse; `pending` com o
 * vencimento para trás é o que ele ainda não disse (ou a manual, que ninguém
 * avisa).
 */
export function isChargeLate(charge: Pick<ChargeConsoleView, 'status' | 'dueDate'>, now: Date = new Date()) {
  if (charge.status === 'overdue') return true
  if (charge.status !== 'pending') return false
  const due = charge.dueDate ? dayInputValue(charge.dueDate) : ''
  return due !== '' && due < todayIso(now)
}

export function chargeBadgeClass(status: ChargeStatus) {
  if (status === 'paid') return 'modern-badge-success'
  if (status === 'pending') return 'modern-badge-warning'
  if (status === 'refunded' || status === 'canceled') return 'modern-badge'
  return 'modern-badge-error'
}

export const CHARGE_STATUS_LABEL_KEYS: Record<ChargeStatus, TranslationKey> = {
  pending: 'charges.status.pending',
  paid: 'charges.status.paid',
  canceled: 'charges.status.canceled',
  failed: 'charges.status.failed',
  overdue: 'charges.status.overdue',
  refunded: 'charges.status.refunded'
}
