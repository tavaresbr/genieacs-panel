import { describe, expect, it } from 'vitest'
import { riskBadge, teiahRiskWarnings } from '../src/lib/teiah'

describe('riskBadge', () => {
  it('low is green, high is red, the rest amber', () => {
    expect(riskBadge('BAIXO')).toBe('modern-badge-success')
    expect(riskBadge('alto')).toBe('modern-badge-error')
    expect(riskBadge('MÉDIO')).toBe('modern-badge-warning')
    expect(riskBadge(null)).toBe('modern-badge-warning')
  })
})

describe('teiahRiskWarnings', () => {
  it('nothing to warn about', () => {
    expect(teiahRiskWarnings({})).toEqual([])
    expect(teiahRiskWarnings({ cpf: { score: 800, risk: 'BAIXO' }, address: { found: true, score: 700, risk: 'MÉDIO' } })).toEqual([])
    expect(teiahRiskWarnings({ address: { found: false } })).toEqual([])
  })

  it('a high CPF', () => {
    expect(teiahRiskWarnings({ cpf: { score: 300, risk: 'ALTO' } })).toEqual([{ kind: 'cpf', score: 300, risk: 'ALTO' }])
  })

  it('a high address and its debts', () => {
    expect(teiahRiskWarnings({ address: { found: true, score: 412, risk: 'ALTO', debtCount: 2, debtAmount: 289.8 } })).toEqual([
      { kind: 'address', score: 412, risk: 'ALTO' },
      { kind: 'debts', count: 2, amount: 289.8 }
    ])
  })

  it('debts alone, with a risk that is not high', () => {
    expect(teiahRiskWarnings({ address: { found: true, risk: 'MÉDIO', debtCount: 1 } })).toEqual([{ kind: 'debts', count: 1, amount: null }])
  })

  it('both the CPF and the address', () => {
    expect(teiahRiskWarnings({ cpf: { risk: 'alto' }, address: { found: true, risk: 'ALTO' } }).map((r) => r.kind)).toEqual(['cpf', 'address'])
  })
})
