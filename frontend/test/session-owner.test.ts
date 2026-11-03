import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from '@/lib/api'
import { readDashboardSnapshot, writeDashboardSnapshot } from '@/lib/dashboard-snapshot'
import { clearSessionScopedStorage, sessionOwner, WA_DOWN_DISMISSED_KEY } from '@/lib/session-owner'

/**
 * O dono da sessão da aba, e o que acontece com o que a aba guardou em nome
 * dele quando a sessão muda de dono.
 *
 * Ambiente `node`, sem DOM: os storages, o `window` e o `fetch` são fingidos,
 * como nos outros testes deste diretório.
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

let sessao: Storage
let navegador: Storage

beforeEach(() => {
  sessao = gaveta()
  navegador = gaveta()
  vi.stubGlobal('sessionStorage', sessao)
  vi.stubGlobal('localStorage', navegador)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('o dono da sessão', () => {
  it('é o provedor e o usuário', () => {
    expect(sessionOwner({ id: 7, tenant: { slug: 'provedor-a', name: 'A' } })).toBe('provedor-a:7')
  })

  it('distingue o mesmo id em provedores diferentes', () => {
    expect(sessionOwner({ id: 1, tenant: { slug: 'provedor-a', name: 'A' } }))
      .not.toBe(sessionOwner({ id: 1, tenant: { slug: 'provedor-b', name: 'B' } }))
  })

  it('usa "-" quando a sessão não tem provedor', () => {
    expect(sessionOwner({ id: 3, tenant: null })).toBe('-:3')
    expect(sessionOwner({ id: 3 })).toBe('-:3')
  })

  it('não existe sem usuário', () => {
    expect(sessionOwner(null)).toBeNull()
    expect(sessionOwner(undefined)).toBeNull()
  })
})

describe('a limpeza do que a aba guarda pela sessão', () => {
  it('apaga a cópia do dashboard e a faixa do WhatsApp fechada', () => {
    writeDashboardSnapshot('provedor-a:1', { total: 146 })
    sessao.setItem(WA_DOWN_DISMISSED_KEY, '12,13')
    sessao.setItem('outra-coisa', 'fica')

    clearSessionScopedStorage()

    expect(readDashboardSnapshot('provedor-a:1')).toBeNull()
    expect(sessao.getItem(WA_DOWN_DISMISSED_KEY)).toBeNull()
    expect(sessao.getItem('outra-coisa')).toBe('fica')
  })

  it('não quebra com o storage bloqueado', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') }
    })
    expect(() => clearSessionScopedStorage()).not.toThrow()
  })
})

describe('um refresh que volta depois da troca de sessão', () => {
  function json(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body)
    }
  }

  beforeEach(() => {
    vi.stubGlobal('window', { dispatchEvent: () => true })
  })

  afterEach(() => {
    apiClient.clearTokens()
  })

  it('é descartado: não grava o token da sessão anterior por cima da nova', async () => {
    apiClient.beginSession('token-a')

    let responderRefresh: (value: unknown) => void = () => {}
    const fetchFalso = vi.fn((url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        return new Promise((resolve) => { responderRefresh = resolve })
      }
      return Promise.resolve(json(403, { success: false, code: 'invalid_token' }))
    })
    vi.stubGlobal('fetch', fetchFalso)

    const pedido = apiClient.get('/devices')
    // Até o refresh sair.
    await vi.waitFor(() => expect(fetchFalso).toHaveBeenCalledTimes(2))

    // Sair e entrar como outro provedor enquanto o refresh está no ar.
    apiClient.clearTokens()
    apiClient.beginSession('token-b')

    responderRefresh(json(200, { success: true, data: { token: 'token-a2' } }))
    const res = await pedido

    expect(res.success).toBe(false)
    expect(apiClient.getToken()).toBe('token-b')
    // O pedido antigo não foi refeito com token nenhum.
    expect(fetchFalso).toHaveBeenCalledTimes(2)
  })

  it('também não derruba a sessão nova quando falha', async () => {
    apiClient.beginSession('token-a')

    let responderRefresh: (value: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        return new Promise((resolve) => { responderRefresh = resolve })
      }
      return Promise.resolve(json(403, { success: false, code: 'invalid_token' }))
    }))

    const pedido = apiClient.get('/devices')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

    apiClient.beginSession('token-b')
    responderRefresh(json(401, { success: false }))
    await pedido

    expect(apiClient.getToken()).toBe('token-b')
  })

  it('da mesma sessão continua renovando, pelo cookie e com o cabeçalho da guarda', async () => {
    apiClient.beginSession('token-a')

    let chamadas = 0
    let pedidoDeRefresh: RequestInit | undefined
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/auth/refresh')) {
        pedidoDeRefresh = init
        return Promise.resolve(json(200, { success: true, data: { token: 'token-a2' } }))
      }
      chamadas += 1
      return Promise.resolve(chamadas === 1
        ? json(403, { success: false, code: 'invalid_token' })
        : json(200, { success: true, data: [] }))
    }))

    const res = await apiClient.get('/devices')

    expect(res.success).toBe(true)
    expect(apiClient.getToken()).toBe('token-a2')
    // O refresh vai no cookie (mesma origem), nunca no corpo; e nada em storage.
    expect(pedidoDeRefresh?.body).toBeUndefined()
    expect((pedidoDeRefresh?.headers as Record<string, string>)['X-Requested-With']).toBe('skygenpanel')
    expect(navegador.getItem('token')).toBeNull()
    expect(navegador.getItem('refreshToken')).toBeNull()
  })

  it('não acontece numa personificação: o cookie do navegador é de quem personifica', async () => {
    apiClient.setTabTokens('token-da-aba')
    const fetchFalso = vi.fn(() => Promise.resolve(json(403, { success: false, code: 'invalid_token' })))
    vi.stubGlobal('fetch', fetchFalso)

    await apiClient.get('/devices')

    expect(fetchFalso).toHaveBeenCalledTimes(1)
    expect(fetchFalso.mock.calls.some((c) => String((c as unknown[])[0]).includes('/auth/refresh'))).toBe(false)
  })
})

describe('a carga da página', () => {
  function json(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body }
  }

  beforeEach(() => {
    vi.stubGlobal('window', { dispatchEvent: () => true })
    apiClient.clearTokens()
  })

  afterEach(() => {
    apiClient.clearTokens()
  })

  it('migra o refresh antigo do localStorage uma vez, pelo corpo, e o apaga', async () => {
    navegador.setItem('token', 'acesso-velho')
    navegador.setItem('refreshToken', 'refresh-velho')
    const corpos: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      corpos.push(init?.body ? JSON.parse(String(init.body)) : null)
      return Promise.resolve(url.endsWith('/api/auth/refresh')
        ? json(200, { success: true, data: { token: 'acesso-novo' } })
        : json(404, {}))
    }))

    expect(await apiClient.restoreSession()).toBe(true)
    expect(apiClient.getToken()).toBe('acesso-novo')
    expect(corpos).toEqual([{ refreshToken: 'refresh-velho' }])
    expect(navegador.getItem('token')).toBeNull()
    expect(navegador.getItem('refreshToken')).toBeNull()
  })

  it('sem nada antigo, renova pelo cookie; sem cookie, fica sem sessão e sem barulho', async () => {
    const chamadas: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      chamadas.push(url)
      return Promise.resolve(json(401, { success: false, code: 'refresh_required' }))
    }))

    expect(await apiClient.restoreSession()).toBe(false)
    // O painel e depois o console: não se sabe qual dos dois cookies existe.
    expect(chamadas.map((u) => u.replace(/^.*\/api/, ''))).toEqual(['/auth/refresh', '/auth/console/refresh'])
    expect(apiClient.getToken()).toBeNull()
  })

  it('tenta o console primeiro quando foi a última sessão deste navegador', async () => {
    navegador.setItem('skg_session_kind', 'console')
    const chamadas: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      chamadas.push(url)
      return Promise.resolve(json(200, { success: true, data: { token: 'do-console', platform: true } }))
    }))

    expect(await apiClient.restoreSession()).toBe(true)
    expect(chamadas.map((u) => u.replace(/^.*\/api/, ''))).toEqual(['/auth/console/refresh'])
    expect(apiClient.getSessionKind()).toBe('console')
  })
})
