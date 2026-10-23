import { describe, expect, it } from 'vitest'
import { PLATFORM_ALERT_EVENTS, type PlatformAlertsConfig } from '@/lib/api'
import { buildAlertsPatch, monthlyReportWithoutChannel } from '@/lib/platform-alerts'
import { monthOverMonth } from '@/lib/revenue-report'

function config(): PlatformAlertsConfig {
  const events = Object.fromEntries(
    PLATFORM_ALERT_EVENTS.map((e) => [e, { enabled: false, channels: ['whatsapp', 'email'] }])
  ) as PlatformAlertsConfig['events']
  return {
    events,
    bigOverdueCents: 50000,
    dailyDigest: { enabled: false, hour: 8 },
    monthlyReport: { enabled: false, channels: ['whatsapp', 'email'], hour: 8 }
  }
}

describe('variação sobre o mês anterior', () => {
  it('diferença e porcentagem do último mês', () => {
    const serie = [{ v: 1000 }, { v: 800 }, { v: 1000 }]
    expect(monthOverMonth(serie, (m) => m.v)).toEqual({ value: 1000, previous: 800, delta: 200, pct: 0.25 })
  })

  it('sem mês anterior, ou anterior zero, não há porcentagem', () => {
    expect(monthOverMonth([{ v: 5 }], (m) => m.v)).toEqual({ value: 5, previous: null, delta: null, pct: null })
    expect(monthOverMonth([{ v: 0 }, { v: 5 }], (m) => m.v)).toEqual({ value: 5, previous: 0, delta: 5, pct: null })
    expect(monthOverMonth([], (m: { v: number }) => m.v).value).toBeNull()
  })
})

describe('relatório mensal nas configurações', () => {
  it('o patch leva só o que mudou no relatório mensal', () => {
    const original = config()
    const draft = config()
    draft.monthlyReport = { enabled: true, channels: ['email'], hour: 9 }
    expect(buildAlertsPatch(original, draft, '500,00').patch).toEqual({
      monthlyReport: { enabled: true, channels: ['email'], hour: 9 }
    })
    expect(buildAlertsPatch(original, config(), '500,00').patch).toEqual({})
  })

  it('servidor sem o relatório mensal: nada no patch', () => {
    const original = config()
    delete original.monthlyReport
    const draft = config()
    draft.monthlyReport = { enabled: true, channels: ['email'], hour: 9 }
    expect(buildAlertsPatch(original, draft, '500,00').patch).toEqual({})
  })

  it('ligado sem canal é recusado na tela', () => {
    const c = config()
    expect(monthlyReportWithoutChannel(c)).toBe(false)
    c.monthlyReport = { enabled: true, channels: [], hour: 8 }
    expect(monthlyReportWithoutChannel(c)).toBe(true)
  })
})
