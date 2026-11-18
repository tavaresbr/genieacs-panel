// Só o tipo: o dicionário inglês em si é carregado sob demanda (`index.ts`),
// e um import de valor aqui o puxaria de volta para o chunk de entrada.
import type en from '@/lib/i18n/locales/en'

/** Every translatable string in the panel is addressed by one of these keys. */
export type TranslationKey = keyof typeof en

/** A complete translation of the English source dictionary. */
export type Dictionary = Record<TranslationKey, string>

/** Values interpolated into `{placeholder}` slots of a translated string. */
export type TranslationVars = Record<string, string | number>
