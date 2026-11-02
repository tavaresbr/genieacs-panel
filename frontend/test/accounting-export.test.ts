import { describe, expect, it } from 'vitest'

import {
  accountingErrorKey,
  accountingExportPath,
  accountingFallbackFilename,
  isValidMonth,
  previousMonthSp,
  validateAccountingDraft
} from '@/lib/accounting-export'
import { HISTORY_EVENTS, historyEventLabel } from '@/lib/platform-alert-history'

/**
 * A exportação para a contabilidade, do lado da tela: o mês padrão é o
 * anterior em Brasília (como no servidor), o caminho do download leva a aba só
 * no CSV, e a configuração é recusada antes de perguntar quando não tem como
 * chegar a ninguém.
 */
describe('o mês padrão', () => {
  it('é o anterior ao de agora, em Brasília — também na virada', () => {
    expect(previousMonthSp(new Date('2026-11-02T15:00:00Z'))).toBe('2026-10')
    // 1º de novembro às 01:00 UTC ainda é 31 de outubro em Brasília.
    expect(previousMonthSp(new Date('2026-11-01T01:00:00Z'))).toBe('2026-09')
    expect(previousMonthSp(new Date('2027-01-05T12:00:00Z'))).toBe('2026-12')
  })

  it('valida AAAA-MM', () => {
    expect(isValidMonth('2026-10')).toBe(true)
    expect(isValidMonth('2026-13')).toBe(false)
    expect(isValidMonth('')).toBe(false)
    expect(isValidMonth('10/2026')).toBe(false)
  })
})

describe('o download', () => {
  it('o XLSX não leva aba; o CSV leva', () => {
    expect(accountingExportPath({ month: '2026-10', format: 'xlsx', sheet: 'pagamentos' }))
      .toBe('/platform/reports/accounting?month=2026-10&format=xlsx')
    expect(accountingExportPath({ month: '2026-10', format: 'csv', sheet: 'pagamentos' }))
      .toBe('/platform/reports/accounting?month=2026-10&format=csv&sheet=pagamentos')
  })

  it('o nome do arquivo quando o servidor não o disse', () => {
    expect(accountingFallbackFilename('2026-10', 'xlsx')).toBe('contabilidade-2026-10.xlsx')
    expect(accountingFallbackFilename('2026-10', 'csv', 'nfse')).toBe('contabilidade-nfse-2026-10.csv')
  })
})

describe('a configuração', () => {
  it('ligado precisa de e-mail, e o e-mail tem de parecer um', () => {
    expect(validateAccountingDraft({ enabled: true, email: '' })).toBe('platform.accounting.emailRequired')
    expect(validateAccountingDraft({ enabled: false, email: 'não' })).toBe('platform.accounting.invalidEmail')
    expect(validateAccountingDraft({ enabled: true, email: 'contador@escritorio.com.br' })).toBeNull()
    expect(validateAccountingDraft({ enabled: false, email: '' })).toBeNull()
  })

  it('traduz as recusas do servidor', () => {
    expect(accountingErrorKey('no_destination')).toBe('platform.accounting.noDestination')
    expect(accountingErrorKey('send_failed')).toBe('platform.accounting.sendFailed')
    expect(accountingErrorKey('range_too_long')).toBe('platform.accounting.invalidMonth')
    expect(accountingErrorKey(undefined)).toBe('platform.accounting.failed')
  })

  it('a exportação aparece no histórico de alertas', () => {
    expect(HISTORY_EVENTS).toContain('accounting_export')
    expect(historyEventLabel('accounting_export')).toBe('platform.alertHistory.event.accounting')
  })
})
