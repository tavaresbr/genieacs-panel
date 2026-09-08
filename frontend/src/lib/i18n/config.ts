export const LOCALES = ['pt-BR', 'en', 'es', 'it', 'de'] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'pt-BR'

export const LANGUAGE_STORAGE_KEY = 'language'

/** Emitted on `window` whenever the active locale changes. */
export const LANGUAGE_CHANGED_EVENT = 'languageChanged'

export interface LocaleMetadata {
  /** Native name, shown in the language picker. */
  label: string
  /** Two-letter badge used when the picker is collapsed. */
  shortLabel: string
  flag: string
  /** Tag handed to `Intl` formatters. */
  intlLocale: string
}

export const LOCALE_METADATA: Record<Locale, LocaleMetadata> = {
  'pt-BR': { label: 'Português (Brasil)', shortLabel: 'PT', flag: '🇧🇷', intlLocale: 'pt-BR' },
  en: { label: 'English', shortLabel: 'EN', flag: '🇺🇸', intlLocale: 'en-US' },
  es: { label: 'Español', shortLabel: 'ES', flag: '🇪🇸', intlLocale: 'es-ES' },
  it: { label: 'Italiano', shortLabel: 'IT', flag: '🇮🇹', intlLocale: 'it-IT' },
  de: { label: 'Deutsch', shortLabel: 'DE', flag: '🇩🇪', intlLocale: 'de-DE' },
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * Resolves an arbitrary BCP-47 tag to a supported locale.
 * `pt`, `pt-PT` and `pt-BR` all resolve to `pt-BR`; `es-419` resolves to `es`.
 */
export function resolveLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null
  const normalized = tag.trim().toLowerCase()
  if (!normalized) return null
  const exact = LOCALES.find((locale) => locale.toLowerCase() === normalized)
  if (exact) return exact
  const base = normalized.split('-')[0]
  if (base === 'pt') return 'pt-BR'
  if (base === 'en') return 'en'
  if (base === 'es') return 'es'
  if (base === 'it') return 'it'
  if (base === 'de') return 'de'
  return null
}

/** Reads the stored preference first, then the browser languages, then the default. */
export function detectLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  try {
    const stored = resolveLocale(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))
    if (stored) return stored
  } catch {
    // localStorage can be unavailable (private mode, blocked cookies); fall through to detection.
  }
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const candidate of candidates) {
    const resolved = resolveLocale(candidate)
    if (resolved) return resolved
  }
  return DEFAULT_LOCALE
}
