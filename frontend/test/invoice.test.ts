import { describe, expect, it } from 'vitest'
import {
  canIssueInvoice,
  canIssueInvoiceForEvent,
  invoiceBadgeClass,
  invoiceStatusKey
} from '@/lib/invoice'

describe('canIssueInvoice', () => {
  it('só para a cobrança paga pelo gateway', () => {
    expect(canIssueInvoice({ status: 'paid', gatewayChargeId: 'pay_1' })).toBe(true)
    expect(canIssueInvoice({ status: 'pending', gatewayChargeId: 'pay_1' })).toBe(false)
    expect(canIssueInvoice({ status: 'refunded', gatewayChargeId: 'pay_1' })).toBe(false)
    expect(canIssueInvoice({ status: 'paid', gatewayChargeId: null })).toBe(false)
  })

  it('reemite só a nota com erro ou cancelada', () => {
    const base = { status: 'paid', gatewayChargeId: 'pay_1' }
    expect(canIssueInvoice({ ...base, invoice: { status: 'error' } })).toBe(true)
    expect(canIssueInvoice({ ...base, invoice: { status: 'canceled' } })).toBe(true)
    expect(canIssueInvoice({ ...base, invoice: { status: 'pending' } })).toBe(false)
    expect(canIssueInvoice({ ...base, invoice: { status: 'scheduled' } })).toBe(false)
    expect(canIssueInvoice({ ...base, invoice: { status: 'authorized' } })).toBe(false)
  })
})

describe('canIssueInvoiceForEvent', () => {
  it('só no pagamento que tem cobrança', () => {
    expect(canIssueInvoiceForEvent({ type: 'payment.recorded', chargeId: 3 })).toBe(true)
    expect(canIssueInvoiceForEvent({ type: 'payment.recorded', chargeId: null })).toBe(false)
    expect(canIssueInvoiceForEvent({ type: 'plan.changed', chargeId: 3 })).toBe(false)
    expect(canIssueInvoiceForEvent({ type: 'payment.recorded', chargeId: 3, invoice: { status: 'authorized' } })).toBe(false)
  })
})

describe('rótulos', () => {
  it('conhece os cinco estados e devolve nulo para um desconhecido', () => {
    expect(invoiceStatusKey('authorized')).toBe('nfse.status.authorized')
    expect(invoiceStatusKey('novo')).toBeNull()
    expect(invoiceBadgeClass('authorized')).toBe('modern-badge-success')
    expect(invoiceBadgeClass('error')).toBe('modern-badge-error')
    expect(invoiceBadgeClass('scheduled')).toBe('modern-badge-warning')
  })
})
