import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTICE_DAYS, currentCyclePrice, directPriceEdits, isoDaysFromToday } from '@/lib/price-change'
import en from '@/lib/i18n/locales/en'
import ptBR from '@/lib/i18n/locales/pt-BR'

describe('o reajuste de preço (0122)', () => {
  it('a data mínima é hoje + a antecedência, no calendário local, virando mês e ano', () => {
    expect(DEFAULT_NOTICE_DAYS).toBe(30)
    expect(isoDaysFromToday(30, new Date(2026, 10, 2, 23, 30))).toBe('2026-12-02')
    expect(isoDaysFromToday(1, new Date(2026, 11, 31, 8))).toBe('2027-01-01')
    expect(isoDaysFromToday(0, new Date(2027, 1, 28))).toBe('2027-02-28')
  })

  it('o preço de hoje do ciclo: o anual só quando o plano o oferece', () => {
    expect(currentCyclePrice({ priceCents: 10000, priceYearlyCents: 100000 }, 'monthly')).toBe(10000)
    expect(currentCyclePrice({ priceCents: 10000, priceYearlyCents: 100000 }, 'annual')).toBe(100000)
    expect(currentCyclePrice({ priceCents: 10000, priceYearlyCents: null }, 'annual')).toBeNull()
    expect(currentCyclePrice({ priceCents: 0, priceYearlyCents: null }, 'monthly')).toBeNull()
  })

  it('a edição direta pede confirmação só quando um preço cobrado muda', () => {
    const plano = { priceCents: 10000, priceYearlyCents: 100000 }
    expect(directPriceEdits(plano, 10000, 100000)).toEqual([])
    expect(directPriceEdits(plano, 12000, 100000)).toEqual([['monthly', 12000]])
    expect(directPriceEdits(plano, 10000, 110000)).toEqual([['annual', 110000]])
    expect(directPriceEdits(plano, 12000, 110000)).toEqual([['monthly', 12000], ['annual', 110000]])
    // Tirar o anual ou zerar o mensal não é reajuste (o servidor cuida do anual em uso).
    expect(directPriceEdits(plano, 10000, null)).toEqual([])
    expect(directPriceEdits(plano, 0, 100000)).toEqual([])
  })

  it('as frases levam as mesmas variáveis em inglês e português', () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
    const chaves = Object.keys(en).filter((k) => k.startsWith('platform.plans.priceChange.')
      || k === 'platform.plans.priceEditConfirm' || k.startsWith('plan.priceChangeBanner')) as Array<keyof typeof en>
    expect(chaves.length).toBeGreaterThan(30)
    for (const chave of chaves) expect(vars(ptBR[chave])).toEqual(vars(en[chave]))
    expect(vars(en['plan.priceChangeBanner'])).toEqual(['{date}', '{price}'])
  })
})
