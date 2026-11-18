import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lockBody, lockCounts, lockRoot, pulseLock } from '../src/lib/body-lock'

const fake = () => ({ documentElement: { style: {} as Record<string, string> }, body: { style: {} as Record<string, string> } })
let d: ReturnType<typeof fake>

beforeEach(() => {
  d = fake()
  ;(globalThis as unknown as { document: unknown }).document = d
})
afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document
})

describe('body-lock', () => {
  it('a gaveta aberta ao entrar no WhatsApp não deixa a página travada ao sair', () => {
    const soltaGaveta = lockBody()
    const soltaPagina = lockRoot()
    soltaGaveta() // a gaveta fecha primeiro (ordem que quebrava o padrão antigo)
    expect(d.body.style.overflow).toBe('hidden') // a página do WhatsApp ainda precisa
    soltaPagina()
    expect(d.body.style.overflow).toBe('')
    expect(d.documentElement.style.overflow).toBe('')
    expect(lockCounts()).toEqual({ body: 0, root: 0 })
  })
  it('soltar duas vezes não destrava a trava de outro', () => {
    const a = lockBody()
    const b = lockBody()
    a(); a()
    expect(d.body.style.overflow).toBe('hidden')
    b()
    expect(d.body.style.overflow).toBe('')
  })
  it('pulso: solta e refaz conforme as travas de então', () => {
    const solta = lockRoot()
    let refaz: () => void = () => {}
    pulseLock((cb) => { refaz = cb })
    expect(d.body.style.overflow).toBe('')
    solta() // saiu da página no meio do pulso
    refaz()
    expect(d.body.style.overflow).toBe('')
    expect(d.documentElement.style.overflow).toBe('')
  })
})
