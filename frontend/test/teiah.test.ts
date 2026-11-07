import { describe, expect, it } from 'vitest'
import { riskBadge } from '../src/lib/teiah'

describe('riskBadge', () => {
  it('low is green, high is red, the rest amber', () => {
    expect(riskBadge('BAIXO')).toBe('modern-badge-success')
    expect(riskBadge('alto')).toBe('modern-badge-error')
    expect(riskBadge('MÉDIO')).toBe('modern-badge-warning')
    expect(riskBadge(null)).toBe('modern-badge-warning')
  })
})
