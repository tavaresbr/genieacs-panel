import type { MessengerConversation, MessengerMessage, MessengerPreview } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n/dictionary'

/** A janela de resposta do Messenger: 24 h depois da última mensagem da pessoa. */
export const MESSENGER_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000

/** O limite de texto que o servidor aceita numa resposta. */
export const MESSENGER_MAX_TEXT = 2000

/** O limite do texto da confirmação do vínculo (o do servidor). */
export const MESSENGER_NOTICE_MAX = 500

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
  notice_too_long: 'messenger.error.noticeTooLong',
  send_refused: 'messenger.error.sendRefused',
  not_retryable: 'messenger.error.notRetryable',
  message_not_found: 'messenger.error.messageNotFound',
  meta_refused: 'messenger.error.metaRefused',
  facebook_login_unconfigured: 'messenger.error.facebookUnconfigured',
  page_not_administered: 'messenger.error.pageNotAdministered',
  invalid_token: 'messenger.error.facebookToken',
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

/** O número de tentativas que a fila faz antes de desistir (o do servidor). */
export const MESSENGER_MAX_ATTEMPTS = 7

/** Há alguma resposta ainda a caminho? Então vale olhar a conversa com mais frequência. */
export function hasPendingMessages(messages: ReadonlyArray<Pick<MessengerMessage, 'direction' | 'deliveryStatus'>>): boolean {
  return messages.some((m) => m.direction === 'out' && (m.deliveryStatus === 'queued' || m.deliveryStatus === 'sending'))
}

/**
 * O estado de uma resposta como a conversa o mostra: o próprio estado, ou "vai
 * tentar de novo" para a que já falhou ao menos uma vez e espera na fila.
 */
export function deliveryLabel(message: Pick<MessengerMessage, 'deliveryStatus' | 'attempts'>):
  | { kind: 'status'; status: NonNullable<MessengerMessage['deliveryStatus']> }
  | { kind: 'retrying'; attempt: number; max: number }
  | null {
  if (!message.deliveryStatus) return null
  if (message.deliveryStatus === 'queued' && message.attempts > 0) {
    return { kind: 'retrying', attempt: message.attempts, max: MESSENGER_MAX_ATTEMPTS }
  }
  return { kind: 'status', status: message.deliveryStatus }
}

/** A resposta pode ser reenviada à mão: falhou, é nossa (saída) e a Meta nunca a aceitou. */
export function canRetryMessage(
  message: Pick<MessengerMessage, 'direction' | 'deliveryStatus'>,
  windowOpen: boolean,
  canSend: boolean
): boolean {
  return canSend && windowOpen && message.direction === 'out' && message.deliveryStatus === 'failed'
}

/** O que o popup `/messenger-connect.html` manda ao painel. */
export const FACEBOOK_LOGIN_MESSAGE = 'messenger-fb-login'

export type FacebookLoginResult = { accessToken: string } | { error: string }

/**
 * Lê a mensagem do popup. Só vale a que vem da própria origem do painel E da
 * janela que ele abriu; qualquer outra (inclusive de outra aba) é ignorada.
 */
export function parseFacebookLoginMessage(
  event: { origin: string; source: unknown; data: unknown },
  popup: unknown,
  origin: string
): FacebookLoginResult | null {
  if (event.origin !== origin || !popup || event.source !== popup) return null
  const data = event.data as { type?: unknown; accessToken?: unknown; error?: unknown } | null
  if (!data || typeof data !== 'object' || data.type !== FACEBOOK_LOGIN_MESSAGE) return null
  if (typeof data.accessToken === 'string' && data.accessToken) return { accessToken: data.accessToken }
  return { error: typeof data.error === 'string' ? data.error : 'cancelled' }
}
