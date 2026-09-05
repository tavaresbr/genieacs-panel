'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DEFAULT_LOCALE,
  LANGUAGE_CHANGED_EVENT,
  LANGUAGE_STORAGE_KEY,
  LOCALE_METADATA,
  LOCALES,
  detectLocale,
  isLocale,
  setActiveLocale,
  translate,
  type Locale,
  type TranslationKey,
  type TranslationVars,
} from '@/lib/i18n'

interface LanguageContextType {
  /** Active locale, e.g. `pt-BR`. */
  locale: Locale
  /** Locale tag to hand to `Intl`, e.g. `pt-BR` for `pt-BR` and `en-US` for `en`. */
  intlLocale: string
  locales: readonly Locale[]
  setLocale: (locale: Locale) => void
  /** Translates a key, interpolating `{placeholder}` slots from `vars`. */
  t: (key: TranslationKey, vars?: TranslationVars) => string
  formatDate: (value: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => string
  formatDateTime: (value: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => string
  formatTime: (value: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => string
  formatNumber: (value: number | null | undefined, options?: Intl.NumberFormatOptions) => string
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

const EMPTY_VALUE = '—'

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE)

  useEffect(() => {
    const initial = detectLocale()
    setLocaleState(initial)
  }, [])

  // Keep `<html lang>` and the non-React formatters in `lib/utils` in sync.
  useEffect(() => {
    document.documentElement.lang = locale
    setActiveLocale(locale)
  }, [locale])

  useEffect(() => {
    const syncFromEvent = (event: Event) => {
      const detail = (event as CustomEvent<Locale>).detail
      if (isLocale(detail)) setLocaleState(detail)
    }
    const syncFromStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY && isLocale(event.newValue)) setLocaleState(event.newValue)
    }
    window.addEventListener(LANGUAGE_CHANGED_EVENT, syncFromEvent)
    window.addEventListener('storage', syncFromStorage)
    return () => {
      window.removeEventListener(LANGUAGE_CHANGED_EVENT, syncFromEvent)
      window.removeEventListener('storage', syncFromStorage)
    }
  }, [])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, next)
    } catch {
      // Preference stays for this session only when storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent<Locale>(LANGUAGE_CHANGED_EVENT, { detail: next }))
  }, [])

  const value = useMemo<LanguageContextType>(() => {
    const intlLocale = LOCALE_METADATA[locale].intlLocale
    const format = (
      value: Date | string | number | null | undefined,
      options: Intl.DateTimeFormatOptions,
    ) => {
      const date = toDate(value)
      if (!date) return EMPTY_VALUE
      return new Intl.DateTimeFormat(intlLocale, options).format(date)
    }

    return {
      locale,
      intlLocale,
      locales: LOCALES,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
      formatDate: (date, options) => format(date, options ?? { dateStyle: 'short' }),
      formatDateTime: (date, options) => format(date, options ?? { dateStyle: 'short', timeStyle: 'short' }),
      formatTime: (date, options) => format(date, options ?? { hour: '2-digit', minute: '2-digit' }),
      formatNumber: (number, options) =>
        typeof number === 'number' && Number.isFinite(number)
          ? new Intl.NumberFormat(intlLocale, options).format(number)
          : EMPTY_VALUE,
    }
  }, [locale, setLocale])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider')
  }
  return context
}

/** Convenience alias for components that only need `t`. */
export function useTranslation() {
  return useLanguage()
}
