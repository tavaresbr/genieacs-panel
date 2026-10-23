import type { WhatsAppAccount } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

/**
 * A saúde do número oficial na Meta, como o cartão a mostra: a bolinha da
 * nota de qualidade, o limite diário em texto de gente ("até 1.000
 * conversas/24h"), e o aviso quando o número está sob sanção.
 */

export type QualityTone = 'green' | 'yellow' | 'red' | 'unknown'

/** A cor da bolinha. Qualquer coisa fora das três notas da Meta é "sem nota". */
export function qualityTone(rating?: string | null): QualityTone {
  switch (String(rating ?? '').toUpperCase()) {
    case 'GREEN': return 'green'
    case 'YELLOW': return 'yellow'
    case 'RED': return 'red'
    default: return 'unknown'
  }
}

export const QUALITY_LABEL: Record<QualityTone, TranslationKey> = {
  green: 'whatsapp.cloud.healthQualityGreen',
  yellow: 'whatsapp.cloud.healthQualityYellow',
  red: 'whatsapp.cloud.healthQualityRed',
  unknown: 'whatsapp.cloud.healthQualityUnknown'
}

/** Os degraus do limite diário que a Meta usa, com o número que cada um permite. */
const LIMIT_COUNT: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1000,
  TIER_2K: 2000,
  TIER_10K: 10000,
  TIER_100K: 100000
}

export type MessagingLimit =
  | { kind: 'count'; count: number }
  | { kind: 'unlimited' }
  | { kind: 'raw'; text: string }
  | null

/** O limite como o cartão o escreve; um degrau novo da Meta sai como veio. */
export function messagingLimit(tier?: string | null): MessagingLimit {
  const value = String(tier ?? '').trim().toUpperCase()
  if (!value) return null
  if (value === 'TIER_UNLIMITED') return { kind: 'unlimited' }
  const count = LIMIT_COUNT[value]
  return count ? { kind: 'count', count } : { kind: 'raw', text: value }
}

/** Status do número em que a Meta o pôs sob sanção. */
export function isDegradedStatus(status?: string | null): boolean {
  const value = String(status ?? '').toUpperCase()
  return value === 'FLAGGED' || value === 'RESTRICTED'
}

/** Se o cartão deve mostrar a faixa de aviso: nota amarela ou vermelha, ou sanção. */
export function healthNeedsAttention(
  account: Pick<WhatsAppAccount, 'metaQualityRating' | 'metaNumberStatus'>
): boolean {
  const tone = qualityTone(account.metaQualityRating)
  return tone === 'yellow' || tone === 'red' || isDegradedStatus(account.metaNumberStatus)
}

/** Os erros que o próprio painel produz, com frase traduzida; o resto é texto da Meta. */
const ERROR_KEYS: Record<string, TranslationKey> = {
  meta_unreachable: 'whatsapp.cloud.webhookUnreachable',
  meta_health_invalid_account: 'whatsapp.cloud.healthInvalidAccount',
  meta_health_failed: 'whatsapp.error.metaHealthFailed'
}

/** O erro da última consulta, como chave do painel ou como o texto da Meta. */
export function healthError(
  raw?: string | null
): { key: TranslationKey; text: null } | { key: null; text: string } | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const key = ERROR_KEYS[value]
  return key ? { key, text: null } : { key: null, text: value }
}
