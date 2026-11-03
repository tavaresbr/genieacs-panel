/* O service worker do app do provedor (PWA, 0130).
 *
 * Registrado só no build de produção (`src/lib/pwa.ts`), como `/sw.js?v=<commit>`:
 * o commit do build é a versão do cache, então um build novo é um SW novo,
 * e o antigo apaga o cache dele ao sair.
 *
 * O que guarda, e o que NUNCA guarda:
 * - guarda o "casco": a página offline, os ícones e os assets com hash
 *   (`/assets/*`, imutáveis), lidos do `index.html` na instalação;
 * - navegação é REDE PRIMEIRO; sem rede, a página offline. O HTML do painel
 *   não é servido do cache: ele muda a cada build e só funciona com a API;
 * - `/api/*` nunca passa por aqui — nem do cache, nem para o cache. Resposta
 *   de API é dado de provedor, e um cache dela no aparelho seria dado de um
 *   provedor ao alcance da próxima sessão no mesmo navegador.
 *
 * A versão nova espera (`waiting`) até a tela pedir: o painel mostra "nova
 * versão" e, no clique, manda `SKIP_WAITING`; aí `clients.claim` e a página
 * recarrega. Trocar sozinho no meio de um formulário perderia o que a pessoa
 * digitava.
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const CACHE = `skygp-shell-${VERSION}`
const OFFLINE_URL = '/offline.html'
const SHELL = [OFFLINE_URL, '/pwa-192.png', '/pwa-512.png', '/icon.svg']

/** Os assets com hash que o `index.html` deste build referencia. */
async function assetsDoIndex() {
  try {
    const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' })
    if (!res.ok) return []
    const html = await res.text()
    const urls = new Set()
    for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) urls.add(m[1])
    return [...urls]
  } catch {
    return []
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await cache.addAll(SHELL)
    const assets = await assetsDoIndex()
    // Um asset que falhe não impede a instalação: o casco é o que importa.
    await Promise.all(assets.map((url) => cache.add(url).catch(() => undefined)))
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const nomes = await caches.keys()
    await Promise.all(nomes.filter((n) => n.startsWith('skygp-shell-') && n !== CACHE).map((n) => caches.delete(n)))
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  // Só uma janela deste mesmo endereço manda no SW. A mensagem de um SW chega
  // com `origin` vazio em alguns navegadores: aí vale a origem de quem mandou.
  const origem = event.origin || (event.source && event.source.url ? new URL(event.source.url).origin : '')
  if (origem !== self.location.origin) return
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // Nunca a API, nem o próprio SW e o manifest (sempre da rede, `no-cache`).
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest') return

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req)
      } catch {
        const cache = await caches.open(CACHE)
        return (await cache.match(OFFLINE_URL)) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }
    })())
    return
  }

  // Assets com hash: imutáveis, então cache primeiro (e guardados ao passar).
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const achado = await cache.match(req)
      if (achado) return achado
      const res = await fetch(req)
      if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => undefined)
      return res
    })())
    return
  }

  // O casco (ícones, página offline): rede primeiro, cache como reserva.
  if (SHELL.includes(url.pathname)) {
    event.respondWith(fetch(req).catch(async () => (await caches.match(req)) || Response.error()))
  }
})

// ── Push ─────────────────────────────────────────────────────────────

/**
 * O destino do clique numa notificação: só um caminho deste mesmo endereço —
 * começa com `/`, e não com `//` nem `/\\` (que o navegador lê como outro
 * host); barra invertida e caractere de controle em qualquer ponto também
 * ficam de fora. Qualquer outra coisa vira `/`.
 */
function caminhoSeguro(valor) {
  if (typeof valor !== 'string' || valor.length > 2048) return '/'
  if (!valor.startsWith('/') || valor.startsWith('//')) return '/'
  // eslint-disable-next-line no-control-regex -- controle é justamente o que sai
  if (/[\\\u0000-\u001f\u007f]/.test(valor)) return '/'
  return valor
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  event.waitUntil((async () => {
    // Mensagem nova com o painel aberto e à vista: o sino da própria aba já
    // avisa (`message-notifier.tsx`), e dois avisos da mesma coisa é ruído.
    if (data.event === 'new_message') {
      const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (janelas.some((c) => c.visibilityState === 'visible' && c.focused)) return
    }
    const url = caminhoSeguro(data.url)
    await self.registration.showNotification(String(data.title || 'TR69 Controle'), {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/pwa-192.png',
      badge: '/pwa-192.png',
      data: { url },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  let destino = new URL(caminhoSeguro(event.notification.data && event.notification.data.url), self.location.origin)
  if (destino.origin !== self.location.origin) destino = new URL('/', self.location.origin)
  event.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const janela of janelas) {
      if (new URL(janela.url).origin === self.location.origin) {
        await janela.focus()
        if ('navigate' in janela) await janela.navigate(destino.href).catch(() => undefined)
        return
      }
    }
    await self.clients.openWindow(destino.href)
  })())
})
