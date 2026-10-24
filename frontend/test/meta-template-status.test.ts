import { describe, expect, it } from 'vitest'
import type { WhatsAppMetaTemplate } from '@/lib/api'
import { changedRecently } from '@/components/whatsapp/meta-templates-panel'

const agora = Date.UTC(2026, 9, 1, 12)
const modelo = (statusChangedAt: string | null) => ({ statusChangedAt }) as WhatsAppMetaTemplate

describe('changedRecently', () => {
  it('destaca a decisão da Meta das últimas 24 h', () => {
    expect(changedRecently(modelo(new Date(agora - 3_600_000).toISOString()), agora)).toBe(true)
  })

  it('não destaca o que mudou há mais de um dia, nem o que nunca mudou', () => {
    expect(changedRecently(modelo(new Date(agora - 25 * 3_600_000).toISOString()), agora)).toBe(false)
    expect(changedRecently(modelo(null), agora)).toBe(false)
    expect(changedRecently(modelo('não é data'), agora)).toBe(false)
  })
})
