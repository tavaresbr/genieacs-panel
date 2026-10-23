import {
  PLATFORM_ALERT_EVENTS,
  type PlatformAlertHistoryEvent,
  type PlatformAlertHistoryItem,
  type PlatformAlertHistoryQuery,
  type PlatformAlertStatus
} from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import { ALERT_EVENT_LABELS } from '@/lib/platform-alerts'

/**
 * O histórico dos alertas da plataforma: o que a tela precisa saber da fila —
 * rótulos, cores, quem pode ser reenviado e a query dos filtros. Quem valida
 * de verdade é o servidor.
 */

export const HISTORY_EVENTS: readonly PlatformAlertHistoryEvent[] = [...PLATFORM_ALERT_EVENTS, 'digest', 'test', 'monthly_report']

export const ALERT_STATUS_LABELS: Record<PlatformAlertStatus, TranslationKey> = {
  pending: 'platform.alertHistory.status.pending',
  sent: 'platform.alertHistory.status.sent',
  failed: 'platform.alertHistory.status.failed',
  skipped: 'platform.alertHistory.status.skipped'
}

export const ALERT_STATUS_BADGE: Record<PlatformAlertStatus, string> = {
  pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  sent: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-destructive/15 text-destructive',
  skipped: 'bg-muted text-muted-foreground'
}

/** O rótulo do evento: os configuráveis reusam os da configuração. */
export function historyEventLabel(event: PlatformAlertHistoryEvent): TranslationKey {
  if (event === 'digest') return 'platform.alertHistory.event.digest'
  if (event === 'test') return 'platform.alertHistory.event.test'
  if (event === 'monthly_report') return 'platform.alertHistory.event.monthlyReport'
  return ALERT_EVENT_LABELS[event]
}

/**
 * Só o que falhou ou foi pulado volta para a fila — e nunca o teste, que o
 * agendador não manda (é o botão que manda na hora).
 */
export function canResend(item: Pick<PlatformAlertHistoryItem, 'status' | 'event'>): boolean {
  return (item.status === 'failed' || item.status === 'skipped') && item.event !== 'test'
}

export interface HistoryFilters {
  status: PlatformAlertStatus | ''
  event: PlatformAlertHistoryEvent | ''
  from: string
  to: string
}

export const EMPTY_HISTORY_FILTERS: HistoryFilters = { status: '', event: '', from: '', to: '' }

/** A query do servidor: só os filtros preenchidos, mais a página. */
export function buildHistoryQuery(filters: HistoryFilters, page = 1, pageSize = 25): PlatformAlertHistoryQuery {
  const query: PlatformAlertHistoryQuery = { page, pageSize }
  if (filters.status) query.status = filters.status
  if (filters.event) query.event = filters.event
  if (filters.from.trim()) query.from = filters.from.trim()
  if (filters.to.trim()) query.to = filters.to.trim()
  return query
}

/** Quantas páginas há (ao menos uma, para o "página 1 de 1" da lista vazia). */
export function pageCount(total: number, pageSize: number): number {
  if (!(pageSize > 0) || !(total > 0)) return 1
  return Math.ceil(total / pageSize)
}

/** A mensagem de cada recusa do servidor, pelo `code`. */
export function historyErrorKey(code: string | undefined): TranslationKey {
  switch (code) {
    case 'invalid_from': return 'platform.alertHistory.error.invalidFrom'
    case 'invalid_to': return 'platform.alertHistory.error.invalidTo'
    case 'invalid_range': return 'platform.alertHistory.error.invalidRange'
    case 'not_resendable': return 'platform.alertHistory.error.notResendable'
    case 'not_found': return 'platform.alertHistory.error.notFound'
    default: return 'platform.alertHistory.loadFailed'
  }
}
