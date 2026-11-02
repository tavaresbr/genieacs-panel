import type { TranslationKey } from '@/lib/i18n'

/**
 * A exportação para a contabilidade, do lado da tela: o mês padrão (o
 * anterior, em Brasília, como o servidor), o caminho do download, as abas do
 * CSV e a validação da configuração antes de perguntar ao servidor. Quem
 * valida de verdade é o servidor (`accountingExportService`).
 */

export const ACCOUNTING_FORMATS = ['xlsx', 'csv'] as const
export type AccountingFormat = typeof ACCOUNTING_FORMATS[number]

export const ACCOUNTING_SHEETS = ['cobrancas', 'pagamentos', 'estornos', 'creditos', 'nfse', 'resumo'] as const
export type AccountingSheet = typeof ACCOUNTING_SHEETS[number]

export const ACCOUNTING_SHEET_LABELS: Record<AccountingSheet, TranslationKey> = {
  cobrancas: 'platform.accounting.sheet.cobrancas',
  pagamentos: 'platform.accounting.sheet.pagamentos',
  estornos: 'platform.accounting.sheet.estornos',
  creditos: 'platform.accounting.sheet.creditos',
  nfse: 'platform.accounting.sheet.nfse',
  resumo: 'platform.accounting.sheet.resumo'
}

const ISO_MES = /^(\d{4})-(0[1-9]|1[0-2])$/

/** `AAAA-MM` válido. */
export function isValidMonth(value: string): boolean {
  return ISO_MES.test(String(value ?? '').trim())
}

/** O mês de Brasília anterior ao de `now`, como `AAAA-MM` — o padrão do servidor. */
export function previousMonthSp(now: Date = new Date()): string {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit'
  }).formatToParts(now).map((p) => [p.type, p.value]))
  const anterior = new Date(Date.UTC(Number(partes.year), Number(partes.month) - 2, 1))
  return anterior.toISOString().slice(0, 7)
}

/** O caminho do download (sem o `/api`): o XLSX inteiro, ou uma aba em CSV. */
export function accountingExportPath({ month, format, sheet = 'cobrancas' }: {
  month: string
  format: AccountingFormat
  sheet?: AccountingSheet
}): string {
  const query = new URLSearchParams({ month: month.trim(), format })
  if (format === 'csv') query.set('sheet', sheet)
  return `/platform/reports/accounting?${query.toString()}`
}

/** O nome do arquivo quando o servidor não o disse — o mesmo padrão dele. */
export function accountingFallbackFilename(month: string, format: AccountingFormat, sheet: AccountingSheet = 'cobrancas'): string {
  return format === 'xlsx' ? `contabilidade-${month}.xlsx` : `contabilidade-${sheet}-${month}.csv`
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * A configuração antes de salvar: ligado precisa de e-mail, e o e-mail, se
 * houver, tem de parecer um. Devolve a chave da mensagem, ou nulo.
 */
export function validateAccountingDraft(draft: { enabled: boolean; email: string }): TranslationKey | null {
  const email = draft.email.trim()
  if (email && !EMAIL.test(email)) return 'platform.accounting.invalidEmail'
  if (draft.enabled && !email) return 'platform.accounting.emailRequired'
  return null
}

/** A mensagem de uma recusa do servidor (salvar, baixar ou enviar). */
export function accountingErrorKey(code: string | undefined): TranslationKey {
  switch (code) {
    case 'no_destination': return 'platform.accounting.noDestination'
    case 'send_failed': return 'platform.accounting.sendFailed'
    case 'email_required': return 'platform.accounting.emailRequired'
    case 'invalid_email': return 'platform.accounting.invalidEmail'
    case 'invalid_date':
    case 'invalid_range':
    case 'range_too_long': return 'platform.accounting.invalidMonth'
    default: return 'platform.accounting.failed'
  }
}
