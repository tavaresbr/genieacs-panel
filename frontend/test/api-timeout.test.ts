import { describe, expect, it } from 'vitest'
import { readFailure } from '../src/lib/api'

describe('readFailure', () => {
  it('o teto de tempo é timeout; o resto é rede', () => {
    const t = new Error('signal timed out')
    t.name = 'TimeoutError'
    expect(readFailure(t)).toBe('timeout')
    expect(readFailure(new TypeError('Failed to fetch'))).toBe('network')
    expect(readFailure(null)).toBe('network')
  })
})
