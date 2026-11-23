import { describe, expect, it } from 'vitest'
import { brazilDigits, hasContact, mailtoHref, messengerHref, telHref, whatsappHref } from '@/lib/portal-contact'

describe('portal-contact', () => {
  it('normaliza telefone brasileiro para 55 + DDD + número', () => {
    expect(brazilDigits('(93) 3518-0000')).toBe('559335180000')
    expect(brazilDigits('93 99100-2222')).toBe('5593991002222')
    expect(brazilDigits('+55 93 99100-2222')).toBe('5593991002222')
    expect(brazilDigits('3518-0000')).toBeNull()
    expect(brazilDigits('')).toBeNull()
  })

  it('monta os links de discar, WhatsApp e e-mail', () => {
    expect(telHref('(93) 3518-0000')).toBe('tel:+559335180000')
    expect(whatsappHref('93 99100-2222')).toBe('https://wa.me/5593991002222')
    expect(mailtoHref('suporte@fibra.test')).toBe('mailto:suporte@fibra.test')
    expect(mailtoHref('javascript:alert(1)')).toBeNull()
    expect(whatsappHref(null)).toBeNull()
  })

  it('o cartão só aparece ligado e com algum dado', () => {
    expect(hasContact(null)).toBe(false)
    expect(hasContact({ enabled: false })).toBe(false)
    expect(hasContact({ enabled: true, name: 'Fibra' })).toBe(false)
    expect(hasContact({ enabled: true, name: 'Fibra', phone: '93 3518-0000' })).toBe(true)
  })

  it('o Messenger conta como contato, mesmo sem telefone nem e-mail', () => {
    expect(hasContact({ enabled: true, name: 'Fibra', messenger: true })).toBe(true)
    expect(hasContact({ enabled: true, name: 'Fibra', messenger: false })).toBe(false)
  })

  it('só navega para um link m.me da Página com o ref do painel', () => {
    const ok = 'https://m.me/1000000001?ref=AbCdEfGhIjKlMnOpQrStUv'
    expect(messengerHref(ok)).toBe(ok)
    expect(messengerHref('http://m.me/1000000001?ref=AbCdEfGhIjKlMnOpQrStUv')).toBeNull()
    expect(messengerHref('https://m.me.evil.test/1000000001?ref=AbCdEfGhIjKlMnOpQrStUv')).toBeNull()
    expect(messengerHref('https://evil.test/?u=https://m.me/1000000001?ref=AbCdEfGhIjKlMnOpQrStUv')).toBeNull()
    expect(messengerHref('https://m.me/nome-da-pagina?ref=AbCdEfGhIjKlMnOpQrStUv')).toBeNull()
    expect(messengerHref('https://m.me/1000000001?ref=curto')).toBeNull()
    expect(messengerHref('javascript:alert(1)')).toBeNull()
    expect(messengerHref(undefined)).toBeNull()
  })
})
