import { describe, expect, it } from 'vitest'

import { sessionKind, shellFor } from '@/lib/shell'

/**
 * Qual casca o navegador monta, nas quatro combinações que existem.
 *
 * O que se guarda aqui é a assimetria entre os dois arranjos de deploy: com
 * subdomínio por provedor o endereço é a autoridade, e numa instalação de host
 * único ele não diz nada — lá quem separa o console do painel é a sessão.
 */
describe('a casca que o navegador monta', () => {
  it('é a do console no endereço da plataforma, com sessão ou sem', () => {
    expect(shellFor({ platformHost: true, session: null })).toBe('console')
    expect(shellFor({ platformHost: true, session: 'console' })).toBe('console')
    // Mesmo com uma sessão de provedor em mãos: ali ela não vale, e o backend
    // a recusa — desenhar painel em volta disso seria desenhar em volta de 403.
    expect(shellFor({ platformHost: true, session: 'provider' })).toBe('console')
  })

  it('é a do provedor no host de um provedor', () => {
    expect(shellFor({ platformHost: false, session: null })).toBe('provider')
    expect(shellFor({ platformHost: false, session: 'provider' })).toBe('provider')
  })

  it('segue a sessão onde o endereço não separa os dois', () => {
    // Host único: console e painéis no mesmo endereço. Quem tem sessão de
    // console vê o console.
    expect(shellFor({ platformHost: false, session: 'console' })).toBe('console')
  })
})

describe('a forma de sessão de um usuário', () => {
  it('é nula sem sessão', () => {
    expect(sessionKind(null)).toBe(null)
    expect(sessionKind(undefined)).toBe(null)
  })

  it('é console só quando a sessão se diz da plataforma', () => {
    expect(sessionKind({ platform: true })).toBe('console')
    expect(sessionKind({})).toBe('provider')
    expect(sessionKind({ platform: false })).toBe('provider')
  })
})
