import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTACTS_FILTERS_KEY, loadContactFilters, saveContactFilters, type ContactFilters } from '@/lib/contact-filters'
import { clearSessionScopedStorage } from '@/lib/session-owner'

const OWNER = 'alfa:7'
const fallback: ContactFilters = { search: '', state: 'active', noPhone: false, imported: false, device: '', asaas: false }

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) }
  })
  return data
}

describe('contact filters', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  it('round-trips what was saved', () => {
    stubStorage()
    const chosen: ContactFilters = { search: 'ana', state: 'none', noPhone: true, imported: false, device: 'without', asaas: true }
    saveContactFilters(CONTACTS_FILTERS_KEY, chosen, OWNER)
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback, OWNER)).toEqual(chosen)
  })

  it('falls back when nothing, junk or unknown values are stored', () => {
    stubStorage()
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback, OWNER)).toEqual(fallback)
    stubStorage({ [CONTACTS_FILTERS_KEY]: '{not json' })
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback, OWNER)).toEqual(fallback)
    stubStorage({ [CONTACTS_FILTERS_KEY]: JSON.stringify({ owner: OWNER, state: 'x', device: 'y', noPhone: 'sim', search: 3 }) })
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback, OWNER)).toEqual(fallback)
  })

  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') }
    })
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback, OWNER)).toEqual(fallback)
    expect(() => saveContactFilters(CONTACTS_FILTERS_KEY, fallback, OWNER)).not.toThrow()
  })

  it('is read back only by the session that saved it', () => {
    stubStorage()
    const chosen: ContactFilters = { search: 'Maria da Silva', state: 'none', noPhone: false, imported: false, device: '', asaas: false }
    saveContactFilters(CONTACTS_FILTERS_KEY, chosen, OWNER)
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback, 'beta:9')).toEqual(fallback)
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback, 'alfa:8')).toEqual(fallback)
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback, null)).toEqual(fallback)
  })

  it('saves nothing without a session', () => {
    const data = stubStorage()
    saveContactFilters(CONTACTS_FILTERS_KEY, fallback, null)
    expect(data.has(CONTACTS_FILTERS_KEY)).toBe(false)
  })

  it('is cleared with the session', () => {
    const data = stubStorage({ [CONTACTS_FILTERS_KEY]: '{}' })
    clearSessionScopedStorage()
    expect(data.has(CONTACTS_FILTERS_KEY)).toBe(false)
  })
})
