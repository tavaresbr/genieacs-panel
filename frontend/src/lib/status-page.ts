import type {
  StatusComponentCode, StatusComponentState, StatusIncidentImpact, StatusIncidentKind, StatusIncidentStatus,
} from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

/**
 * As peças puras da página de status (0127): a página pública `/status` e a
 * aba Status do console. Fora dos componentes para os testes fixarem sem React.
 */

export const STATUS_COMPONENT_CODES: readonly StatusComponentCode[] = ['panel', 'payments', 'whatsapp', 'genieacs']
export const STATUS_IMPACTS: readonly StatusIncidentImpact[] = ['none', 'minor', 'major', 'critical']

/** As situações de cada tipo, na ordem em que andam — a mesma lista do backend. */
export const INCIDENT_STATUSES: Record<StatusIncidentKind, readonly StatusIncidentStatus[]> = {
  incident: ['investigating', 'identified', 'monitoring', 'resolved'],
  maintenance: ['scheduled', 'in_progress', 'resolved'],
}

export const COMPONENT_LABEL_KEYS: Record<StatusComponentCode, TranslationKey> = {
  panel: 'statusPage.component.panel',
  payments: 'statusPage.component.payments',
  whatsapp: 'statusPage.component.whatsapp',
  genieacs: 'statusPage.component.genieacs',
}

export const STATE_LABEL_KEYS: Record<StatusComponentState, TranslationKey> = {
  operational: 'statusPage.state.operational',
  maintenance: 'statusPage.state.maintenance',
  degraded: 'statusPage.state.degraded',
  partial_outage: 'statusPage.state.partialOutage',
  major_outage: 'statusPage.state.majorOutage',
  unknown: 'statusPage.state.unknown',
}

export const OVERALL_LABEL_KEYS: Record<StatusComponentState, TranslationKey> = {
  operational: 'statusPage.overall.operational',
  maintenance: 'statusPage.overall.maintenance',
  degraded: 'statusPage.overall.degraded',
  partial_outage: 'statusPage.overall.partialOutage',
  major_outage: 'statusPage.overall.majorOutage',
  unknown: 'statusPage.overall.unknown',
}

export const INCIDENT_STATUS_LABEL_KEYS: Record<StatusIncidentStatus, TranslationKey> = {
  investigating: 'statusPage.incidentStatus.investigating',
  identified: 'statusPage.incidentStatus.identified',
  monitoring: 'statusPage.incidentStatus.monitoring',
  resolved: 'statusPage.incidentStatus.resolved',
  scheduled: 'statusPage.incidentStatus.scheduled',
  in_progress: 'statusPage.incidentStatus.inProgress',
}

export const IMPACT_LABEL_KEYS: Record<StatusIncidentImpact, TranslationKey> = {
  none: 'statusPage.impact.none',
  minor: 'statusPage.impact.minor',
  major: 'statusPage.impact.major',
  critical: 'statusPage.impact.critical',
}

/** O tom de um estado: a cor da bolinha e do selo. */
export function stateTone(state: StatusComponentState): 'good' | 'info' | 'warning' | 'bad' | 'neutral' {
  if (state === 'operational') return 'good'
  if (state === 'maintenance') return 'info'
  if (state === 'degraded') return 'warning'
  if (state === 'partial_outage' || state === 'major_outage') return 'bad'
  return 'neutral'
}

/** A classe do selo de um estado, com as classes que o painel já tem. */
export function stateBadgeClass(state: StatusComponentState): string {
  const tom = stateTone(state)
  if (tom === 'good') return 'modern-badge-success'
  if (tom === 'warning') return 'modern-badge-warning'
  if (tom === 'bad') return 'modern-badge-error'
  return 'modern-badge-info'
}

/**
 * O tom de um dia da barra pela disponibilidade: sem dado, neutro; 99,9% ou
 * mais, bom; 99% ou mais, atenção; abaixo disso, ruim.
 */
export function dayTone(uptime: number | null | undefined): 'good' | 'warning' | 'bad' | 'neutral' {
  if (uptime === null || uptime === undefined || !Number.isFinite(uptime)) return 'neutral'
  if (uptime >= 99.9) return 'good'
  if (uptime >= 99) return 'warning'
  return 'bad'
}

/** A cor de fundo de um tom, nas variáveis do tema. */
export function toneBg(tone: 'good' | 'info' | 'warning' | 'bad' | 'neutral'): string {
  if (tone === 'good') return 'bg-[hsl(var(--status-success))]'
  if (tone === 'warning') return 'bg-[hsl(var(--status-warning))]'
  if (tone === 'bad') return 'bg-[hsl(var(--status-danger))]'
  if (tone === 'info') return 'bg-primary'
  return 'bg-muted'
}

/** A porcentagem como se lê: duas casas no máximo, sem zeros sobrando (`99.95`, `100`). */
export function formatUptime(uptime: number | null | undefined, locale?: string): string {
  if (uptime === null || uptime === undefined || !Number.isFinite(uptime)) return '—'
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(uptime)
}

/** As situações que uma atualização pode levar, a partir de onde o incidente está. */
export function nextStatuses(kind: StatusIncidentKind): readonly StatusIncidentStatus[] {
  return INCIDENT_STATUSES[kind]
}

/**
 * Um `datetime-local` (horário de quem digita) em ISO, ou nulo vazio/inválido.
 * O servidor guarda o instante; a página mostra no fuso de quem lê.
 */
export function localInputToIso(valor: string): string | null {
  if (!valor) return null
  const ms = new Date(valor).getTime()
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}
