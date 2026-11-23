import MessengerPage from '../models/MessengerPage.js';
import MessengerConversation from '../models/MessengerConversation.js';
import MessengerMessage from '../models/MessengerMessage.js';
import MessengerOutboxWorker from './messengerOutboxWorker.js';
import { MessengerError } from './messengerPageService.js';
import { windowOpen } from '../utils/messenger/messengerWindow.js';

export { REPLY_WINDOW_MS, windowOpen } from '../utils/messenger/messengerWindow.js';
export const MAX_TEXT = 2000;

class MessengerSendService {
  /**
   * Responde numa conversa.
   *
   * O que o servidor pode dizer na hora — texto vazio ou longo, conversa
   * inexistente, janela fechada, Página fora — falha com `MessengerError` e NÃO
   * grava nada. Passando disso a mensagem ENTRA NA FILA e é tentada já, pela
   * mesma `deliver()` do laço de fundo: o caso comum sai na hora, e o que a Meta
   * ou a rede não aguentaram fica 'queued' (nova tentativa com recuo) em vez de
   * se perder. Uma recusa permanente da Meta fica 'failed', com o motivo.
   *
   * O resultado é o estado em que a mensagem ficou: 'sent', 'queued' (vai
   * tentar de novo) ou 'failed'.
   */
  static async sendText(conversationId, text, userId = null, { source = 'operator' } = {}) {
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

    const { message } = await MessengerMessage.insert({
      conversation_id: conversation.id,
      direction: 'out',
      body,
      // 'operator' (a equipe) ou 'system' (mensagem automática, como a confirmação do vínculo).
      source,
      delivery_status: 'queued',
      sent_by: userId
    });
    const { id } = await MessengerOutboxWorker.deliver(message.id);
    return MessengerMessage.getById(id);
  }
}

export default MessengerSendService;
