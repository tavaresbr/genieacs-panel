import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TenantPlanOption } from '@/lib/api'
import {
  canGenerateCharge,
  canPayNow,
  canSwitchTo,
  isBusy,
  needsBillingProfile,
  overLimitDetail,
  payInNewTab,
  periodLabel
} from '@/lib/plan-options'

const plano = (over: Partial<TenantPlanOption> = {}): TenantPlanOption => ({
  id: 1, code: 'basico', name: 'Básico', priceCents: 9990, currency: 'BRL', periodDays: 30,
  limits: { operators: 3, subscribers: null, devices: 500 }, current: false, ...over
})

describe('plan-options', () => {
  it('lê o período como mês, ano ou dias', () => {
    expect(periodLabel(30, 'R$ 1')).toEqual({ key: 'plan.options.perMonth', vars: { price: 'R$ 1' } })
    expect(periodLabel(365, 'R$ 1').key).toBe('plan.options.perYear')
    expect(periodLabel(90, 'R$ 1')).toEqual({ key: 'plan.options.perDays', vars: { price: 'R$ 1', days: 90 } })
  })

  it('só oferece a troca a quem escreve e fora do plano atual', () => {
    expect(canSwitchTo(plano(), true)).toBe(true)
    expect(canSwitchTo(plano({ current: true }), true)).toBe(false)
    expect(canSwitchTo(plano(), false)).toBe(false)
  })

  it('pagar agora exige escrita e plano atual pago', () => {
    expect(canPayNow([plano({ current: true })], true)).toBe(true)
    expect(canPayNow([plano({ current: true, priceCents: 0 })], true)).toBe(false)
    expect(canPayNow([plano({ current: true })], false)).toBe(false)
    expect(canPayNow([plano()], true)).toBe(false)
    expect(canPayNow(null, true)).toBe(false)
  })

  it('lê o over_limit só quando vem completo', () => {
    expect(overLimitDetail({ code: 'over_limit', resource: 'devices', used: 700, limit: 500 })).toEqual({
      key: 'plan.options.overLimit', resourceKey: 'platform.subscription.devices', used: 700, limit: 500
    })
    expect(overLimitDetail({ code: 'over_limit', resource: 'devices' })).toBeNull()
    expect(overLimitDetail({ code: 'not_changeable', resource: 'devices', used: 1, limit: 0 })).toBeNull()
  })

  it('reconhece as recusas do cadastro fiscal', () => {
    expect(needsBillingProfile('missing_tax_id')).toBe(true)
    expect(needsBillingProfile('invalid_tax_id')).toBe(true)
    expect(needsBillingProfile('missing_name')).toBe(true)
    expect(needsBillingProfile('free_plan')).toBe(false)
    expect(needsBillingProfile(undefined)).toBe(false)
  })

  it('reconhece o busy', () => {
    expect(isBusy('busy')).toBe(true)
    expect(isBusy('gateway_failed')).toBe(false)
    expect(isBusy(undefined)).toBe(false)
  })

  it('só oferece gerar cobrança no atraso e no teste vencido, com plano pago', () => {
    const base = { code: 'subscription_past_due', paymentUrl: null, chargesLoaded: true, canWrite: true, plans: [plano({ current: true })] }
    expect(canGenerateCharge(base)).toBe(true)
    expect(canGenerateCharge({ ...base, code: 'subscription_trial_expired' })).toBe(true)
    expect(canGenerateCharge({ ...base, code: 'subscription_suspended' })).toBe(false)
    expect(canGenerateCharge({ ...base, code: 'subscription_canceled' })).toBe(false)
    expect(canGenerateCharge({ ...base, code: 'subscription_missing' })).toBe(false)
    expect(canGenerateCharge({ ...base, paymentUrl: 'https://pay.test' })).toBe(false)
    expect(canGenerateCharge({ ...base, chargesLoaded: false })).toBe(false)
    expect(canGenerateCharge({ ...base, canWrite: false })).toBe(false)
    expect(canGenerateCharge({ ...base, plans: [plano({ current: true, priceCents: 0 })] })).toBe(false)
    expect(canGenerateCharge({ ...base, plans: null })).toBe(false)
  })

  describe('payInNewTab', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('abre a aba antes da resposta e a leva ao link', async () => {
      const aba = { opener: {}, location: { href: '' }, close: vi.fn() }
      const open = vi.fn(() => aba)
      vi.stubGlobal('window', { open })
      let aberta = false
      const res = await payInNewTab(async () => {
        aberta = open.mock.calls.length === 1
        return { success: true, data: { charge: { invoiceUrl: 'https://pay.test/1' } as never } }
      })
      expect(aberta).toBe(true)
      expect(res.success).toBe(true)
      expect(aba.opener).toBeNull()
      expect(aba.location.href).toBe('https://pay.test/1')
      expect(aba.close).not.toHaveBeenCalled()
    })

    it('trata 201 como 200: sucesso com link navega a aba', async () => {
      const aba = { opener: {}, location: { href: '' }, close: vi.fn() }
      vi.stubGlobal('window', { open: vi.fn(() => aba) })
      await payInNewTab(async () => ({ success: true, data: { charge: { invoiceUrl: 'https://pay.test/2' } as never } }))
      expect(aba.location.href).toBe('https://pay.test/2')
    })

    it('fecha a aba no busy', async () => {
      const aba = { opener: {}, location: { href: '' }, close: vi.fn() }
      vi.stubGlobal('window', { open: vi.fn(() => aba) })
      const res = await payInNewTab(async () => ({ success: false, code: 'busy', message: 'Tente de novo' }))
      expect(isBusy(res.code)).toBe(true)
      expect(aba.close).toHaveBeenCalled()
    })

    it('fecha a aba na recusa', async () => {
      const aba = { opener: {}, location: { href: '' }, close: vi.fn() }
      vi.stubGlobal('window', { open: vi.fn(() => aba) })
      const res = await payInNewTab(async () => ({ success: false, code: 'missing_tax_id' }))
      expect(res.code).toBe('missing_tax_id')
      expect(aba.close).toHaveBeenCalled()
    })
  })
})
