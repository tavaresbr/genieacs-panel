import { describe, expect, it } from 'vitest'
import { usageShare } from '@/components/settings/teiah-admin-panel'

describe('usageShare (barra do limite mensal da TeiaH)', () => {
  it('sem limite não tem barra', () => {
    expect(usageShare({ spent: 50, limit: null })).toBeNull()
    expect(usageShare({ spent: 50, limit: 0 })).toBeNull()
  })

  it('a parte gasta do limite, em porcento, sem passar de 100', () => {
    expect(usageShare({ spent: 40, limit: 100 })).toBe(40)
    expect(usageShare({ spent: 99.9, limit: 100 })).toBe(100)
    expect(usageShare({ spent: 250, limit: 100 })).toBe(100)
  })
})
