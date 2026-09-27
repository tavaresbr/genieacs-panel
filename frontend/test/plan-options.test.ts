import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TenantPlanOption } from '@/lib/api'
import {
  canGenerateCharge,
  canCancelPending,
  canPayNow,
  canSwitchTo,
  isBusy,
  isPendingLocked,
  isPendingLockedRefusal,
  subscriptionAllowsChanges,
  needsBillingProfile,
  confirmKey,
  overLimitDetail,
  payInNewTab,
  pendingBlockedDetail,
  periodLabel,
  planChangeKind
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

  const ativa = { status: 'active' as const, pendingPlan: null }
  const agendado = (id: number, locked?: boolean) => ({
    id, name: 'Básico', priceCents: 4990, effectiveAt: '2026-10-15T00:00:00Z', ...(locked === undefined ? {} : { locked })
  })

  it('só oferece a troca a quem escreve e fora do plano atual', () => {
    expect(canSwitchTo(plano(), true, ativa)).toBe(true)
    expect(canSwitchTo(plano({ current: true }), true, ativa)).toBe(false)
    expect(canSwitchTo(plano(), false, ativa)).toBe(false)
    expect(canSwitchTo(plano({ id: 7 }), true, { ...ativa, pendingPlan: agendado(7) })).toBe(false)
    expect(canSwitchTo(plano({ id: 7 }), true, { ...ativa, pendingPlan: agendado(8) })).toBe(true)
    expect(canSwitchTo(plano({ id: 7 }), true, { status: 'active' })).toBe(true)
  })

  it('não oferece troca com a assinatura suspensa, cancelada ou ausente', () => {
    expect(canSwitchTo(plano(), true, { status: 'trial' })).toBe(true)
    expect(canSwitchTo(plano(), true, { status: 'past_due' })).toBe(true)
    expect(canSwitchTo(plano(), true, { status: 'suspended' })).toBe(false)
    expect(canSwitchTo(plano(), true, { status: 'canceled' })).toBe(false)
    expect(canSwitchTo(plano(), true, null)).toBe(false)
    expect(canSwitchTo(plano(), true, undefined)).toBe(false)
    expect(subscriptionAllowsChanges({ status: 'active' })).toBe(true)
    expect(subscriptionAllowsChanges({ status: 'suspended' })).toBe(false)
    expect(subscriptionAllowsChanges(null)).toBe(false)
  })

  it('agendamento travado esconde toda troca e o cancelamento', () => {
    const travada = { ...ativa, pendingPlan: agendado(7, true) }
    expect(canSwitchTo(plano({ id: 8 }), true, travada)).toBe(false)
    expect(canSwitchTo(plano({ id: 7 }), true, travada)).toBe(false)
    expect(canSwitchTo(plano({ id: 8 }), true, { ...ativa, pendingPlan: agendado(7, false) })).toBe(true)
    expect(isPendingLocked(agendado(7, true))).toBe(true)
    expect(isPendingLocked(agendado(7, false))).toBe(false)
    expect(isPendingLocked(agendado(7))).toBe(false)
    expect(isPendingLocked(null)).toBe(false)
    expect(canCancelPending(agendado(7), true)).toBe(true)
    expect(canCancelPending(agendado(7, false), true)).toBe(true)
    expect(canCancelPending(agendado(7, true), true)).toBe(false)
    expect(canCancelPending(agendado(7), false)).toBe(false)
    expect(canCancelPending(null, true)).toBe(false)
  })

  it('reconhece o pending_locked', () => {
    expect(isPendingLockedRefusal('pending_locked')).toBe(true)
    expect(isPendingLockedRefusal('busy')).toBe(false)
    expect(isPendingLockedRefusal(undefined)).toBe(false)
  })

  describe('planChangeKind', () => {
    const agora = Date.parse('2026-09-27T12:00:00Z')
    const atual = plano({ id: 2, priceCents: 9990, current: true })
    const emDia = { status: 'active' as const, renewsAt: '2026-10-15T00:00:00Z' }

    it('reconhece o plano atual', () => {
      expect(planChangeKind(atual, atual, emDia, agora)).toBe('same')
    })

    it('subir de preço vale na hora, em qualquer estado', () => {
      const caro = plano({ id: 3, priceCents: 19990 })
      expect(planChangeKind(atual, caro, emDia, agora)).toBe('upgrade')
      expect(planChangeKind(atual, caro, { status: 'trial', renewsAt: null }, agora)).toBe('upgrade')
      // Preço igual não é descida.
      expect(planChangeKind(atual, plano({ id: 4, priceCents: 9990 }), emDia, agora)).toBe('upgrade')
      // Sem plano atual no catálogo não há o que comparar: vale na hora.
      expect(planChangeKind(null, caro, emDia, agora)).toBe('upgrade')
    })

    it('descer com a assinatura em dia e renovação futura fica agendado', () => {
      expect(planChangeKind(atual, plano({ id: 1, priceCents: 4990 }), emDia, agora)).toBe('downgrade-scheduled')
      expect(planChangeKind(atual, plano({ id: 1, priceCents: 0 }), emDia, agora)).toBe('downgrade-scheduled')
    })

    it('descer no teste, no atraso, sem renovação ou com ela vencida vale na hora', () => {
      const barato = plano({ id: 1, priceCents: 4990 })
      expect(planChangeKind(atual, barato, { ...emDia, status: 'trial' }, agora)).toBe('downgrade-now')
      expect(planChangeKind(atual, barato, { ...emDia, status: 'past_due' }, agora)).toBe('downgrade-now')
      expect(planChangeKind(atual, barato, { ...emDia, renewsAt: null }, agora)).toBe('downgrade-now')
      expect(planChangeKind(atual, barato, { ...emDia, renewsAt: '2026-09-01T00:00:00Z' }, agora)).toBe('downgrade-now')
      expect(planChangeKind(atual, barato, { ...emDia, renewsAt: 'não é data' }, agora)).toBe('downgrade-now')
      expect(planChangeKind(atual, barato, null, agora)).toBe('downgrade-now')
    })

    it('escolhe a confirmação de cada tipo', () => {
      expect(confirmKey('upgrade')).toBe('plan.options.confirm')
      expect(confirmKey('downgrade-now')).toBe('plan.options.confirmDowngradeNow')
      expect(confirmKey('downgrade-scheduled')).toBe('plan.options.confirmScheduled')
    })
  })

  it('lê o bloqueio da descida agendada', () => {
    const base = { id: 1, name: 'Básico', priceCents: 4990, effectiveAt: '2026-10-15T00:00:00Z' }
    expect(pendingBlockedDetail({ ...base, blockedBy: { resource: 'devices', used: 600, limit: 500 } })).toEqual({
      key: 'plan.pending.blocked', resourceKey: 'platform.subscription.devices', used: 600, limit: 500
    })
    expect(pendingBlockedDetail({ ...base, blockedBy: null })).toBeNull()
    expect(pendingBlockedDetail({ ...base, blockedBy: undefined })).toBeNull()
    expect(pendingBlockedDetail(null)).toBeNull()
    expect(pendingBlockedDetail({ ...base, blockedBy: { resource: 'x' as never, used: 1, limit: 0 } })).toBeNull()
  })

  it('pagar agora exige escrita, plano atual pago e assinatura que aceita cobrança', () => {
    const ok = { status: 'active' as const }
    expect(canPayNow([plano({ current: true })], true, ok)).toBe(true)
    expect(canPayNow([plano({ current: true })], true, { status: 'trial' })).toBe(true)
    expect(canPayNow([plano({ current: true })], true, { status: 'past_due' })).toBe(true)
    expect(canPayNow([plano({ current: true, priceCents: 0 })], true, ok)).toBe(false)
    expect(canPayNow([plano({ current: true })], false, ok)).toBe(false)
    expect(canPayNow([plano()], true, ok)).toBe(false)
    expect(canPayNow(null, true, ok)).toBe(false)
    expect(canPayNow([plano({ current: true })], true, { status: 'suspended' })).toBe(false)
    expect(canPayNow([plano({ current: true })], true, { status: 'canceled' })).toBe(false)
    expect(canPayNow([plano({ current: true })], true, null)).toBe(false)
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
