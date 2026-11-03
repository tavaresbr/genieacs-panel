import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from '@/lib/api'
import { crossTabAction } from '@/lib/cross-tab-session'

/**
 * O que a aba faz quando OUTRA aba do navegador sai ou entra (0129).
 *
 * O aviso vem pelo `BroadcastChannel` e carrega só o fato, nunca um token: o
 * token de acesso de cada aba mora na memória dela, e o refresh no cookie
 * `HttpOnly`, que é do navegador inteiro.
 */
describe('a decisão', () => {
  it('sai quando a outra aba saiu', () => {
    expect(crossTabAction({ type: 'logout' }, { tabScoped: false })).toBe('logout')
  })

  it('recarrega quando a outra aba entrou: o cookie agora é o dela', () => {
    expect(crossTabAction({ type: 'login' }, { tabScoped: false })).toBe('reload')
  })

  it('a personificação não segue o navegador', () => {
    expect(crossTabAction({ type: 'logout' }, { tabScoped: true })).toBe('ignore')
    expect(crossTabAction({ type: 'login' }, { tabScoped: true })).toBe('ignore')
  })

  it('ignora o que não é mensagem de sessão', () => {
    for (const lixo of [null, undefined, 'logout', 42, {}, { type: 'token', token: 'x' }]) {
      expect(crossTabAction(lixo, { tabScoped: false })).toBe('ignore')
    }
  })
})

describe('o cliente diante do aviso', () => {
  let eventos: string[]
  let recarregou: number

  beforeEach(() => {
    const vazio = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    eventos = []
    recarregou = 0
    vi.stubGlobal('sessionStorage', vazio)
    vi.stubGlobal('localStorage', vazio)
    vi.stubGlobal('window', {
      dispatchEvent: (e: Event) => { eventos.push(e.type); return true },
      location: { reload: () => { recarregou++ } }
    })
    apiClient.beginSession('token-1')
    eventos = []
  })

  afterEach(() => {
    apiClient.clearTokens()
    vi.unstubAllGlobals()
  })

  it('sai quando a outra aba saiu, sem ecoar o aviso', () => {
    apiClient.handleSessionMessage({ type: 'logout' })
    expect(eventos).toContain('auth:unauthorized')
    expect(apiClient.getToken()).toBeNull()
  })

  it('recarrega quando a outra aba entrou', () => {
    apiClient.handleSessionMessage({ type: 'login' })
    expect(recarregou).toBe(1)
    expect(apiClient.getToken()).toBe('token-1')
  })
})
