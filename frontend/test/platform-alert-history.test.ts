import { describe, expect, it } from 'vitest'
import { PLATFORM_ALERT_STATUSES } from '@/lib/api'
import en from '@/lib/i18n/locales/en'
import {
  ALERT_STATUS_BADGE,
  ALERT_STATUS_LABELS,
  EMPTY_HISTORY_FILTERS,
  HISTORY_EVENTS,
  buildHistoryQuery,
  canResend,
  historyErrorKey,
  historyEventLabel,
  pageCount
} from '@/lib/platform-alert-history'

describe('platform alert history', () => {
  it('reenvia só failed/skipped, e nunca o teste', () => {
    expect(canResend({ status: 'failed', event: 'card_refused' })).toBe(true)
    expect(canResend({ status: 'skipped', event: 'digest' })).toBe(true)
    expect(canResend({ status: 'sent', event: 'card_refused' })).toBe(false)
    expect(canResend({ status: 'pending', event: 'card_refused' })).toBe(false)
    expect(canResend({ status: 'failed', event: 'test' })).toBe(false)
  })

  it('a query leva só os filtros preenchidos', () => {
    expect(buildHistoryQuery(EMPTY_HISTORY_FILTERS)).toEqual({ page: 1, pageSize: 25 })
    expect(buildHistoryQuery({ status: 'failed', event: 'digest', from: ' 2026-10-01 ', to: '2026-10-20' }, 3, 10))
      .toEqual({ page: 3, pageSize: 10, status: 'failed', event: 'digest', from: '2026-10-01', to: '2026-10-20' })
    expect(buildHistoryQuery({ ...EMPTY_HISTORY_FILTERS, from: '   ' })).toEqual({ page: 1, pageSize: 25 })
  })

  it('conta as páginas, com ao menos uma', () => {
    expect(pageCount(0, 25)).toBe(1)
    expect(pageCount(25, 25)).toBe(1)
    expect(pageCount(26, 25)).toBe(2)
    expect(pageCount(10, 0)).toBe(1)
  })

  it('cada recusa tem a sua mensagem, e o resto cai no genérico', () => {
    expect(historyErrorKey('invalid_from')).toBe('platform.alertHistory.error.invalidFrom')
    expect(historyErrorKey('invalid_to')).toBe('platform.alertHistory.error.invalidTo')
    expect(historyErrorKey('invalid_range')).toBe('platform.alertHistory.error.invalidRange')
    expect(historyErrorKey('not_resendable')).toBe('platform.alertHistory.error.notResendable')
    expect(historyErrorKey('not_found')).toBe('platform.alertHistory.error.notFound')
    expect(historyErrorKey(undefined)).toBe('platform.alertHistory.loadFailed')
    expect(historyErrorKey('qualquer')).toBe('platform.alertHistory.loadFailed')
  })

  it('todo rótulo existe no dicionário', () => {
    for (const evento of HISTORY_EVENTS) expect(en[historyEventLabel(evento)]).toBeTruthy()
    for (const s of PLATFORM_ALERT_STATUSES) {
      expect(en[ALERT_STATUS_LABELS[s]]).toBeTruthy()
      expect(ALERT_STATUS_BADGE[s]).toBeTruthy()
    }
    expect(HISTORY_EVENTS).toContain('digest')
    expect(HISTORY_EVENTS).toContain('test')
    expect(HISTORY_EVENTS).toContain('monthly_report')
    expect(en['platform.alertHistory.page']).toContain('{page}')
    expect(en['platform.alertHistory.resentDigest']).toContain('{count}')
  })
})
