import type { ContactDeviceFilter } from '@/lib/api'

/** The Contacts filters an operator has chosen, kept while the tab stays open. */
export interface ContactFilters {
  search: string
  state: '' | 'active' | 'blocked' | 'cancelled' | 'none'
  noPhone: boolean
  imported: boolean
  device: ContactDeviceFilter
  /** Só quem também é cliente do Asaas. */
  asaas: boolean
  /** Só quem a TeiaH deu risco alto. */
  teiahHigh?: boolean
}

/** Where the Contacts menu entry keeps them; cleared with the rest of the session. */
export const CONTACTS_FILTERS_KEY = 'contacts-filters'

const STATES: readonly ContactFilters['state'][] = ['', 'active', 'blocked', 'cancelled', 'none']
const DEVICES: readonly ContactDeviceFilter[] = ['', 'with', 'without']

/**
 * What was saved under `key`, field by field; anything unknown falls to `fallback`.
 *
 * The search text can be a customer's name, so what is saved carries its
 * owner (`sessionOwner`) and only that owner reads it back — another session
 * in the same tab starts clean even if a path forgot to clear the storage.
 */
export function loadContactFilters(key: string, fallback: ContactFilters, owner: string | null): ContactFilters {
  if (!owner) return fallback
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return fallback
    const saved = JSON.parse(raw) as (Partial<Record<keyof ContactFilters | 'owner', unknown>>) | null
    if (!saved || typeof saved !== 'object' || saved.owner !== owner) return fallback
    return {
      search: typeof saved.search === 'string' ? saved.search.slice(0, 200) : fallback.search,
      state: STATES.find((s) => s === saved.state) ?? fallback.state,
      noPhone: typeof saved.noPhone === 'boolean' ? saved.noPhone : fallback.noPhone,
      imported: typeof saved.imported === 'boolean' ? saved.imported : fallback.imported,
      device: DEVICES.find((d) => d === saved.device) ?? fallback.device,
      asaas: typeof saved.asaas === 'boolean' ? saved.asaas : fallback.asaas,
      teiahHigh: typeof saved.teiahHigh === 'boolean' ? saved.teiahHigh : fallback.teiahHigh
    }
  } catch {
    return fallback
  }
}

export function saveContactFilters(key: string, filters: ContactFilters, owner: string | null) {
  if (!owner) return
  try {
    sessionStorage.setItem(key, JSON.stringify({ ...filters, owner }))
  } catch {
    // Without storage the choice lasts only for this visit.
  }
}
