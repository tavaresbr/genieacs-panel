import { describe, expect, it } from 'vitest'
import { isFormDirty, minutesToSeconds, secondsToMinutes } from '../src/lib/alert-form'

describe('secondsToMinutes', () => {
  it('converte e prende nos limites do servidor', () => {
    expect(secondsToMinutes(60)).toBe('1')
    expect(secondsToMinutes(300)).toBe('5')
    expect(secondsToMinutes(3600)).toBe('60')
    expect(secondsToMinutes(30)).toBe('1')
    expect(secondsToMinutes(99999)).toBe('60')
    expect(secondsToMinutes(Number.NaN)).toBe('1')
  })
})

describe('minutesToSeconds', () => {
  it('digitar 5 minutos é 300 segundos, não 60', () => {
    expect(minutesToSeconds('5', 60)).toBe(300)
    expect(minutesToSeconds(' 10 ', 60)).toBe(600)
  })
  it('fora dos limites é puxado para eles', () => {
    expect(minutesToSeconds('0', 300)).toBe(60)
    expect(minutesToSeconds('-3', 300)).toBe(60)
    expect(minutesToSeconds('999', 300)).toBe(3600)
    expect(minutesToSeconds('2.6', 300)).toBe(180)
  })
  it('vazio ou ilegível mantém o que estava guardado', () => {
    expect(minutesToSeconds('', 420)).toBe(420)
    expect(minutesToSeconds('abc', 420)).toBe(420)
  })
})

describe('isFormDirty', () => {
  const base = { enabled: true, intervalMinutes: '5', recipients: ['5593981215425'], telegram: { token: '', chatId: '', remove: false } }
  it('igual ao salvo não está sujo, ainda que seja outro objeto', () => {
    expect(isFormDirty({ ...base, recipients: [...base.recipients] }, base)).toBe(false)
  })
  it('qualquer mudança suja, inclusive um token digitado', () => {
    expect(isFormDirty({ ...base, intervalMinutes: '6' }, base)).toBe(true)
    expect(isFormDirty({ ...base, recipients: [] }, base)).toBe(true)
    expect(isFormDirty({ ...base, telegram: { ...base.telegram, token: 'x' } }, base)).toBe(true)
  })
})
