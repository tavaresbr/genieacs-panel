import { describe, expect, it } from 'vitest'
import { formatDocument } from '../src/lib/document'

describe('formatDocument', () => {
  it('CPF e CNPJ ganham a pontuação', () => {
    expect(formatDocument('12345678900')).toBe('123.456.789-00')
    expect(formatDocument('12345678000199')).toBe('12.345.678/0001-99')
  })
  it('já pontuado continua igual, e outro tamanho sai como veio', () => {
    expect(formatDocument('123.456.789-00')).toBe('123.456.789-00')
    expect(formatDocument('12345')).toBe('12345')
    expect(formatDocument(null)).toBe('')
  })
})
