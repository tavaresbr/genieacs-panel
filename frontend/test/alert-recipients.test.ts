import { describe, expect, it } from 'vitest'
import { addRecipient, formatPhone, parseEmail, parsePhone, removeRecipient } from '../src/lib/alert-recipients'

describe('parsePhone', () => {
  it('DDD + telefone ganha o 55; com o 55 já digitado fica', () => {
    expect(parsePhone('(93) 98121-5425')).toEqual({ ok: true, value: '5593981215425' })
    expect(parsePhone('93 3522-1234')).toEqual({ ok: true, value: '559335221234' })
    expect(parsePhone('+55 93 98121-5425')).toEqual({ ok: true, value: '5593981215425' })
    expect(parsePhone('5593981215425')).toEqual({ ok: true, value: '5593981215425' })
  })
  it('número de outro país com "+"', () => {
    expect(parsePhone('+1 415 555 2671')).toEqual({ ok: true, value: '14155552671' })
    expect(parsePhone('+351 912 345 678')).toEqual({ ok: true, value: '351912345678' })
  })
  it('incompleto, longo e vazio', () => {
    expect(parsePhone('98121-5425')).toEqual({ ok: false, error: 'short' }) // 9 dígitos: falta o DDD
    expect(parsePhone('')).toEqual({ ok: false, error: 'empty' })
    expect(parsePhone('abc')).toEqual({ ok: false, error: 'empty' })
    expect(parsePhone('559398121542599')).toEqual({ ok: false, error: 'long' })
  })
})

describe('formatPhone', () => {
  it('celular de 13 e fixo de 12 dígitos, e fora do Brasil', () => {
    expect(formatPhone('5593981215425')).toBe('+55 (93) 98121-5425')
    expect(formatPhone('559335221234')).toBe('+55 (93) 3522-1234')
    expect(formatPhone('14155552671')).toBe('+14155552671')
  })
})

describe('parseEmail', () => {
  it('minúsculas e formato', () => {
    expect(parseEmail(' Plantao@Provedor.com.br ')).toBe('plantao@provedor.com.br')
    expect(parseEmail('sem-arroba')).toBeNull()
    expect(parseEmail('a@b')).toBeNull()
  })
})

describe('addRecipient / removeRecipient', () => {
  it('acrescenta, recusa repetido e passa do máximo', () => {
    const a = addRecipient('phone', [], '(93) 98121-5425')
    expect(a).toEqual({ ok: true, list: ['5593981215425'], value: '5593981215425' })
    expect(addRecipient('phone', ['5593981215425'], '93981215425')).toEqual({ ok: false, error: 'duplicate' })
    expect(addRecipient('phone', Array.from({ length: 20 }, (_, i) => `55939812154${String(i).padStart(2, '0')}`), '(93) 99999-0000')).toEqual({ ok: false, error: 'max' })
    expect(addRecipient('phone', [], '123')).toEqual({ ok: false, error: 'short' })
  })
  it('e-mail: inválido e repetido', () => {
    expect(addRecipient('email', [], 'foo')).toEqual({ ok: false, error: 'invalid' })
    expect(addRecipient('email', ['a@b.co'], 'A@B.CO')).toEqual({ ok: false, error: 'duplicate' })
    expect(addRecipient('email', [], '  ')).toEqual({ ok: false, error: 'empty' })
  })
  it('remove só o item pedido', () => {
    expect(removeRecipient(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })
})
