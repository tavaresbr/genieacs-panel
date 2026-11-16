import { describe, expect, it } from 'vitest'
import { GET_TIMEOUT_MS, readTimeoutSignal } from '@/lib/api'

describe('readTimeoutSignal', () => {
  it('dá um teto de tempo às leituras (GET, ou sem método)', () => {
    expect(readTimeoutSignal(undefined)).toBeInstanceOf(AbortSignal)
    expect(readTimeoutSignal('GET')).toBeInstanceOf(AbortSignal)
    expect(readTimeoutSignal('get')).toBeInstanceOf(AbortSignal)
    expect(GET_TIMEOUT_MS).toBe(30_000)
  })

  it('não corta escritas: envio e upload lentos seguem até o fim', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(readTimeoutSignal(method)).toBeUndefined()
  })

  it('quem passou o próprio sinal manda nele', () => {
    const meu = new AbortController().signal
    expect(readTimeoutSignal('GET', meu)).toBe(meu)
    expect(readTimeoutSignal('POST', meu)).toBe(meu)
  })

  it('o sinal da leitura de fato aborta pendurado (o pedido que nunca volta)', async () => {
    const curto = AbortSignal.timeout(20)
    const pendurado = new Promise((_, reject) => curto.addEventListener('abort', () => reject(new Error('timeout'))))
    await expect(pendurado).rejects.toThrow('timeout')
  })
})
