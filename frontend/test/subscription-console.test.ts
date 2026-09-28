import { describe, expect, it } from 'vitest'
import type { ChargeConsoleView, SubscriptionConsoleRow, SubscriptionStatus } from '@/lib/api'
import {
  centsToInput,
  chargeActions,
  computeChargeAmount,
  dayInputValue,
  endOfDayIso,
  deadlineOf,
  filterRows,
  gatewayBadge,
  isChargeLate,
  parseDay,
  parseExtendDays,
  parsePercent,
  summaryStatusCards
} from '@/lib/subscription-console'

function row(
  id: number,
  name: string,
  status: SubscriptionStatus | null,
  open = false
): SubscriptionConsoleRow {
  return {
    tenant: { id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), status: 'active' },
    subscription: status === null
      ? null
      : {
        status,
        storedStatus: status,
        planId: 1,
        planCode: 'basic',
        planName: 'Básico',
        priceCents: 9990,
        currency: 'BRL',
        trialEndsAt: null,
        renewsAt: null,
        pendingPlan: null
      },
    gateway: { gateway: null, linked: false },
    openCharge: open ? ({ id: id * 10, status: 'pending' } as ChargeConsoleView) : null
  }
}

describe('computeChargeAmount', () => {
  it('aceita um valor novo digitado em reais', () => {
    expect(computeChargeAmount(10000, 'value', '89,90')).toEqual({ ok: true, amountCents: 8990 })
  })

  it('recusa valor novo zero e texto ilegível', () => {
    expect(computeChargeAmount(10000, 'value', '0')).toEqual({ ok: false, reason: 'nonPositive' })
    expect(computeChargeAmount(10000, 'value', 'abc')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('subtrai um desconto em reais', () => {
    expect(computeChargeAmount(19990, 'discountAmount', '20')).toEqual({ ok: true, amountCents: 17990 })
  })

  it('nunca deixa o desconto em reais zerar ou negativar a cobrança', () => {
    expect(computeChargeAmount(10000, 'discountAmount', '100')).toEqual({ ok: false, reason: 'nonPositive' })
    expect(computeChargeAmount(10000, 'discountAmount', '150,00')).toEqual({ ok: false, reason: 'nonPositive' })
    expect(computeChargeAmount(10000, 'discountAmount', '0')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('aplica percentual arredondando ao centavo', () => {
    expect(computeChargeAmount(9999, 'discountPercent', '10')).toEqual({ ok: true, amountCents: 8999 })
    expect(computeChargeAmount(10000, 'discountPercent', '12,5')).toEqual({ ok: true, amountCents: 8750 })
    expect(computeChargeAmount(333, 'discountPercent', '33.3%')).toEqual({ ok: true, amountCents: 222 })
  })

  it('recusa percentual fora de (0, 100) e o que arredonda para zero', () => {
    expect(computeChargeAmount(10000, 'discountPercent', '100')).toEqual({ ok: false, reason: 'nonPositive' })
    expect(computeChargeAmount(10000, 'discountPercent', '0')).toEqual({ ok: false, reason: 'invalid' })
    expect(computeChargeAmount(10000, 'discountPercent', '-5')).toEqual({ ok: false, reason: 'invalid' })
    expect(computeChargeAmount(1, 'discountPercent', '60')).toEqual({ ok: false, reason: 'nonPositive' })
  })
})

describe('parsePercent', () => {
  it('lê vírgula, ponto e o sinal de porcento', () => {
    expect(parsePercent('7,5')).toBe(7.5)
    expect(parsePercent(' 10 % ')).toBe(10)
    expect(parsePercent('dez')).toBeNull()
  })
})

describe('chargeActions', () => {
  it('cobrança pendente com link oferece tudo menos reemitir', () => {
    expect(chargeActions({ status: 'pending', invoiceUrl: 'https://x' })).toEqual({
      openInvoice: true,
      copyLink: true,
      settle: true,
      changeDueDate: true,
      changeAmount: true,
      cancel: true,
      reissue: false
    })
  })

  it('sem link, não há fatura para abrir nem copiar', () => {
    const acoes = chargeActions({ status: 'overdue', invoiceUrl: null })
    expect(acoes.openInvoice).toBe(false)
    expect(acoes.copyLink).toBe(false)
    expect(acoes.settle).toBe(true)
  })

  it('a que falhou ainda se cobra e também se reemite', () => {
    const acoes = chargeActions({ status: 'failed', invoiceUrl: null })
    expect(acoes.settle).toBe(true)
    expect(acoes.reissue).toBe(true)
  })

  it('cancelada só se reemite; paga e estornada não oferecem nada', () => {
    expect(chargeActions({ status: 'canceled', invoiceUrl: 'https://x' })).toEqual({
      openInvoice: false, copyLink: false, settle: false, changeDueDate: false, changeAmount: false, cancel: false, reissue: true
    })
    for (const status of ['paid', 'refunded'] as const) {
      expect(Object.values(chargeActions({ status, invoiceUrl: 'https://x' })).some(Boolean)).toBe(false)
    }
  })
})

describe('filterRows', () => {
  const rows = [
    row(1, 'São João Net', 'active', true),
    row(2, 'Fibra Sul', 'past_due', true),
    row(3, 'Rede Norte', 'trial'),
    row(4, 'Sem Plano', null)
  ]

  it('sem filtro devolve tudo', () => {
    expect(filterRows(rows, { statuses: [], onlyOpenCharge: false, search: '' })).toHaveLength(4)
  })

  it('filtra por estado, incluindo quem não tem assinatura', () => {
    expect(filterRows(rows, { statuses: ['past_due', 'none'], onlyOpenCharge: false, search: '' }).map((r) => r.tenant.id))
      .toEqual([2, 4])
  })

  it('filtra só quem tem cobrança em aberto', () => {
    expect(filterRows(rows, { statuses: [], onlyOpenCharge: true, search: '' }).map((r) => r.tenant.id)).toEqual([1, 2])
  })

  it('busca pelo nome sem caixa nem acento, e pelo slug', () => {
    expect(filterRows(rows, { statuses: [], onlyOpenCharge: false, search: 'sao joao' }).map((r) => r.tenant.id)).toEqual([1])
    expect(filterRows(rows, { statuses: [], onlyOpenCharge: false, search: 'rede-norte' }).map((r) => r.tenant.id)).toEqual([3])
  })

  it('combina os filtros', () => {
    expect(filterRows(rows, { statuses: ['active', 'trial'], onlyOpenCharge: true, search: 'net' }).map((r) => r.tenant.id))
      .toEqual([1])
  })
})

describe('summaryStatusCards', () => {
  it('segue a ordem da tela e conta zero para o que faltar', () => {
    const cards = summaryStatusCards({
      byStatus: { active: 5, trial: 2, past_due: 1, suspended: 0, canceled: 3 } as never
    })
    expect(cards.map((c) => [c.status, c.count])).toEqual([
      ['active', 5], ['trial', 2], ['past_due', 1], ['suspended', 0], ['canceled', 3], ['none', 0]
    ])
    expect(cards[0].labelKey).toBe('platform.subs.status.active')
  })

  it('sem resumo, tudo zero', () => {
    expect(summaryStatusCards(null).every((c) => c.count === 0)).toBe(true)
  })
})

describe('gatewayBadge', () => {
  it('distingue gateway ligado, não ligado e manual', () => {
    expect(gatewayBadge({ gateway: 'asaas', linked: true })).toEqual({ kind: 'gateway', name: 'Asaas' })
    expect(gatewayBadge({ gateway: 'asaas', linked: false })).toEqual({ kind: 'unlinked', name: 'Asaas' })
    expect(gatewayBadge({ gateway: null, linked: false })).toEqual({ kind: 'manual' })
    expect(gatewayBadge({ gateway: 'manual', linked: true })).toEqual({ kind: 'manual' })
  })
})

describe('datas', () => {
  it('lê AAAA-MM-DD como meia-noite local, não UTC', () => {
    const d = parseDay('2026-10-10')
    expect(d?.getFullYear()).toBe(2026)
    expect(d?.getMonth()).toBe(9)
    expect(d?.getDate()).toBe(10)
    expect(dayInputValue('2026-10-10')).toBe('2026-10-10')
    expect(parseDay('lixo')).toBeNull()
    expect(dayInputValue(null)).toBe('')
  })

  it('pendente com vencimento para trás conta como vencida', () => {
    const agora = new Date(2026, 8, 28, 12)
    expect(isChargeLate({ status: 'pending', dueDate: '2026-09-27' }, agora)).toBe(true)
    expect(isChargeLate({ status: 'pending', dueDate: '2026-09-28' }, agora)).toBe(false)
    expect(isChargeLate({ status: 'overdue', dueDate: null }, agora)).toBe(true)
    expect(isChargeLate({ status: 'paid', dueDate: '2020-01-01' }, agora)).toBe(false)
  })

  it('o prazo da linha é o fim do teste em teste, e a renovação nos demais', () => {
    const base = row(1, 'X', 'trial').subscription!
    expect(deadlineOf({ ...base, trialEndsAt: '2026-10-01', renewsAt: '2026-11-01' })).toEqual({ kind: 'trial', date: '2026-10-01' })
    expect(deadlineOf({ ...base, storedStatus: 'active', renewsAt: '2026-11-01' })).toEqual({ kind: 'paid', date: '2026-11-01' })
    expect(deadlineOf(null)).toBeNull()
  })

  it('lê os dias a estender', () => {
    expect(parseExtendDays('15')).toBe(15)
    expect(parseExtendDays('0')).toBeNull()
    expect(parseExtendDays('2,5')).toBeNull()
    expect(parseExtendDays('365')).toBe(365)
    expect(parseExtendDays('366')).toBeNull()
  })
})

describe('endOfDayIso', () => {
  it('manda o fim do dia local, que volta ao mesmo dia no input', () => {
    const iso = endOfDayIso('2026-10-10')
    expect(iso).not.toBeNull()
    expect(dayInputValue(iso)).toBe('2026-10-10')
    expect(endOfDayIso('')).toBeNull()
  })
})

describe('centsToInput', () => {
  it('escreve centavos como se digita', () => {
    expect(centsToInput(19990)).toBe('199,90')
    expect(centsToInput(5)).toBe('0,05')
  })
})
