import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startVisibleInterval, type VisibilitySource } from '@/lib/visible-interval'

/** Um `document` de mentira: só o `hidden` e o evento que o relógio escuta. */
function fakeDocument(hidden = false) {
  const listeners = new Set<() => void>()
  const doc = {
    hidden,
    addEventListener: (_type: 'visibilitychange', fn: () => void) => { listeners.add(fn) },
    removeEventListener: (_type: 'visibilitychange', fn: () => void) => { listeners.delete(fn) },
  }
  const set = (value: boolean) => {
    doc.hidden = value
    listeners.forEach((fn) => fn())
  }
  return { doc: doc as VisibilitySource, set, listeners }
}

/**
 * O relógio das leituras periódicas (mapa ao vivo, portal, faixas do
 * WhatsApp): com a aba escondida não pode bater no servidor, e quando ela
 * volta precisa ler na hora em vez de esperar o próximo minuto.
 */
describe('relógio só com a aba à vista', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('lê a cada intervalo com a aba à vista', () => {
    const { doc } = fakeDocument()
    const tick = vi.fn()
    const stop = startVisibleInterval(tick, 1000, doc)
    vi.advanceTimersByTime(3000)
    expect(tick).toHaveBeenCalledTimes(3)
    stop()
  })

  it('para de ler com a aba escondida e lê uma vez ao voltar', () => {
    const { doc, set } = fakeDocument()
    const tick = vi.fn()
    const stop = startVisibleInterval(tick, 1000, doc)
    set(true)
    vi.advanceTimersByTime(10_000)
    expect(tick).not.toHaveBeenCalled()
    set(false)
    expect(tick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(2)
    stop()
  })

  it('não começa a contar se a tela abriu escondida', () => {
    const { doc } = fakeDocument(true)
    const tick = vi.fn()
    const stop = startVisibleInterval(tick, 1000, doc)
    vi.advanceTimersByTime(5000)
    expect(tick).not.toHaveBeenCalled()
    stop()
  })

  it('um segundo aviso de "à vista" não dobra a leitura', () => {
    const { doc, set } = fakeDocument()
    const tick = vi.fn()
    const stop = startVisibleInterval(tick, 1000, doc)
    set(false)
    expect(tick).not.toHaveBeenCalled()
    stop()
  })

  it('desligar solta o relógio e o evento', () => {
    const { doc, listeners } = fakeDocument()
    const tick = vi.fn()
    const stop = startVisibleInterval(tick, 1000, doc)
    stop()
    vi.advanceTimersByTime(5000)
    expect(tick).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })
})
