import { describe, expect, it } from 'vitest'

import {
  COMPONENT_LABEL_KEYS, IMPACT_LABEL_KEYS, INCIDENT_STATUSES, INCIDENT_STATUS_LABEL_KEYS, OVERALL_LABEL_KEYS,
  STATE_LABEL_KEYS, dayTone, formatUptime, localInputToIso, stateBadgeClass, stateTone,
} from '@/lib/status-page'
import { PLATFORM_TABS } from '@/lib/platform-overview'
import en from '@/lib/i18n/locales/en'

/** As peças puras da página de status (0127). */
describe('a página de status', () => {
  it('tem frase para todo componente, estado, situação e impacto', () => {
    const chaves = [
      ...Object.values(COMPONENT_LABEL_KEYS), ...Object.values(STATE_LABEL_KEYS), ...Object.values(OVERALL_LABEL_KEYS),
      ...Object.values(INCIDENT_STATUS_LABEL_KEYS), ...Object.values(IMPACT_LABEL_KEYS),
    ]
    for (const chave of chaves) expect(en).toHaveProperty(chave)
  })

  it('anda pelas mesmas situações que o backend aceita', () => {
    expect(INCIDENT_STATUSES.incident).toEqual(['investigating', 'identified', 'monitoring', 'resolved'])
    expect(INCIDENT_STATUSES.maintenance).toEqual(['scheduled', 'in_progress', 'resolved'])
  })

  it('pinta o dia pela disponibilidade', () => {
    expect(dayTone(null)).toBe('neutral')
    expect(dayTone(100)).toBe('good')
    expect(dayTone(99.9)).toBe('good')
    expect(dayTone(99.5)).toBe('warning')
    expect(dayTone(98)).toBe('bad')
  })

  it('dá um tom a cada estado', () => {
    expect(stateTone('operational')).toBe('good')
    expect(stateTone('maintenance')).toBe('info')
    expect(stateTone('degraded')).toBe('warning')
    expect(stateTone('major_outage')).toBe('bad')
    expect(stateTone('unknown')).toBe('neutral')
    expect(stateBadgeClass('partial_outage')).toBe('modern-badge-error')
  })

  it('escreve a porcentagem com duas casas no máximo, e travessão sem dado', () => {
    expect(formatUptime(99.954, 'en')).toBe('99.95')
    expect(formatUptime(100, 'en')).toBe('100')
    expect(formatUptime(null, 'en')).toBe('—')
  })

  it('lê o campo de data e hora local como instante, e vazio como nulo', () => {
    expect(localInputToIso('')).toBeNull()
    expect(localInputToIso('não é data')).toBeNull()
    expect(localInputToIso('2026-11-10T03:00')).toBe(new Date('2026-11-10T03:00').toISOString())
  })

  it('tem a aba Status no console', () => {
    expect(PLATFORM_TABS).toContain('status')
  })
})
