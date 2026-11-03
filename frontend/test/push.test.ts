import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import { isIos, pushSupport, sameKey, subscriptionPayload, urlBase64ToUint8Array, PUSH_EVENT_ORDER } from '@/lib/push'
import { isStandalone, serviceWorkerUrl } from '@/lib/pwa'

const AQUI = path.dirname(new URL(import.meta.url).pathname)

/**
 * O app do provedor (PWA) e o push (0130): a parte pura — o que o navegador
 * consegue, a chave VAPID e o que vai ao servidor — e o que o service worker
 * promete não guardar.
 */
describe('o que este navegador consegue', () => {
  const base = { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130', hasServiceWorker: true, hasPushManager: true, hasNotification: true, standalone: false }

  it('Chrome no Android: suportado', () => {
    expect(pushSupport(base)).toBe('supported')
  })

  it('iPhone no Safari, fora do app instalado: pede para instalar', () => {
    const ios = { ...base, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)', hasPushManager: false }
    expect(pushSupport(ios)).toBe('ios-install')
    expect(pushSupport({ ...ios, standalone: true, hasPushManager: true })).toBe('supported')
  })

  it('o iPad que se apresenta como Mac também é iOS', () => {
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true)
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false)
  })

  it('sem PushManager: não suportado', () => {
    expect(pushSupport({ ...base, hasPushManager: false })).toBe('unsupported')
  })

  it('reconhece o app instalado', () => {
    expect(isStandalone({ matchMedia: () => ({ matches: true }) })).toBe(true)
    expect(isStandalone({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } })).toBe(true)
    expect(isStandalone({ matchMedia: () => ({ matches: false }), navigator: {} })).toBe(false)
  })
})

describe('a chave e a inscrição', () => {
  it('converte a chave VAPID base64url em bytes', () => {
    const bytes = urlBase64ToUint8Array('AQID_-8')
    expect([...bytes]).toEqual([1, 2, 3, 255, 239])
  })

  it('compara a chave da inscrição existente', () => {
    const chave = new Uint8Array([1, 2, 3])
    expect(sameKey(new Uint8Array([1, 2, 3]).buffer, chave)).toBe(true)
    expect(sameKey(new Uint8Array([1, 2, 4]).buffer, chave)).toBe(false)
    expect(sameKey(null, chave)).toBe(false)
  })

  it('só manda ao servidor a inscrição completa', () => {
    expect(subscriptionPayload({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } }))
      .toEqual({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } })
    expect(subscriptionPayload({ endpoint: 'https://fcm.googleapis.com/x', keys: {} })).toBeNull()
  })

  it('lista os cinco eventos', () => {
    expect([...PUSH_EVENT_ORDER].sort()).toEqual(['invoice', 'mass_outage', 'new_message', 'ont_offline', 'wa_disconnected'])
  })
})

describe('o service worker', () => {
  const sw = readFileSync(path.join(AQUI, '..', 'public', 'sw.js'), 'utf8')

  it('é versionado pelo commit do build', () => {
    expect(serviceWorkerUrl('abc1234')).toBe('/sw.js?v=abc1234')
    expect(serviceWorkerUrl('')).toBe('/sw.js')
    expect(serviceWorkerUrl('a"b<c')).toBe('/sw.js?v=abc')
  })

  it('nunca passa a API pelo cache', () => {
    expect(sw).toMatch(/url\.pathname\.startsWith\('\/api\/'\)[^\n]*return/)
  })

  it('espera a tela pedir para trocar de versão', () => {
    expect(sw).toMatch(/SKIP_WAITING/)
    // O skipWaiting só dentro do ouvinte de mensagem, nunca na instalação.
    const instalacao = sw.slice(sw.indexOf("addEventListener('install'"), sw.indexOf("addEventListener('activate'"))
    expect(instalacao).not.toMatch(/skipWaiting/)
    expect(sw).toMatch(/clients\.claim\(\)/)
  })

  it('tem a página offline no casco', () => {
    expect(sw).toMatch(/OFFLINE_URL = '\/offline\.html'/)
    expect(readFileSync(path.join(AQUI, '..', 'public', 'offline.html'), 'utf8')).toMatch(/<html/)
  })

  // O SW de verdade, rodado num `self` de mentira: só os ouvintes interessam.
  function carregarSw() {
    const ouvintes = new Map<string, (event: unknown) => void>()
    const skipWaiting = vi.fn()
    const contexto: Record<string, unknown> = {
      URL,
      self: {
        location: { href: 'https://painel.test/sw.js?v=abc', origin: 'https://painel.test' },
        addEventListener: (tipo: string, fn: (event: unknown) => void) => ouvintes.set(tipo, fn),
        skipWaiting,
      },
    }
    vm.runInNewContext(sw, contexto)
    return { ouvintes, skipWaiting, caminhoSeguro: contexto.caminhoSeguro as (v: unknown) => string }
  }

  it('só aceita SKIP_WAITING de uma janela do mesmo endereço', () => {
    const { ouvintes, skipWaiting } = carregarSw()
    const mensagem = ouvintes.get('message')!
    mensagem({ origin: 'https://outro.test', data: { type: 'SKIP_WAITING' } })
    mensagem({ origin: '', source: { url: 'https://outro.test/' }, data: { type: 'SKIP_WAITING' } })
    mensagem({ origin: '', data: { type: 'SKIP_WAITING' } })
    expect(skipWaiting).not.toHaveBeenCalled()
    mensagem({ origin: 'https://painel.test', data: { type: 'OUTRA' } })
    expect(skipWaiting).not.toHaveBeenCalled()
    mensagem({ origin: 'https://painel.test', data: { type: 'SKIP_WAITING' } })
    expect(skipWaiting).toHaveBeenCalledTimes(1)
    mensagem({ origin: '', source: { url: 'https://painel.test/clientes' }, data: { type: 'SKIP_WAITING' } })
    expect(skipWaiting).toHaveBeenCalledTimes(2)
  })

  it('o clique na notificação só abre caminho deste endereço', () => {
    const { caminhoSeguro } = carregarSw()
    expect(caminhoSeguro('/clientes/12?aba=onu')).toBe('/clientes/12?aba=onu')
    for (const ruim of [
      undefined, null, 42, '', 'clientes', 'https://evil.test/', '//evil.test/x', '/\\evil.test/x',
      '/a\\b', '/\t/evil.test', '/a\nb', 'javascript:alert(1)', `/${'a'.repeat(3000)}`,
    ]) {
      expect(caminhoSeguro(ruim)).toBe('/')
    }
  })

  it('o painel aponta para o manifest', () => {
    const index = readFileSync(path.join(AQUI, '..', 'index.html'), 'utf8')
    expect(index).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" \/>/)
  })
})
