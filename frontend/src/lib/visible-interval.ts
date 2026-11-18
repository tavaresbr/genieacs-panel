import { useEffect, useRef } from 'react'

/**
 * O pedaço do `document` que o relógio usa — separado para o teste trocar
 * por um falso sem DOM (o Vitest roda em `node`).
 */
export interface VisibilitySource {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * Chama `tick` a cada `ms` só enquanto a aba está à vista. Com a aba
 * escondida o relógio para de vez — não é só pular a leitura: um operador
 * com o painel aberto em dez abas não pode virar dez leituras por minuto no
 * servidor. Quando a aba volta, lê uma vez na hora (o que estava na tela
 * pode ter horas) e o relógio recomeça a contar dali.
 *
 * Não faz a primeira leitura: quem chama já carrega ao montar, e assim não
 * há leitura dobrada na abertura da tela. Devolve a função que desliga tudo.
 */
export function startVisibleInterval(
  tick: () => void,
  ms: number,
  doc: VisibilitySource = document,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  const start = () => {
    if (timer === undefined) timer = setInterval(tick, ms)
  }
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const onVisibility = () => {
    if (doc.hidden) {
      stop()
      return
    }
    // A aba já estava contando (dois eventos seguidos): não lê de novo.
    if (timer !== undefined) return
    tick()
    start()
  }
  if (!doc.hidden) start()
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    stop()
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}

/**
 * `startVisibleInterval` como hook. A função lida é sempre a mais recente
 * (via ref), então trocar `tick` não reinicia o relógio; `enabled` falso
 * desliga tudo (portal deslogado, por exemplo).
 */
export function useVisibleInterval(tick: () => void, ms: number, enabled = true) {
  const tickRef = useRef(tick)
  useEffect(() => { tickRef.current = tick }, [tick])
  useEffect(() => {
    if (!enabled) return undefined
    return startVisibleInterval(() => tickRef.current(), ms)
  }, [enabled, ms])
}
