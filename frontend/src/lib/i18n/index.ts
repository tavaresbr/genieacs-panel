import type { Locale } from '@/lib/i18n/config'
import type { Dictionary, TranslationKey, TranslationVars } from '@/lib/i18n/dictionary'

export * from '@/lib/i18n/config'
export * from '@/lib/i18n/runtime'
export * from '@/lib/i18n/api-messages'
export type { Dictionary, TranslationKey, TranslationVars }

/** English is the fallback because it is the dictionary the other locales are typed against. */
const FALLBACK_LOCALE: Locale = 'en'

/**
 * Every dictionary, English included, is fetched on demand so a visitor
 * downloads one locale instead of two. English used to ship inside the entry
 * chunk as the fallback, which made every pt-BR visitor pay ~120 kB gzip for a
 * dictionary they never read. `translate()` stays synchronous: the entry points
 * request the visitor's dictionary at module evaluation and `LanguageProvider`
 * holds the first render until it is in memory, so no screen sees raw keys.
 * Every locale is typed as a complete `Dictionary`, so English is only needed
 * when a locale's chunk fails to load — and then `loadDictionary` fetches it.
 */
const loaded: Partial<Record<Locale, Dictionary>> = {}

const loaders: Record<Locale, () => Promise<{ default: Dictionary }>> = {
  en: () => import('@/lib/i18n/locales/en'),
  ar: () => import('@/lib/i18n/locales/ar'),
  de: () => import('@/lib/i18n/locales/de'),
  es: () => import('@/lib/i18n/locales/es'),
  fr: () => import('@/lib/i18n/locales/fr'),
  hi: () => import('@/lib/i18n/locales/hi'),
  it: () => import('@/lib/i18n/locales/it'),
  ja: () => import('@/lib/i18n/locales/ja'),
  ko: () => import('@/lib/i18n/locales/ko'),
  'pt-BR': () => import('@/lib/i18n/locales/pt-BR'),
  ru: () => import('@/lib/i18n/locales/ru'),
  'zh-CN': () => import('@/lib/i18n/locales/zh-CN'),
  'zh-TW': () => import('@/lib/i18n/locales/zh-TW'),
}

const pending = new Map<Locale, Promise<void>>()

/** True once `locale` renders from its own dictionary instead of the fallback. */
export function isDictionaryLoaded(locale: Locale): boolean {
  return loaded[locale] !== undefined
}

/**
 * Fetches the dictionary for `locale`, if it is not in memory already.
 * Resolves even when the chunk fails to load: English is then fetched in its
 * place and stands in for that locale.
 */
export function loadDictionary(locale: Locale): Promise<void> {
  if (isDictionaryLoaded(locale)) return Promise.resolve()
  const loader = loaders[locale]
  if (!loader) return Promise.resolve()
  const inFlight = pending.get(locale)
  if (inFlight) return inFlight

  const request = loader()
    .then((module) => {
      loaded[locale] = module.default
    })
    .catch((error: unknown) => {
      console.error(`Could not load the "${locale}" dictionary; falling back to ${FALLBACK_LOCALE}.`, error)
      if (locale !== FALLBACK_LOCALE) return loadDictionary(FALLBACK_LOCALE)
      return undefined
    })
    .finally(() => {
      pending.delete(locale)
    })
  pending.set(locale, request)
  return request
}

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g

function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Translates `key` into `locale`, falling back to English and finally to the key
 * itself so a missing string is visible instead of rendering as an empty node.
 * Stays synchronous: a locale whose chunk has not arrived reads as English
 * when English is in memory, and as the key otherwise.
 */
export function translate(locale: Locale, key: TranslationKey, vars?: TranslationVars): string {
  const template = loaded[locale]?.[key] ?? loaded[FALLBACK_LOCALE]?.[key] ?? key
  return interpolate(template, vars)
}
