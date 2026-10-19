import { describe, expect, it } from 'vitest'

import { BRANDING_LIMITS, fitSize, isServerReady } from '@/lib/branding-image'

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
