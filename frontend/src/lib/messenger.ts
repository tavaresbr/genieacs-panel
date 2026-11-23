import type { MessengerConversation, MessengerPreview } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n/dictionary'

/** A janela de resposta do Messenger: 24 h depois da última mensagem da pessoa. */
export const MESSENGER_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000

/** O limite de texto que o servidor aceita numa resposta. */
export const MESSENGER_MAX_TEXT = 2000

/**
 * Quanto falta para a janela fechar, em milissegundos; 0 se já fechou ou se a
 * pessoa nunca escreveu. É a mesma conta do servidor, só para MOSTRAR — quem
 * recusa a resposta fora da janela é o servidor.
 */
export function windowRemainingMs(lastInboundAt: string | null | undefined, now: number = Date.now()): number {
  if (!lastInboundAt) return 0
  const last = new Date(lastInboundAt).getTime()
  if (!Number.isFinite(last)) return 0
  return Math.max(0, last + MESSENGER_REPLY_WINDOW_MS - now)
}

/** "5 h 30 min" em partes, para a tela montar com a tradução. */
export function remainingParts(ms: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 }
}

/**
 * O nome na lista: o do cliente a que a conversa foi vinculada, senão o que o
 * Messenger deu, senão o fim do PSID.
 */
export function messengerTitle(conversation: Pick<MessengerConversation, 'name' | 'psid'> & { clientName?: string | null }): string {
  const name = conversation.clientName?.trim() || conversation.name?.trim()
  return name || `…${conversation.psid.slice(-6)}`
}

const ERROR_KEYS: Record<string, TranslationKey> = {
  window_closed: 'messenger.error.windowClosed',
  empty_message: 'messenger.error.emptyMessage',
  message_too_long: 'messenger.error.messageTooLong',
  conversation_not_found: 'messenger.error.conversationNotFound',
  page_unavailable: 'messenger.error.pageUnavailable',
  invalid_page_id: 'messenger.error.invalidPageId',
  missing_token: 'messenger.error.missingToken',
  page_already_connected: 'messenger.error.pageAlreadyConnected',
  page_mismatch: 'messenger.error.pageMismatch',
  page_not_found: 'messenger.error.pageNotFound',
  messenger_unconfigured: 'messenger.error.unconfigured',
  subscriber_not_found: 'messenger.error.subscriberNotFound',
  no_page: 'messenger.error.noPage',
  meta_refused: 'messenger.error.metaRefused',
}

/**
 * A mensagem para o código que o servidor devolveu. Código desconhecido cai na
 * genérica: a tela nunca mostra o texto cru de uma recusa da Meta como se fosse
 * dela.
 */
export function messengerErrorKey(code: string | undefined): TranslationKey {
  return (code && ERROR_KEYS[code]) || 'messenger.error.generic'
}

/** O PSID e o id da Página só têm dígitos; o servidor confere de novo. */
export function isPageId(value: string): boolean {
  return /^\d{5,32}$/.test(value.trim())
}

/** O que a prévia mostra de uma mensagem: o texto, o anexo, ou nada. */
export type PreviewContent =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; type: string }
  | { kind: 'empty' }

export function previewContent(preview: Pick<MessengerPreview, 'text' | 'attachmentType'>): PreviewContent {
  if (preview.text) return { kind: 'text', text: preview.text }
  if (preview.attachmentType) return { kind: 'attachment', type: preview.attachmentType }
  return { kind: 'empty' }
}

/** Duas datas no mesmo dia do calendário local — a lista mostra a hora de hoje e a data do resto. */
export function sameLocalDay(a: string | number | Date, b: string | number | Date): boolean {
  const first = new Date(a)
  const second = new Date(b)
  if (Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) return false
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate()
}
