import { describe, expect, it } from 'vitest'
import { parseAmountToCents } from '@/lib/utils'

/**
 * O valor de um pagamento, digitado por uma pessoa.
 *
 * A escrita anterior trocava só a PRIMEIRA vírgula por ponto, então
 * `"1.234"` — mil duzentos e trinta e quatro reais — virava `1.234` e era
 * aceito em silêncio como 123 centavos. É dinheiro, e o erro não aparecia em
 * lugar nenhum: os campos limpavam e o extrato recarregava igual.
 */
describe('parseAmountToCents', () => {
  it('lê o formato brasileiro, com e sem milhar', () => {
    expect(parseAmountToCents('199,90')).toBe(19990)
    expect(parseAmountToCents('1.234,56')).toBe(123456)
    expect(parseAmountToCents('1.234.567,89')).toBe(123456789)
    expect(parseAmountToCents('0,01')).toBe(1)
  })

  it('lê o ponto como decimal quando não há vírgula', () => {
    // O que sai de um teclado numérico.
    expect(parseAmountToCents('199.90')).toBe(19990)
    expect(parseAmountToCents('1500')).toBe(150000)
    expect(parseAmountToCents('0.5')).toBe(50)
  })

  it('RECUSA o ambíguo em vez de adivinhar', () => {
    // "1.234" pode ser mil duzentos e trinta e quatro, ou um e vinte e três.
    // Errar aqui é errar por mil vezes, para um lado ou para o outro.
    expect(parseAmountToCents('1.234')).toBeNull()
    expect(parseAmountToCents('12.500')).toBeNull()
  })

  it('recusa o que não é número', () => {
    expect(parseAmountToCents('')).toBeNull()
    expect(parseAmountToCents('abc')).toBeNull()
    expect(parseAmountToCents('R$ 10,00')).toBeNull()
    expect(parseAmountToCents('1,2,3')).toBeNull()
    expect(parseAmountToCents('-5')).toBeNull()
  })

  it('não perde centavo no ponto flutuante', () => {
    expect(parseAmountToCents('0,07')).toBe(7)
    expect(parseAmountToCents('1,10')).toBe(110)
    expect(parseAmountToCents('29,99')).toBe(2999)
  })
})
