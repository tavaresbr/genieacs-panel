import { useSyncExternalStore } from 'react'

/**
 * O que a barra de atalhos do celular (`components/mobile-tab-bar.tsx`) precisa
 * saber das telas: se alguma pediu para escondê-la (a conversa aberta do
 * WhatsApp usa a tela toda) e quantas mensagens não lidas há.
 *
 * Um estado pequeno fora do React, porque quem esconde a barra (uma página) e
 * quem a desenha (a casca) não têm pai em comum além da raiz.
 */
type State = { hiddenBy: ReadonlySet<string>; whatsappUnread: number }

let state: State = { hiddenBy: new Set(), whatsappUnread: 0 }
const listeners = new Set<() => void>()

function publish(next: State) {
  state = next
  listeners.forEach((listener) => listener())
}

export function subscribeMobileBar(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getMobileBar(): State {
  return state
}

/** Uma tela pede (ou deixa de pedir) a barra escondida; `reason` identifica quem pediu. */
export function setMobileBarHidden(reason: string, hidden: boolean) {
  if (state.hiddenBy.has(reason) === hidden) return
  const hiddenBy = new Set(state.hiddenBy)
  if (hidden) hiddenBy.add(reason)
  else hiddenBy.delete(reason)
  publish({ ...state, hiddenBy })
}

export function setMobileBarUnread(count: number) {
  const next = Math.max(0, Math.floor(count) || 0)
  if (state.whatsappUnread === next) return
  publish({ ...state, whatsappUnread: next })
}

export function useMobileBar(): State {
  return useSyncExternalStore(subscribeMobileBar, getMobileBar, getMobileBar)
}

/** Quais atalhos a barra mostra, na ordem dela. Cada um é uma tela do menu (`lib/screens.ts`). */
export const TAB_BAR_HREFS = ['/dashboard', '/whatsapp', '/network-map', '/settings'] as const
