import { afterEach, describe, expect, it, vi } from 'vitest'

import { legacyStoredRefreshToken, storedSession } from '@/lib/api'

/**
 * O que ainda mora em storage depois de 0129.
 *
 * O token de acesso de uma sessão comum vive só na memória do `ApiClient`, e o
 * refresh num cookie `HttpOnly`. Em storage sobra a personificação, na gaveta
 * POR ABA (`sessionStorage`): o console abre o painel de um provedor numa aba
 * nova e continua aberto atrás, e numa instalação de host único as duas abas
 * dividem a origem. E sobra, por uma versão, o refresh ANTIGO do
 * `localStorage`, que a primeira carga migra para o cookie.
 *
 * Ambiente `node`, sem DOM: o que estas funções leem são os dois storages e o
 * `window`, e é isso que o teste finge, como os outros deste diretório fazem.
 */
function gaveta(inicial: Record<string, string> = {}): Storage {
  const dados = new Map(Object.entries(inicial))
  return {
    get length() { return dados.size },
    key: (i: number) => [...dados.keys()][i] ?? null,
    getItem: (k: string) => dados.get(k) ?? null,
    setItem: (k: string, v: string) => { dados.set(k, String(v)) },
    removeItem: (k: string) => { dados.delete(k) },
    clear: () => dados.clear()
  }
}

function navegador(sessao: Record<string, string>, navegadorTodo: Record<string, string>) {
  vi.stubGlobal('window', {})
  vi.stubGlobal('sessionStorage', gaveta(sessao))
  vi.stubGlobal('localStorage', gaveta(navegadorTodo))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a sessão guardada no navegador', () => {
  it('não é o token antigo do localStorage: esse não vale mais como sessão', () => {
    navegador({}, { token: 'do-operador', refreshToken: 'renova' })
    expect(storedSession()).toEqual({ token: null, tabScoped: false })
  })

  it('é a da aba quando há personificação', () => {
    navegador({ token: 'da-personificacao' }, { token: 'do-console', refreshToken: 'renova' })
    expect(storedSession()).toEqual({ token: 'da-personificacao', tabScoped: true })
  })

  it('não é nenhuma quando nada foi guardado', () => {
    navegador({}, {})
    expect(storedSession()).toEqual({ token: null, tabScoped: false })
  })

  it('não tenta ler storage nenhum fora do navegador', () => {
    vi.stubGlobal('window', undefined)
    expect(storedSession()).toEqual({ token: null, tabScoped: false })
    expect(legacyStoredRefreshToken()).toBeNull()
  })
})

describe('o refresh antigo, da versão anterior', () => {
  it('é lido para a migração única', () => {
    navegador({}, { token: 'velho', refreshToken: 'renova-velho' })
    expect(legacyStoredRefreshToken()).toBe('renova-velho')
  })
})
