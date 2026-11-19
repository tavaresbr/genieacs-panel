import { describe, expect, it } from 'vitest'
import { nextRovingIndex } from '../src/lib/use-roving'

describe('nextRovingIndex', () => {
  it('setas andam e dão a volta nas pontas', () => {
    expect(nextRovingIndex('ArrowRight', 0, 3)).toBe(1)
    expect(nextRovingIndex('ArrowRight', 2, 3)).toBe(0)
    expect(nextRovingIndex('ArrowLeft', 0, 3)).toBe(2)
    expect(nextRovingIndex('ArrowDown', 1, 3)).toBe(2)
    expect(nextRovingIndex('ArrowUp', 0, 3)).toBe(2)
  })
  it('Home e End', () => {
    expect(nextRovingIndex('Home', 2, 4)).toBe(0)
    expect(nextRovingIndex('End', 0, 4)).toBe(3)
  })
  it('só um eixo, quando pedido', () => {
    expect(nextRovingIndex('ArrowLeft', 1, 3, { horizontal: false })).toBeNull()
    expect(nextRovingIndex('ArrowDown', 1, 3, { vertical: false })).toBeNull()
  })
  it('outras teclas e grupo vazio não fazem nada', () => {
    expect(nextRovingIndex('a', 0, 3)).toBeNull()
    expect(nextRovingIndex('ArrowRight', 0, 0)).toBeNull()
  })
})
