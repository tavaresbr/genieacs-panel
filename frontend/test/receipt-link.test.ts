import { describe, expect, it } from 'vitest'
import { readReceiptToken } from '@/lib/receipt-link'

describe('o token do recibo no fragmento', () => {
  const valido = `${'cjEuMTIuMzQ1LjE3MDAwMDAwMDAwMDA'}.${'A'.repeat(43)}`

  it('aceita o formato do servidor, com ou sem o #', () => {
    expect(readReceiptToken(`#${valido}`)).toBe(valido)
    expect(readReceiptToken(valido)).toBe(valido)
  })

  it('recusa o resto', () => {
    expect(readReceiptToken('')).toBeNull()
    expect(readReceiptToken(null)).toBeNull()
    expect(readReceiptToken('#nao-e-um-token')).toBeNull()
    expect(readReceiptToken(`#${valido}.extra`)).toBeNull()
    expect(readReceiptToken('#<script>.x')).toBeNull()
  })
})
