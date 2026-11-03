import { useSyncExternalStore } from 'react'

/**
 * O app do provedor (PWA, 0130): o service worker, a versão nova esperando e
 * o "Instalar app".
 *
 * Um estoque de módulo, como `brand.ts`: o aviso de versão nova aparece na
 * casca e o botão de instalar mora em Configurações, e os dois leem o mesmo
 * estado.
 *
 * O SW só é registrado no build de produção. No `vite dev` ele guardaria
 * assets de desenvolvimento e a página serviria código velho depois de cada
 * edição — que é o tipo de defeito que ninguém associa ao SW.
 */

/** O evento do Chrome que permite pedir a instalação na hora que o painel quiser. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface PwaState {
  /** Um SW novo instalado e esperando a página pedir para assumir. */
  updateReady: boolean
  /** O Chrome guardou o pedido de instalação: o botão "Instalar app" pode aparecer. */
  canInstall: boolean
  /** Já roda como app instalado (tela cheia). */
  standalone: boolean
}

let estado: PwaState = { updateReady: false, canInstall: false, standalone: false }
let esperando: ServiceWorker | null = null
let pedidoDeInstalacao: BeforeInstallPromptEvent | null = null
const ouvintes = new Set<() => void>()

function mudar(patch: Partial<PwaState>) {
  estado = { ...estado, ...patch }
  ouvintes.forEach((fn) => fn())
}

/** O endereço do SW: a versão é o commit do build (`?v=`), que o SW usa no nome do cache. */
export function serviceWorkerUrl(commit: string): string {
  const versao = String(commit || '').replace(/[^A-Za-z0-9._-]/g, '')
  return versao ? `/sw.js?v=${versao}` : '/sw.js'
}

/** Roda como app instalado? (Android/desktop pelo display-mode; iOS pelo `navigator.standalone`.) */
export function isStandalone(win: { matchMedia?: (q: string) => { matches: boolean }; navigator?: unknown } = window): boolean {
  try {
    if (win.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch {
    /* sem matchMedia */
  }
  return Boolean((win.navigator as { standalone?: boolean } | undefined)?.standalone)
}

function acompanhar(reg: ServiceWorkerRegistration) {
  const marcarSeEsperando = () => {
    // Só é "versão nova" quando já havia um SW no controle: na primeira
    // instalação não há o que atualizar.
    if (reg.waiting && navigator.serviceWorker.controller) {
      esperando = reg.waiting
      mudar({ updateReady: true })
    }
  }
  marcarSeEsperando()
  reg.addEventListener('updatefound', () => {
    const novo = reg.installing
    if (!novo) return
    novo.addEventListener('statechange', () => {
      if (novo.state === 'installed') marcarSeEsperando()
    })
  })
}

let registrado = false

/** Registra o SW e liga os ouvintes. Só produção, só uma vez, nunca lança. */
export function registerServiceWorker(options: { production?: boolean; commit?: string } = {}): void {
  const production = options.production ?? import.meta.env.PROD
  if (registrado || typeof window === 'undefined') return
  registrado = true

  mudar({ standalone: isStandalone() })
  window.addEventListener('beforeinstallprompt', (event) => {
    // Guardado para o botão; sem isto o Chrome mostra a barra dele na hora errada.
    event.preventDefault()
    pedidoDeInstalacao = event as BeforeInstallPromptEvent
    mudar({ canInstall: true })
  })
  window.addEventListener('appinstalled', () => {
    pedidoDeInstalacao = null
    mudar({ canInstall: false, standalone: true })
  })

  if (!production || !('serviceWorker' in navigator)) return
  let recarregando = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // O SW novo assumiu porque a pessoa pediu (`applyUpdate`): a página
    // recarrega uma vez para pegar os assets dele.
    if (!esperando || recarregando) return
    recarregando = true
    window.location.reload()
  })
  const registrar = () => {
    navigator.serviceWorker
      .register(serviceWorkerUrl(options.commit ?? __APP_COMMIT__), { scope: '/' })
      .then((reg) => {
        acompanhar(reg)
        // Aba aberta o dia inteiro: procura versão nova a cada hora.
        window.setInterval(() => { void reg.update().catch(() => undefined) }, 60 * 60 * 1000)
      })
      .catch(() => undefined)
  }
  if (document.readyState === 'complete') registrar()
  else window.addEventListener('load', registrar, { once: true })
}

/** "Atualizar agora": o SW esperando assume, e a página recarrega. */
export function applyUpdate(): void {
  if (esperando) esperando.postMessage({ type: 'SKIP_WAITING' })
  else window.location.reload()
}

export function dismissUpdate(): void {
  mudar({ updateReady: false })
}

/** Pede a instalação ao navegador. Devolve se a pessoa aceitou. */
export async function promptInstall(): Promise<boolean> {
  const pedido = pedidoDeInstalacao
  if (!pedido) return false
  pedidoDeInstalacao = null
  mudar({ canInstall: false })
  try {
    await pedido.prompt()
    const { outcome } = await pedido.userChoice
    return outcome === 'accepted'
  } catch {
    return false
  }
}

export function usePwa(): PwaState {
  return useSyncExternalStore(
    (fn) => {
      ouvintes.add(fn)
      return () => ouvintes.delete(fn)
    },
    () => estado,
    () => estado,
  )
}
