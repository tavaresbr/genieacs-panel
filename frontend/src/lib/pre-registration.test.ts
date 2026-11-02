import { describe, expect, it } from 'vitest'
import { distanceMeters, formatDistance, sortSplitters } from './pre-registration'

describe('pre-registration helpers', () => {
  it('measures distance in metres', () => {
    expect(Math.round(distanceMeters(-3.7241, -38.4936, -3.7241, -38.4936))).toBe(0)
    const d = distanceMeters(-3.7241, -38.4936, -3.7250, -38.4936)
    expect(d).toBeGreaterThan(95)
    expect(d).toBeLessThan(105)
  })

  it('formats metres and kilometres', () => {
    expect(formatDistance(120.4)).toBe('120 m')
    expect(formatDistance(1430)).toBe('1,4 km')
  })

  it('sorts nearest first, then the ones without coordinates by name', () => {
    const sorted = sortSplitters([
      { id: 1, label: 'CTO-10' },
      { id: 2, label: 'Longe', lat: -3.80, lng: -38.60 },
      { id: 3, label: 'CTO-2' },
      { id: 4, label: 'Perto', lat: -3.7242, lng: -38.4937 }
    ], -3.7241, -38.4936)
    expect(sorted.map((s) => s.id)).toEqual([4, 2, 3, 1])
    expect(sorted[2].distance).toBeNull()
  })

  it('without the client position, alphabetical', () => {
    const sorted = sortSplitters([{ id: 1, label: 'B', lat: 1, lng: 1 }, { id: 2, label: 'A' }])
    expect(sorted.map((s) => s.id)).toEqual([2, 1])
  })
})
