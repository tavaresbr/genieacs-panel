import type { TenantChargeStatusFilter, TenantChargeView } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

/**
 * As faturas do provedor na tela de Plano: os rótulos, os filtros e a
 * planilha. Módulo próprio, sem React, porque o vitest roda em `node` e uma
 * decisão dentro do componente seria decisão sem prova.
 */

/** Os filtros de estado que a tela oferece, na ordem do seletor. */
export const CHARGE_STATUS_FILTERS: readonly TenantChargeStatusFilter[] = ['open', 'paid', 'overdue', 'canceled', 'refunded']

export const CHARGE_STATUS_FILTER_KEYS: Record<string, TranslationKey> = {
  open: 'charges.filter.open',
  paid: 'charges.status.paid',
  overdue: 'charges.status.overdue',
  canceled: 'charges.status.canceled',
  refunded: 'charges.status.refunded'
}

/** O nome do que se cobrou: a mensalidade, a pró-rata da subida ou o excedente. */
export const CHARGE_KIND_KEYS: Record<string, TranslationKey> = {
  renewal: 'charges.kind.renewal',
  proration: 'charges.proration',
  overage: 'charges.overage'
}

export function chargeKindKey(kind: string | null | undefined): TranslationKey {
  return CHARGE_KIND_KEYS[kind || 'renewal'] ?? 'charges.kind.renewal'
}

/** O meio do pagamento como o provedor o lê. Desconhecido ou ausente: "não informada". */
export const PAYMENT_METHOD_KEYS: Record<string, TranslationKey> = {
  PIX: 'charges.method.pix',
  BOLETO: 'charges.method.boleto',
  CREDIT_CARD: 'charges.method.creditCard',
  DEBIT_CARD: 'charges.method.debitCard',
  TRANSFER: 'charges.method.transfer',
  DEPOSIT: 'charges.method.deposit',
  MANUAL: 'charges.method.manual'
}

export function paymentMethodKey(method: string | null | undefined): TranslationKey {
  return (method && PAYMENT_METHOD_KEYS[method.toUpperCase()]) || 'charges.method.unknown'
}

/**
 * Os anos do seletor: os que o servidor mandou e o atual (que pode ainda não
 * ter cobrança), sem repetir, do mais recente ao mais antigo.
 */
export function chargeYearOptions(years: readonly number[] | undefined, now = new Date()): number[] {
  const todos = new Set<number>([now.getFullYear(), ...(years ?? []).filter((y) => Number.isInteger(y))])
  return [...todos].sort((a, b) => b - a)
}

/**
 * Uma célula da planilha. O que o Excel leria como fórmula (`=`, `+`, `-`,
 * `@`, também depois de espaço ou quebra de linha, e o TAB/CR no começo) sai
 * com um apóstrofo na frente; um número negativo puro continua número.
 */
export function csvCell(value: unknown): string {
  const text = String(value ?? '')
  const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(text) && !/^-?\d+([.,]\d+)?$/.test(text) ? `'${text}` : text
  return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

const reais = (cents: number | null | undefined) => (Number(cents ?? 0) / 100).toFixed(2)

/** Só o dia, `YYYY-MM-DD`, de uma data do servidor — a planilha é para conta. */
const dia = (value: string | null | undefined) => (value ? String(value).slice(0, 10) : '')

export interface ChargeCsvLabels {
  /** O rótulo do estado (já traduzido). */
  status: (status: string) => string
  /** O rótulo do tipo (já traduzido). */
  kind: (kind: string | null | undefined) => string
  /** O rótulo do meio (já traduzido). */
  method: (method: string | null | undefined) => string
}

/**
 * A planilha das faturas carregadas: separador `;`, com BOM, que é o que o
 * Excel em português abre direto. Valores em unidades da moeda com ponto
 * decimal; datas ISO.
 */
export function tenantChargesCsv(rows: readonly TenantChargeView[], headers: readonly string[], labels: ChargeCsvLabels): string {
  const lines = [headers.map(csvCell).join(';')]
  for (const row of rows) {
    lines.push([
      row.id,
      labels.kind(row.kind),
      dia(row.periodEnd),
      dia(row.dueDate),
      labels.status(row.status),
      row.currency,
      reais(row.amountCents),
      reais(row.earlyDiscountCents),
      reais(row.creditCents),
      row.couponCode ?? '',
      dia(row.paidAt),
      row.paidAt ? labels.method(row.paymentMethod) : '',
      row.invoice?.number ?? ''
    ].map(csvCell).join(';'))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
