import { describe, expect, it } from 'vitest'

import { BRANDING_LIMITS, TOUCH_ICON_SIZE, fitSize, isServerReady, touchIconLayout } from '@/lib/branding-image'

describe('fitSize', () => {
  it('reduz pelo maior lado, mantendo a proporção', () => {
    expect(fitSize(2000, 1000, 512)).toEqual({ width: 512, height: 256 })
    expect(fitSize(800, 1600, 512)).toEqual({ width: 256, height: 512 })
  })

  it('nunca amplia', () => {
    expect(fitSize(64, 32, 512)).toEqual({ width: 64, height: 32 })
  })

  it('usa o lado máximo quando a imagem não diz o tamanho (SVG)', () => {
    expect(fitSize(0, 0, 128)).toEqual({ width: 128, height: 128 })
  })
})

describe('isServerReady', () => {
  it('passa o que o servidor aceita e cabe no teto', () => {
    expect(isServerReady('image/png', 1000, 'logo')).toBe(true)
    expect(isServerReady('image/x-icon', BRANDING_LIMITS.favicon.bytes, 'favicon')).toBe(true)
  })

  it('manda converter o que passa do teto ou é de outro tipo', () => {
    expect(isServerReady('image/png', BRANDING_LIMITS.favicon.bytes + 1, 'favicon')).toBe(false)
    expect(isServerReady('image/svg+xml', 1000, 'logo')).toBe(false)
    expect(isServerReady('image/gif', 1000, 'logo')).toBe(false)
    expect(isServerReady('image/png', 0, 'logo')).toBe(false)
  })
})

describe('touchIconLayout', () => {
  it('centraliza a imagem dentro do quadrado, com folga', () => {
    const l = touchIconLayout(400, 200)
    expect(l.width).toBeGreaterThan(l.height)
    expect(l.x).toBeGreaterThan(0)
    // O arredondamento pode sobrar 1 px de um lado.
    expect(Math.abs(l.x * 2 + l.width - TOUCH_ICON_SIZE)).toBeLessThanOrEqual(1)
    expect(Math.abs(l.y * 2 + l.height - TOUCH_ICON_SIZE)).toBeLessThanOrEqual(1)
  })

  it('faz uma imagem pequena crescer até o miolo', () => {
    const l = touchIconLayout(32, 32)
    expect(l.width).toBe(l.height)
    expect(l.width).toBeGreaterThan(100)
  })

  it('não quebra quando a imagem não diz o tamanho', () => {
    const l = touchIconLayout(0, 0)
    expect(l.width).toBeGreaterThan(0)
  })
})
