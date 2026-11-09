import { describe, expect, it } from 'vitest'
import { WAIT_LATE_MIN, WAIT_WARN_MIN, waitBand } from '@/lib/wa-wait-band'

describe('faixa de espera da lista de conversas', () => {
  it('verde até 5 minutos, amarela até 15, vermelha depois', () => {
    expect(waitBand(0)).toBe('ok')
    expect(waitBand(WAIT_WARN_MIN)).toBe('ok')
    expect(waitBand(WAIT_WARN_MIN + 1)).toBe('warn')
    expect(waitBand(WAIT_LATE_MIN)).toBe('warn')
    expect(waitBand(WAIT_LATE_MIN + 1)).toBe('late')
    expect(waitBand(174)).toBe('late')
  })

  it('sem espera (já respondido) não há faixa', () => {
    expect(waitBand(null)).toBeNull()
    expect(waitBand(undefined)).toBeNull()
    expect(waitBand(Number.NaN)).toBeNull()
  })
})
