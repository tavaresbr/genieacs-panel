import { describe, expect, it } from 'vitest'
import { addressPayload, applyCep, emptyAddressForm, maskCep, sameAddress } from '../src/lib/contact-address'

const filled = { ...emptyAddressForm(), street: 'RUA CASTELO BRANCO', number: '7', district: 'URUARA', city: 'SANTAREM', state: 'PA', zip: '68181-190' }

describe('applyCep', () => {
  it('a new CEP replaces what it knows and keeps number and complement', () => {
    const next = applyCep(filled, { addressLine: 'Rua Nova', district: 'Centro', city: 'Óbidos', state: 'AM' }, true)
    expect(next).toMatchObject({ street: 'Rua Nova', district: 'Centro', city: 'Óbidos', state: 'AM', number: '7' })
  })

  it('a city-wide CEP does not wipe the street', () => {
    const next = applyCep(filled, { city: 'Óbidos', state: 'AM' }, true)
    expect(next.street).toBe('RUA CASTELO BRANCO')
    expect(next.city).toBe('Óbidos')
  })

  it('the same CEP only completes what is empty', () => {
    const next = applyCep({ ...filled, district: '' }, { addressLine: 'Outra', district: 'Centro', city: 'X', state: 'ZZ' }, false)
    expect(next).toMatchObject({ street: 'RUA CASTELO BRANCO', district: 'Centro', city: 'SANTAREM', state: 'PA' })
  })
})

describe('address helpers', () => {
  it('masks the CEP as typed', () => {
    expect(maskCep('68181190')).toBe('68181-190')
    expect(maskCep('681')).toBe('681')
  })

  it('leaves empty parts out of the payload and compares trimmed', () => {
    expect(addressPayload({ ...emptyAddressForm(), street: ' Rua A ', number: '' })).toEqual({ street: 'Rua A' })
    expect(sameAddress(filled, { ...filled, street: ' RUA CASTELO BRANCO ' })).toBe(true)
  })
})
