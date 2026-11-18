import type { AcsFailureCode, AcsHealth } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

/**
 * Quanto tempo o GenieACS pode ficar sem responder antes de o painel avisar.
 *
 * Um minuto: um pedido que falhou num reinício do ACS, ou numa oscilação de
 * rede, não vale uma faixa vermelha em todas as telas. Medido pelo relógio do
 * servidor (`downForMs`), que é quem viu a queda começar.
 */
export const ACS_DOWN_GRACE_MS = 60_000

/** De quanto em quanto tempo a casca pergunta — a resposta vem da memória do servidor. */
export const ACS_HEALTH_POLL_MS = 60_000

const CODES: readonly AcsFailureCode[] = [
  'dns', 'refused', 'timeout', 'tls', 'unauthorized', 'http_error', 'blocked', 'unknown'
]

function knownCode(code: string | null | undefined): AcsFailureCode {
  return CODES.includes(code as AcsFailureCode) ? (code as AcsFailureCode) : 'unknown'
}

/** A frase do motivo ("o endereço configurado não existe no DNS"). */
export function acsReasonKey(code: string | null | undefined): TranslationKey {
  return `acsHealth.reason.${knownCode(code)}` as TranslationKey
}

/** O nome curto do motivo, para "fora (DNS) desde 09:46". */
export function acsCodeLabelKey(code: string | null | undefined): TranslationKey {
  return `acsHealth.code.${knownCode(code)}` as TranslationKey
}

/**
 * A identidade de UMA queda: o motivo e desde quando. Fechar a faixa guarda
 * isto na aba, e a faixa só volta para outra queda — outro motivo, ou o ACS
 * que voltou e caiu de novo (outro `since`).
 */
export function acsDownSignature(health: AcsHealth | null | undefined): string {
  if (!health || health.status !== 'down') return ''
  return `${knownCode(health.code)}|${health.since ?? ''}`
}

/** A faixa aparece? Fora há mais de um minuto, e não fechada nesta aba para esta mesma queda. */
export function shouldShowAcsBanner(health: AcsHealth | null | undefined, dismissed: string): boolean {
  if (!health || health.status !== 'down') return false
  if (!(Number(health.downForMs) > ACS_DOWN_GRACE_MS)) return false
  return acsDownSignature(health) !== dismissed
}
