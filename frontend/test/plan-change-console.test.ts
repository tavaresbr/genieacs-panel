import { describe, expect, it } from 'vitest'
import type { ConsolePlanChangeOutcome, ConsolePlanPreview, PlanChangePreview } from '@/lib/api'
import {
  canApply,
  isNoop,
  kindFromPreview,
  limitBlocks,
  outcomeKey,
  outcomeProrationKey,
  previewForMode,
  reasonRequired,
  replacesPending,
  timingKey
} from '@/lib/plan-change-console'

function decisao(over: Partial<PlanChangePreview> = {}): PlanChangePreview & { autoTiming: 'now' | 'renewal'; renewalAvailable: boolean } {
  return {
    cycle: 'monthly',
    cycleFrom: 'monthly',
    direction: 'downgrade',
    timing: 'renewal',
    effectiveAt: '2026-11-10T12:00:00.000Z',
    renewalAt: '2026-11-10T12:00:00.000Z',
    deferredByUpgrade: false,
    priceCents: 10000,
    listPriceCents: 10000,
    currency: 'BRL',
    nextChargeAt: '2026-11-10T12:00:00.000Z',
    proration: null,
    autoTiming: 'renewal',
    renewalAvailable: true,
    ...over
  }
}

/** A prévia de uma descida no meio do período — a regra a agenda para a renovação. */
function previa(over: Partial<ConsolePlanPreview> = {}): ConsolePlanPreview {
  return {
    planId: 2,
    cycle: 'monthly',
    current: { planId: 1, cycle: 'monthly', status: 'active', renewsAt: '2026-11-10T12:00:00.000Z' },
    direction: 'downgrade',
    reasonRequiredForNow: true,
    overLimit: [],
    limitBlocksNow: false,
    pending: null,
    blockers: [],
    modes: {
      auto: decisao(),
      now: decisao({ timing: 'now', effectiveAt: null }),
      renewal: decisao()
    },
    ...over
  }
}

const base = { mode: 'auto' as const, reason: '', skipLimitCheck: false, replacePending: false }

describe('a troca de plano pelo console, sobre a prévia do servidor', () => {
  it('pela regra, a descida agendada passa sem motivo; forçada agora, só com ele', () => {
    const p = previa()
    expect(canApply(p, base)).toBe(true)
    expect(reasonRequired(p, 'now', false)).toBe(true)
    expect(canApply(p, { ...base, mode: 'now' })).toBe(false)
    expect(canApply(p, { ...base, mode: 'now', reason: 'acordo' })).toBe(true)
    expect(canApply(p, { ...base, mode: 'now', reason: '   ' })).toBe(false)
  })

  it('o renewal sem período correndo não existe', () => {
    const p = previa({ modes: { ...previa().modes, renewal: null } })
    expect(previewForMode(p, 'renewal')).toBeNull()
    expect(canApply(p, { ...base, mode: 'renewal' })).toBe(false)
  })

  it('o excesso só barra a troca que vale agora, e pular o limite pede motivo', () => {
    const p = previa({ overLimit: [{ resource: 'operators', used: 3, limit: 1 }], limitBlocksNow: true })
    expect(limitBlocks(p, 'auto', false)).toBe(false)
    expect(limitBlocks(p, 'now', false)).toBe(true)
    expect(canApply(p, { ...base, mode: 'now', reason: 'x' })).toBe(false)
    expect(reasonRequired(p, 'auto', true)).toBe(true)
    expect(canApply(p, { ...base, mode: 'now', skipLimitCheck: true })).toBe(false)
    expect(canApply(p, { ...base, mode: 'now', skipLimitCheck: true, reason: 'migração' })).toBe(true)
  })

  it('a troca agendada viva pede o "substituir"; a mesma pedida de novo não', () => {
    const outra = previa({ pending: { planId: 3, cycle: 'monthly', effectiveAt: '2026-11-10T12:00:00.000Z', locked: false } })
    expect(replacesPending(outra, 'auto')).toBe(true)
    expect(canApply(outra, base)).toBe(false)
    expect(canApply(outra, { ...base, replacePending: true })).toBe(true)

    const mesma = previa({ pending: { planId: 2, cycle: 'monthly', effectiveAt: '2026-11-10T12:00:00.000Z', locked: false } })
    expect(replacesPending(mesma, 'auto')).toBe(false)
    expect(replacesPending(mesma, 'now'), 'aplicar agora a que estava agendada a substitui').toBe(true)
  })

  it('o plano de agora sem nada agendado não tem o que trocar; um bloqueio trava o botão', () => {
    expect(isNoop(previa({ direction: 'none' }))).toBe(true)
    expect(canApply(previa({ direction: 'none' }), base)).toBe(false)
    expect(isNoop(previa({
      direction: 'none', pending: { planId: 3, cycle: 'monthly', effectiveAt: null, locked: false }
    })), 'com agendada, escolher o atual é desistir dela').toBe(false)
    expect(canApply(previa({ blockers: ['cancel_scheduled'] }), base)).toBe(false)
    expect(canApply(null, base)).toBe(false)
  })

  it('as frases do quando e do resultado', () => {
    expect(timingKey(decisao())).toBe('platform.planChange.timingRenewal')
    expect(timingKey(decisao({ deferredByUpgrade: true }))).toBe('platform.planChange.timingDeferred')
    expect(timingKey(decisao({ timing: 'now' }))).toBe('platform.planChange.timingNow')

    const feito: ConsolePlanChangeOutcome = {
      changed: true, scheduled: false, effectiveAt: null, timing: 'now', mode: 'auto', forced: false,
      billingCycle: 'monthly', limitCheck: 'passed', openCharge: 'none',
      proration: { amountCents: 5000, issued: true }
    }
    expect(outcomeKey(feito)).toBe('platform.planChange.outcomeNow')
    expect(outcomeProrationKey(feito)).toBe('platform.planChange.prorationIssued')
    expect(outcomeKey({ ...feito, scheduled: true })).toBe('platform.planChange.outcomeScheduled')
    expect(outcomeKey({ ...feito, changed: false, pendingCanceled: true })).toBe('platform.planChange.outcomePendingCanceled')
    expect(outcomeKey({ ...feito, changed: false })).toBe('platform.planChange.outcomeUnchanged')
    expect(outcomeProrationKey({ ...feito, proration: { amountCents: 5000, issued: false, skipped: 'waived' } }))
      .toBe('platform.planChange.prorationWaived')
    expect(outcomeProrationKey({ ...feito, proration: { amountCents: 5000, issued: false, reason: 'not_linked' } }))
      .toBe('platform.planChange.prorationPending')
    expect(outcomeProrationKey({ ...feito, proration: null })).toBeNull()
  })
})

describe('a confirmação do provedor pela prévia da lista de planos', () => {
  it('o tipo vem da regra do servidor, não de uma conta refeita', () => {
    expect(kindFromPreview(decisao())).toBe('downgrade-scheduled')
    expect(kindFromPreview(decisao({ cycle: 'annual', direction: 'cycle' }))).toBe('cycle-scheduled')
    expect(kindFromPreview(decisao({ timing: 'now' }))).toBe('downgrade-now')
    expect(kindFromPreview(decisao({ timing: 'now', direction: 'upgrade' }))).toBe('upgrade')
  })
})
