import en from '@/lib/i18n/locales/en'
import es from '@/lib/i18n/locales/es'
import it from '@/lib/i18n/locales/it'
import ptBR from '@/lib/i18n/locales/pt-BR'
import type { Locale } from '@/lib/i18n/config'
import type { Dictionary, TranslationKey, TranslationVars } from '@/lib/i18n/dictionary'

export * from '@/lib/i18n/config'
export * from '@/lib/i18n/runtime'
export type { Dictionary, TranslationKey, TranslationVars }

/** English is the fallback because it is the dictionary the other locales are typed against. */
const FALLBACK_LOCALE: Locale = 'en'

export const dictionaries: Record<Locale, Dictionary> = {
  'pt-BR': ptBR,
  en,
  es,
  it,
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
 */
export function translate(locale: Locale, key: TranslationKey, vars?: TranslationVars): string {
  const template = dictionaries[locale]?.[key] ?? dictionaries[FALLBACK_LOCALE][key] ?? key
  return interpolate(template, vars)
}
