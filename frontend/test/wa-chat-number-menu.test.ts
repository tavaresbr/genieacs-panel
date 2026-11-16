import { describe, expect, it } from 'vitest'
import { pickableAccounts } from '@/components/whatsapp/chat-number-menu'
import type { WhatsAppAccount } from '@/lib/api'

const conta = (id: number, extra: Partial<WhatsAppAccount> = {}) =>
  ({ id, name: `n${id}`, label: null, purpose: 'support', color: null, status: 'connected', isDefault: false, ...extra }) as unknown as WhatsAppAccount

describe('pickableAccounts', () => {
  it('só os conectados', () => {
    expect(pickableAccounts([conta(1), conta(2, { status: 'disconnected' }), conta(3, { status: 'connecting' })]).map((a) => a.id)).toEqual([1])
  })

  it('o padrão vem primeiro: general, depois o padrão da instalação, depois o menor id', () => {
    const lista = pickableAccounts([conta(1), conta(2, { isDefault: true }), conta(3, { purpose: 'general' }), conta(4)])
    expect(lista.map((a) => a.id)).toEqual([3, 2, 1, 4])
  })

  it('não altera a lista recebida', () => {
    const entrada = [conta(2), conta(1, { purpose: 'general' })]
    pickableAccounts(entrada)
    expect(entrada.map((a) => a.id)).toEqual([2, 1])
  })

  it('sem números, lista vazia (o botão segue direto, como sempre foi)', () => {
    expect(pickableAccounts([])).toEqual([])
  })
})
