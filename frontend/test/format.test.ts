import { afterEach, describe, expect, it } from 'vitest'

import { loadDictionary, setActiveLocale } from '@/lib/i18n'
import {
  cn,
  formatDate,
  formatNumber,
  getSignalStrengthColor,
  getStatusColor
} from '@/lib/utils'

afterEach(() => {
  setActiveLocale('pt-BR')
})

describe('abbreviating a count', () => {
  it('leaves anything under a thousand alone', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(1)).toBe('1')
    expect(formatNumber(999)).toBe('999')
  })

  it('abbreviates thousands and millions', () => {
    expect(formatNumber(1000)).toBe('1.0K')
    expect(formatNumber(1500)).toBe('1.5K')
    expect(formatNumber(999999)).toBe('1000.0K')
    expect(formatNumber(1000000)).toBe('1.0M')
    expect(formatNumber(2500000)).toBe('2.5M')
  })

  /**
   * A fleet counter never goes negative, but the function is exported and the
   * behaviour should be written down rather than discovered: below zero it
   * abbreviates nothing.
   */
  it('does not abbreviate a negative', () => {
    expect(formatNumber(-1500)).toBe('-1500')
  })
})

describe('the colour of an optical reading', () => {
  /**
   * These thresholds are what an operator reads at a glance to decide whether
   * to send someone to a pole. The boundaries are inclusive on the good side,
   * which is the part worth pinning: -25 is still green, -25.1 is not.
   */
  it('follows the thresholds, boundary included', () => {
    expect(getSignalStrengthColor(-10)).toContain('green')
    expect(getSignalStrengthColor(-25)).toContain('green')
    expect(getSignalStrengthColor(-25.1)).toContain('yellow')
    expect(getSignalStrengthColor(-50)).toContain('yellow')
    expect(getSignalStrengthColor(-50.1)).toContain('orange')
    expect(getSignalStrengthColor(-75)).toContain('orange')
    expect(getSignalStrengthColor(-75.1)).toContain('red')
  })

  /**
   * No reading is not a bad reading. Painting an absent value red would send a
   * technician after an ONT that never reported its power at all.
   */
  it('paints an absent reading grey, not red', () => {
    expect(getSignalStrengthColor(null)).toBe('text-gray-500')
    expect(getSignalStrengthColor(undefined)).toBe('text-gray-500')
  })
})

describe('the colour of a status', () => {
  it('reads both spellings of each state', () => {
    expect(getStatusColor('online')).toBe(getStatusColor('up'))
    expect(getStatusColor('offline')).toBe(getStatusColor('down'))
    expect(getStatusColor('ONLINE')).toBe(getStatusColor('online'))
  })

  it('gives an unknown status the neutral colour, not a green one', () => {
    const neutral = getStatusColor('whatever-this-is')
    expect(neutral).toContain('gray')
    expect(neutral).not.toContain('green')
  })

  it('carries a dark-mode variant for every state it knows', () => {
    for (const status of ['online', 'offline', 'warning', 'unknown']) {
      expect(getStatusColor(status), status).toContain('dark:')
    }
  })
})

describe('formatting a timestamp', () => {
  const ISO = '2026-03-04T15:06:07.000Z'

  it('renders a real timestamp in the active locale', () => {
    setActiveLocale('pt-BR')
    const rendered = formatDate(ISO)
    // Two-digit, 24-hour, and carrying the date — not asserting the exact
    // punctuation, which belongs to Intl and changes with ICU.
    expect(rendered).toMatch(/\d{2}/)
    expect(rendered).not.toContain('NaN')
  })

  it('says so, translated, when there is nothing to format', () => {
    setActiveLocale('en')
    expect(formatDate(null)).toBe('N/A')
    expect(formatDate(undefined)).toBe('N/A')
    expect(formatDate('')).toBe('N/A')
  })

  /**
   * A malformed timestamp used to render as "Invalid Date" straight from the
   * platform. It has to be a translated string, and it must not be confused
   * with the absent case — one means the field is empty, the other that
   * something upstream sent rubbish.
   */
  it('separates a broken timestamp from an absent one', () => {
    setActiveLocale('en')
    const broken = formatDate('not-a-date')
    expect(broken).not.toBe(formatDate(null))
    expect(broken).not.toContain('NaN')
    expect(broken).toBeTruthy()
  })

  /**
   * The date order is the visible half of the locale: an operator reading
   * `04/03` as April in a Brazilian panel is a real mistake, and it is Intl
   * that prevents it.
   */
  it('orders the date by the active locale', () => {
    setActiveLocale('en')
    const american = formatDate(ISO)
    setActiveLocale('pt-BR')
    const brazilian = formatDate(ISO)

    expect(american).toContain('03/04')
    expect(brazilian).toContain('04/03')
  })

  /**
   * The other half is translated, and it only stops reading English once that
   * locale's dictionary has arrived — which is the documented fallback, not a
   * defect. Loading it here is what makes the difference observable.
   */
  it('translates the absent case once the dictionary has loaded', async () => {
    setActiveLocale('en')
    expect(formatDate(null)).toBe('N/A')

    setActiveLocale('pt-BR')
    // Still English: the chunk has not been asked for yet.
    expect(formatDate(null)).toBe('N/A')

    await loadDictionary('pt-BR')
    expect(formatDate(null)).toBe('N/D')
  })
})

describe('merging class names', () => {
  it('lets the later Tailwind class win over the earlier one', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500')
  })

  it('drops what is conditional and false, and keeps the rest', () => {
    // A variable rather than a literal, which is how a component calls it —
    // `cn('block', collapsed && 'hidden', …)`.
    const collapsed = false
    expect(cn('block', collapsed && 'hidden', undefined, null, 'text-sm'))
      .toBe('block text-sm')
  })
})
