import { describe, expect, it } from 'vitest'

import {
  NPS_SCORES, distributionMax, formatNps, npsCategory, npsTone, readNpsToken, subscriptionHref
} from '@/lib/nps'
import { NPS_SIGNAL_KEYS, NPS_WAVE_KEYS } from '@/components/platform/platform-satisfaction'
import en from '@/lib/i18n/locales/en'

/** As peças puras da pesquisa de satisfação dos provedores (NPS, 0123). */
describe('a pesquisa de satisfação', () => {
  it('tem onze notas, de 0 a 10', () => {
    expect([...NPS_SCORES]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('classifica como o backend: 9–10 promotor, 7–8 neutro, 0–6 detrator', () => {
    expect(npsCategory(10)).toBe('promoter')
    expect(npsCategory(9)).toBe('promoter')
    expect(npsCategory(8)).toBe('passive')
    expect(npsCategory(7)).toBe('passive')
    expect(npsCategory(6)).toBe('detractor')
    expect(npsCategory(0)).toBe('detractor')
  })

  it('o tom e o texto do NPS', () => {
    expect(npsTone(50)).toBe('good')
    expect(npsTone(10)).toBe('neutral')
    expect(npsTone(-5)).toBe('bad')
    expect(npsTone(null)).toBe('neutral')
    expect(formatNps(42)).toBe('+42')
    expect(formatNps(-10)).toBe('-10')
    expect(formatNps(0)).toBe('0')
    expect(formatNps(null)).toBe('—')
  })

  it('lê o token só do fragmento e só no alfabeto do base64url', () => {
    const token = 'a'.repeat(43)
    expect(readNpsToken(`#${token}`)).toBe(token)
    expect(readNpsToken(token)).toBe(token)
    expect(readNpsToken('#curto')).toBeNull()
    expect(readNpsToken('#../../etc/passwd-aaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull()
    expect(readNpsToken('')).toBeNull()
    expect(readNpsToken(null)).toBeNull()
  })

  it('leva à assinatura pela aba Assinaturas filtrada', () => {
    expect(subscriptionHref({ id: 3, slug: 'beta net', name: 'Beta' })).toBe('/platform?tab=subscriptions&q=beta%20net')
    expect(subscriptionHref({ id: 3, slug: null, name: null })).toBe('/platform?tab=subscriptions&q=3')
  })

  it('a escala da distribuição nunca é zero', () => {
    expect(distributionMax([0, 0, 0])).toBe(1)
    expect(distributionMax([1, 5, 2])).toBe(5)
  })

  it('todo sinal e toda etapa têm texto', () => {
    for (const chave of [...Object.values(NPS_SIGNAL_KEYS), ...Object.values(NPS_WAVE_KEYS)]) {
      expect(en[chave]).toBeTruthy()
    }
  })
})
