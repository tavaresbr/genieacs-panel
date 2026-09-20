import { describe, expect, it } from 'vitest'

import { sessionKind, shellFor, wearingPlatformHat } from '@/lib/shell'

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

/**
 * O chapéu que a barra lateral usa, dentro da casca de um provedor.
 *
 * Num deploy de host único, quem opera a plataforma E um ISP tem sessão de
 * provedor — então `shellFor` monta a árvore do provedor, e `/platform` é uma
 * rota dentro dela. Enquanto essa rota está aberta, a barra lateral escrevia o
 * nome de um ISP ao lado de uma tela que fala de todos.
 */
describe('o chapéu que a barra lateral está usando', () => {
  const semDominio = { panelBaseDomain: null, isPlatformAdmin: true }

  it('é o da plataforma na tela da plataforma', () => {
    expect(wearingPlatformHat({ pathname: '/platform', ...semDominio })).toBe(true)
    expect(wearingPlatformHat({ pathname: '/platform/qualquer-coisa', ...semDominio })).toBe(true)
  })

  it('e o do provedor em toda tela de operação', () => {
    for (const rota of ['/dashboard', '/devices', '/network-map', '/whatsapp', '/settings', '/audit', '/plan']) {
      expect(wearingPlatformHat({ pathname: rota, ...semDominio })).toBe(false)
    }
  })

  /**
   * O prefixo é comparado com a barra junto. Sem isso, uma rota futura chamada
   * `/platformas` vestiria o chapéu errado — e o defeito só apareceria no dia
   * em que alguém criasse essa rota, longe daqui.
   */
  it('e um caminho que só COMEÇA parecido não veste o chapéu', () => {
    expect(wearingPlatformHat({ pathname: '/platformas', ...semDominio })).toBe(false)
    expect(wearingPlatformHat({ pathname: '/platform-admins', ...semDominio })).toBe(false)
  })

  /**
   * Onde há domínio-base o console mudou de endereço e esta casca não serve
   * `/platform`: `PlatformRoute` manda para o painel. O redirecionamento leva
   * um render, e sem esta metade a barra piscaria "Plataforma" antes de voltar
   * ao nome do provedor.
   */
  it('e nunca onde o console mora noutro endereço', () => {
    const comDominio = { panelBaseDomain: 'painel.exemplo.com', isPlatformAdmin: true }
    expect(wearingPlatformHat({ pathname: '/platform', ...comDominio })).toBe(false)
    expect(wearingPlatformHat({ pathname: '/dashboard', ...comDominio })).toBe(false)
  })

  /**
   * A terceira guarda, e a que um operador comum encontra: `PlatformRoute`
   * manda para o painel quem não tem a chave do plano de controle. Sem esta
   * metade, o render antes do redirecionamento mostraria a ele uma barra
   * dizendo "Plataforma" — de uma tela que ele não pode abrir.
   */
  it('e nunca para quem não tem a chave do plano de controle', () => {
    expect(wearingPlatformHat({
      pathname: '/platform', panelBaseDomain: null, isPlatformAdmin: false
    })).toBe(false)
  })

  it('e undefined conta como host único, que é o que o contexto entrega antes de carregar', () => {
    expect(wearingPlatformHat({
      pathname: '/platform', panelBaseDomain: undefined, isPlatformAdmin: true
    })).toBe(true)
  })
})
