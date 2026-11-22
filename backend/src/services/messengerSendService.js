import MessengerPage from '../models/MessengerPage.js';
import MessengerConversation from '../models/MessengerConversation.js';
import MessengerMessage from '../models/MessengerMessage.js';
import { graphRequest } from './metaGraphClient.js';
import { MessengerError, decryptPageToken } from './messengerPageService.js';

/** A janela de resposta do Messenger: 24 h depois da última mensagem da pessoa. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_TEXT = 2000;

/** Se ainda dá para responder (fora da janela a Meta recusa, e é melhor dizer aqui). */
export function windowOpen(conversation, now = Date.now()) {
  if (!conversation?.last_inbound_at) return false;
  const last = new Date(conversation.last_inbound_at).getTime();
  return Number.isFinite(last) && now - last <= REPLY_WINDOW_MS;
}

class MessengerSendService {
  /**
   * Responde numa conversa. Falha com `MessengerError` e NÃO grava nada se a
   * janela fechou ou o texto é inválido; se a Meta recusar, grava a tentativa
   * como `failed` com o motivo, para o operador ver o que aconteceu.
   */
  static async sendText(conversationId, text, userId = null) {
    const body = String(text ?? '').trim();
    if (!body) throw new MessengerError('empty_message', 'message is empty');
    if (body.length > MAX_TEXT) throw new MessengerError('message_too_long', `message exceeds ${MAX_TEXT} characters`);

    const conversation = await MessengerConversation.getById(conversationId);
    if (!conversation) throw new MessengerError('conversation_not_found', 'conversation not found', 404);
    if (!windowOpen(conversation)) {
      throw new MessengerError('window_closed', 'the 24-hour reply window is closed', 409);
    }
    const page = await MessengerPage.getById(conversation.page_row_id);
    if (!page || page.status === 'error') {
      throw new MessengerError('page_unavailable', 'the page is not connected', 409);
    }

    const result = await graphRequest({
      method: 'POST',
      path: `/${page.page_id}/messages`,
      metaToken: decryptPageToken(page.page_token),
      body: {
        recipient: { id: conversation.psid },
        messaging_type: 'RESPONSE',
        message: { text: body }
      }
    });

    const mid = result.ok ? String(result.data?.message_id ?? '').slice(0, 128) || null : null;
    const { message } = await MessengerMessage.insert({
      conversation_id: conversation.id,
      direction: 'out',
      external_id: mid,
      body,
      source: 'operator',
      delivery_status: result.ok ? 'sent' : 'failed',
      delivery_error: result.ok ? null : String(result.error).slice(0, 255),
      sent_by: userId
    });
    if (result.ok) {
      await MessengerConversation.update(conversation.id, { last_message_at: new Date() });
    }
    return message;
  }
}

export default MessengerSendService;
