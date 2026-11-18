/**
 * Trava de rolagem da página, compartilhada.
 *
 * Gaveta do menu, modais e a página do WhatsApp travam o `overflow` do `body`.
 * O padrão antigo (guardar o valor atual e restaurar na saída) só funciona se as
 * travas forem desfeitas na ordem inversa: com a gaveta aberta ao entrar no
 * WhatsApp, o valor guardado era `hidden` e a página ficava sem rolagem para
 * sempre. Aqui cada quem pega e solta a sua trava e o `overflow` só volta ao
 * normal quando a última é solta.
 */
let bodyLocks = 0
let rootLocks = 0

type Doc = { documentElement: { style: Record<string, string> }; body: { style: Record<string, string> } }

function doc(): Doc | null {
  return (globalThis as unknown as { document?: Doc }).document ?? null
}

function apply(): void {
  const d = doc()
  if (!d) return
  const any = bodyLocks + rootLocks > 0
  d.body.style.overflow = any ? 'hidden' : ''
  d.documentElement.style.overflow = rootLocks > 0 ? 'hidden' : ''
  d.body.style.overscrollBehavior = rootLocks > 0 ? 'none' : ''
}

/** Trava só o `body` (modais, gaveta). Devolve a função que solta. */
export function lockBody(): () => void {
  let released = false
  bodyLocks += 1
  apply()
  return () => {
    if (released) return
    released = true
    bodyLocks -= 1
    apply()
  }
}

/** Trava `html` e `body`, sem rubber-band (página do WhatsApp no celular). */
export function lockRoot(): () => void {
  let released = false
  rootLocks += 1
  apply()
  return () => {
    if (released) return
    released = true
    rootLocks -= 1
    apply()
  }
}

/**
 * Solta a trava por um quadro e a refaz conforme as travas que existirem então
 * (não as de quando foi chamada): quem saiu nesse meio-tempo não é travado de novo.
 */
export function pulseLock(schedule: (cb: () => void) => unknown = (cb) => globalThis.requestAnimationFrame(cb)): void {
  const d = doc()
  if (!d) return
  d.body.style.overflow = ''
  d.documentElement.style.overflow = ''
  schedule(apply)
}

/** Só para teste. */
export function lockCounts(): { body: number; root: number } {
  return { body: bodyLocks, root: rootLocks }
}
