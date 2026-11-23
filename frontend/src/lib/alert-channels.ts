/**
 * O cartão "Canais de aviso": para cada canal, se ele está pronto e o que falta.
 *
 * Função pura (o vitest do projeto roda em `node`). Os dados vêm de
 * `GET /whatsapp/alerts/settings` (`channels`), que lê o que a varredura
 * recusaria — então a tela diz, antes de qualquer alerta, por que ele não sairia.
 */
import type { TranslationKey } from '@/lib/i18n'

export interface AlertChannelsInfo {
  whatsapp: { configured: boolean; addon: boolean; numberConnected: boolean; recipients: number }
  email: { smtp: boolean; recipients: number }
  telegram: { configured: boolean; ready: boolean }
}

export type ChannelTone = 'ok' | 'warn' | 'off'

export interface ChannelCard {
  id: 'whatsapp' | 'email' | 'telegram'
  tone: ChannelTone
  title: TranslationKey
  /** Quantos destinatários, quando o canal tem lista. */
  count: number | null
  hint: TranslationKey
}

export function channelCards(info: AlertChannelsInfo): ChannelCard[] {
  const { whatsapp, email, telegram } = info

  let whatsappCard: Pick<ChannelCard, 'tone' | 'hint'>
  if (!whatsapp.configured) whatsappCard = { tone: 'warn', hint: 'whatsapp.error.notConfigured' }
  else if (!whatsapp.addon) whatsappCard = { tone: 'warn', hint: 'whatsapp.alerts.chWhatsappNoAddon' }
  else if (!whatsapp.numberConnected) whatsappCard = { tone: 'warn', hint: 'whatsapp.alerts.noAlertNumber' }
  else if (whatsapp.recipients === 0) whatsappCard = { tone: 'off', hint: 'whatsapp.alerts.chNoRecipients' }
  else whatsappCard = { tone: 'ok', hint: 'whatsapp.alerts.chWhatsappOk' }

  let emailCard: Pick<ChannelCard, 'tone' | 'hint'>
  if (!email.smtp) emailCard = { tone: email.recipients > 0 ? 'warn' : 'off', hint: 'whatsapp.alerts.mailNotConfigured' }
  else if (email.recipients === 0) emailCard = { tone: 'off', hint: 'whatsapp.alerts.chNoRecipients' }
  else emailCard = { tone: 'ok', hint: 'whatsapp.alerts.chEmailOk' }

  let telegramCard: Pick<ChannelCard, 'tone' | 'hint'>
  if (!telegram.configured) telegramCard = { tone: 'off', hint: 'whatsapp.alerts.chTelegramNo' }
  else if (!telegram.ready) telegramCard = { tone: 'warn', hint: 'whatsapp.alerts.chTelegramNoChat' }
  else telegramCard = { tone: 'ok', hint: 'whatsapp.alerts.chTelegramOk' }

  return [
    { id: 'whatsapp', title: 'whatsapp.alerts.chWhatsapp', count: whatsapp.recipients, ...whatsappCard },
    { id: 'email', title: 'whatsapp.alerts.chEmail', count: email.recipients, ...emailCard },
    { id: 'telegram', title: 'whatsapp.alerts.chTelegram', count: null, ...telegramCard }
  ]
}

/**
 * O estado do botão "Testar" de uma linha.
 *
 * Só um item JÁ SALVO pode ser testado: o servidor recusa qualquer outro (a
 * rota não é um disparador livre), então a tela nem oferece o clique.
 */
export type TestRowState =
  | { phase: 'sending' }
  | { phase: 'queued' }
  | { phase: 'sent' }
  | { phase: 'failed'; reason: string }

export function canTestItem(saved: readonly string[], item: string): boolean {
  return saved.includes(item)
}
