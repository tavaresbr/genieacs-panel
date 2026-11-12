import { describe, expect, it } from 'vitest'
import { avatarFileProblem, centerSquare, initialsOf, AVATAR_MAX_SOURCE_BYTES } from '@/lib/avatar-image'

describe('foto do operador', () => {
  it('só aceita PNG, JPEG e WebP, e recusa o gigante', () => {
    expect(avatarFileProblem({ type: 'image/png', size: 1000 })).toBeNull()
    expect(avatarFileProblem({ type: 'image/jpeg', size: 1000 })).toBeNull()
    expect(avatarFileProblem({ type: 'image/webp', size: 1000 })).toBeNull()
    expect(avatarFileProblem({ type: 'image/svg+xml', size: 1000 })).toBe('type')
    expect(avatarFileProblem({ type: 'application/pdf', size: 1000 })).toBe('type')
    expect(avatarFileProblem({ type: 'image/png', size: AVATAR_MAX_SOURCE_BYTES + 1 })).toBe('size')
  })

  it('recorta o quadrado central', () => {
    expect(centerSquare(400, 200)).toEqual({ sx: 100, sy: 0, side: 200 })
    expect(centerSquare(200, 400)).toEqual({ sx: 0, sy: 100, side: 200 })
    expect(centerSquare(300, 300)).toEqual({ sx: 0, sy: 0, side: 300 })
  })

  it('tira as iniciais do nome ou do usuário', () => {
    expect(initialsOf('Ana Souza da Silva')).toBe('AS')
    expect(initialsOf('joao')).toBe('J')
    expect(initialsOf('maria.clara')).toBe('MC')
    expect(initialsOf('')).toBe('?')
    expect(initialsOf(null)).toBe('?')
  })
})
