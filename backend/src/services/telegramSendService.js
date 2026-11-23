import TelegramConversation from '../models/TelegramConversation.js';
import TelegramMessage from '../models/TelegramMessage.js';
import TelegramCustomerBotService, { TelegramChatError } from './telegramCustomerBotService.js';
import { sendTelegramMessageWithId } from './telegramClient.js';

export const MAX_TEXT = 4000;

/**
 * Responde numa conversa do Telegram dos clientes.
 *
 * O que o servidor pode dizer na hora — texto vazio ou longo, conversa
 * inexistente, cliente que bloqueou o bot, bot desligado — falha com
 * `TelegramChatError` e NÃO grava nada. Passando disso a mensagem é enviada e
 * gravada com o estado em que ficou: 'sent' (com o `message_id` do Telegram) ou
 * 'failed' (com o motivo). Se o Telegram devolve 403, o cliente bloqueou o bot:
 * a conversa fica `blocked_at` e nada mais sai até ele escrever de novo.
 */
class TelegramSendService {
  static async sendText(conversationId, text, userId = null, { source = 'operator' } = {}) {
    const body = String(text ?? '').trim();
    if (!body) throw new TelegramChatError('empty_message', 'message is empty');
    if (body.length > MAX_TEXT) throw new TelegramChatError('message_too_long', `message exceeds ${MAX_TEXT} characters`);

    const conversation = await TelegramConversation.getById(conversationId);
    if (!conversation) throw new TelegramChatError('conversation_not_found', 'conversation not found', 404);
    if (conversation.blocked_at) {
      throw new TelegramChatError('chat_blocked', 'the customer blocked the bot', 409);
    }
    const active = await TelegramCustomerBotService.active();
    if (!active) throw new TelegramChatError('bot_unavailable', 'the customer bot is not on', 409);

    const result = await sendTelegramMessageWithId({
      token: active.token, chatId: conversation.chat_id, text: body
    });
    const now = new Date();
    if (result.ok) {
      const { message } = await TelegramMessage.insert({
        conversation_id: conversation.id,
        direction: 'out',
        external_id: result.messageId ? `${conversation.chat_id}:${result.messageId}` : null,
        body,
        source,
        delivery_status: 'sent',
        sent_by: userId
      });
      await TelegramConversation.update(conversation.id, { last_message_at: now });
      return message;
    }
    if (result.code === 'telegram_bot_not_in_chat') {
      await TelegramConversation.update(conversation.id, { blocked_at: now });
    }
    const { message } = await TelegramMessage.insert({
      conversation_id: conversation.id,
      direction: 'out',
      body,
      source,
      delivery_status: 'failed',
      delivery_error: String(result.code).slice(0, 255),
      sent_by: userId
    });
    return message;
  }
}

export default TelegramSendService;
