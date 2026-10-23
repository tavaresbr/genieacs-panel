import {
  PLATFORM_ALERT_EVENTS,
  type PlatformAlertChannel,
  type PlatformAlertEvent,
  type PlatformAlertsConfig,
  type PlatformAlertsUpdate
} from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import { parseAmountToCents } from '@/lib/utils'

/**
 * Configurações → Alertas (0112): o que a tela precisa saber dos alertas para
 * quem opera a plataforma. Quem valida de verdade é o servidor; aqui só se
 * monta o patch do que mudou.
 */

export const PLATFORM_ALERT_CHANNELS: readonly PlatformAlertChannel[] = ['whatsapp', 'email']

export const ALERT_EVENT_LABELS: Record<PlatformAlertEvent, TranslationKey> = {
  payment_received: 'platform.alerts.event.payment_received',
  card_refused: 'platform.alerts.event.card_refused',
  cancellation_requested: 'platform.alerts.event.cancellation_requested',
  cancellation_scheduled: 'platform.alerts.event.cancellation_scheduled',
  referral_signup: 'platform.alerts.event.referral_signup',
  nfse_error: 'platform.alerts.event.nfse_error',
  auto_suspended: 'platform.alerts.event.auto_suspended',
  big_overdue: 'platform.alerts.event.big_overdue'
}

/** Liga ou desliga um canal, na ordem fixa (WhatsApp, e-mail). */
export function toggleChannel(channels: readonly PlatformAlertChannel[], channel: PlatformAlertChannel) {
  const tem = channels.includes(channel)
  return PLATFORM_ALERT_CHANNELS.filter((c) => (c === channel ? !tem : channels.includes(c)))
}

const mesmosCanais = (a: readonly PlatformAlertChannel[], b: readonly PlatformAlertChannel[]) =>
  a.length === b.length && a.every((c) => b.includes(c))

/**
 * O patch dos alertas: só o que mudou entre `original` e `draft`. O limite vem
 * digitado em reais (`thresholdInput`); `invalidThreshold` quando não é um
 * valor positivo.
 */
export function buildAlertsPatch(
  original: PlatformAlertsConfig,
  draft: PlatformAlertsConfig,
  thresholdInput: string
): { patch: PlatformAlertsUpdate; invalidThreshold: boolean } {
  const patch: PlatformAlertsUpdate = {}
  const events: NonNullable<PlatformAlertsUpdate['events']> = {}
  for (const evento of PLATFORM_ALERT_EVENTS) {
    const antes = original.events[evento]
    const depois = draft.events[evento]
    const mudou: { enabled?: boolean; channels?: PlatformAlertChannel[] } = {}
    if (antes.enabled !== depois.enabled) mudou.enabled = depois.enabled
    if (!mesmosCanais(antes.channels, depois.channels)) mudou.channels = [...depois.channels]
    if (Object.keys(mudou).length) events[evento] = mudou
  }
  if (Object.keys(events).length) patch.events = events

  const centavos = parseAmountToCents(thresholdInput)
  const invalidThreshold = centavos === null || !(centavos > 0)
  if (!invalidThreshold && centavos !== original.bigOverdueCents) patch.bigOverdueCents = centavos

  const digest: { enabled?: boolean; hour?: number } = {}
  if (original.dailyDigest.enabled !== draft.dailyDigest.enabled) digest.enabled = draft.dailyDigest.enabled
  if (original.dailyDigest.hour !== draft.dailyDigest.hour) digest.hour = draft.dailyDigest.hour
  if (Object.keys(digest).length) patch.dailyDigest = digest

  // O relatório mensal: só quando o servidor o conhece (vem no perfil).
  if (original.monthlyReport && draft.monthlyReport) {
    const antes = original.monthlyReport
    const depois = draft.monthlyReport
    const mensal: NonNullable<PlatformAlertsUpdate['monthlyReport']> = {}
    if (antes.enabled !== depois.enabled) mensal.enabled = depois.enabled
    if (!mesmosCanais(antes.channels, depois.channels)) mensal.channels = [...depois.channels]
    if (antes.hour !== depois.hour) mensal.hour = depois.hour
    if (Object.keys(mensal).length) patch.monthlyReport = mensal
  }

  return { patch, invalidThreshold }
}

/** Um evento ligado sem canal nenhum não avisa ninguém: a tela pede ao menos um. */
export function eventsWithoutChannel(config: PlatformAlertsConfig): PlatformAlertEvent[] {
  return PLATFORM_ALERT_EVENTS.filter((e) => config.events[e].enabled && config.events[e].channels.length === 0)
}

/** O relatório mensal ligado sem canal nenhum não chega a ninguém. */
export function monthlyReportWithoutChannel(config: PlatformAlertsConfig): boolean {
  return Boolean(config.monthlyReport?.enabled && config.monthlyReport.channels.length === 0)
}
