import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PLATFORM_TAB, PLATFORM_TABS, deltaText, deltaTone, parsePlatformTab, withPlatformTab
} from '@/lib/platform-overview'
import en from '@/lib/i18n/locales/en'

/** As peças puras do console: a aba na URL e a leitura da variação do `StatTile`. */

describe('a aba na URL', () => {
  it('Início é a primeira e a padrão', () => {
    expect(PLATFORM_TABS[0]).toBe('home')
    expect(DEFAULT_PLATFORM_TAB).toBe('home')
  })

  it('lê a aba conhecida e ignora o resto', () => {
    expect(parsePlatformTab('revenue')).toBe('revenue')
    expect(parsePlatformTab(' delinquency ')).toBe('delinquency')
    expect(parsePlatformTab(null)).toBe('home')
    expect(parsePlatformTab(undefined)).toBe('home')
    expect(parsePlatformTab('')).toBe('home')
    expect(parsePlatformTab('nao-existe')).toBe('home')
    expect(parsePlatformTab('Revenue')).toBe('home')
    expect(parsePlatformTab('constructor')).toBe('home')
  })

  it('troca a aba mantendo os outros parâmetros; a padrão sai da URL', () => {
    expect(withPlatformTab('?tab=plans&x=1', 'revenue').toString()).toBe('tab=revenue&x=1')
    expect(withPlatformTab('x=1', 'settings').toString()).toBe('x=1&tab=settings')
    expect(withPlatformTab('?tab=plans&x=1', 'home').toString()).toBe('x=1')
    expect(withPlatformTab(new URLSearchParams('tab=help'), 'home').toString()).toBe('')
  })

  it('toda aba tem rótulo', () => {
    for (const tab of PLATFORM_TABS) expect(en).toHaveProperty(`platform.tabs.${tab}`)
  })
})

describe('a variação do StatTile', () => {
  it('o tom: subir é bom, a não ser onde subir é ruim', () => {
    expect(deltaTone(10)).toBe('good')
    expect(deltaTone(-10)).toBe('bad')
    expect(deltaTone(10, true)).toBe('bad')
    expect(deltaTone(-10, true)).toBe('good')
    expect(deltaTone(0)).toBe('neutral')
    expect(deltaTone(null)).toBe('neutral')
    expect(deltaTone(undefined)).toBe('neutral')
  })

  it('o texto: sinal, valor absoluto e porcentagem', () => {
    const fmt = (n: number) => `R$${n}`
    expect(deltaText(50, 0.5, fmt, 'en-US')).toBe('+R$50 (+50%)')
    expect(deltaText(-25, -0.125, fmt, 'en-US')).toBe('-R$25 (-12.5%)')
    expect(deltaText(3, null, String, 'en-US')).toBe('+3')
    // O formato que já põe sinal não duplica.
    expect(deltaText(-2, null, (n) => `${n > 0 ? '+' : ''}${n}`, 'en-US')).toBe('-2')
    expect(deltaText(0, 0, fmt, 'en-US')).toBeNull()
    expect(deltaText(null, null, fmt, 'en-US')).toBeNull()
  })
})
