import type { TelegramChatConversation } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n/dictionary'

/** O limite de texto que o servidor aceita numa resposta (o do Telegram é 4096). */
export const TELEGRAM_CHAT_MAX_TEXT = 4000

/**
 * O nome na lista: o do cliente a que a conversa foi vinculada, senão o que o
 * Telegram deu, senão o @usuário, senão o fim do id do chat.
 */
export function telegramChatTitle(
  conversation: Pick<TelegramChatConversation, 'name' | 'username' | 'chatId' | 'clientName'>
): string {
  const name = conversation.clientName?.trim() || conversation.name?.trim()
  if (name) return name
  if (conversation.username) return `@${conversation.username}`
  return `…${conversation.chatId.slice(-6)}`
}

const ERROR_KEYS: Record<string, TranslationKey> = {
  empty_message: 'messenger.error.emptyMessage',
  message_too_long: 'messenger.error.messageTooLong',
  conversation_not_found: 'messenger.error.conversationNotFound',
  subscriber_not_found: 'messenger.error.subscriberNotFound',
  chat_blocked: 'telegramChat.error.chatBlocked',
  bot_unavailable: 'telegramChat.error.botOff',
  no_bot: 'telegramChat.error.botOff',
  bot_not_configured: 'telegramChat.error.botOff',
  invalid_token: 'telegramChat.error.invalidToken',
  no_public_url: 'telegramChat.error.noPublicUrl',
  telegram_unreachable: 'telegramChat.error.telegramFailed',
  telegram_failed: 'telegramChat.error.telegramFailed',
  send_refused: 'telegramChat.error.sendRefused',
}

/**
 * A mensagem para o código que o servidor devolveu. Código desconhecido cai na
 * genérica: a tela nunca mostra o texto cru de uma recusa do Telegram como se
 * fosse dela.
 */
export function telegramChatErrorKey(code: string | undefined): TranslationKey {
  return (code && ERROR_KEYS[code]) || 'messenger.error.generic'
}
