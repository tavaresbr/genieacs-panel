import MessengerConversation from '../models/MessengerConversation.js';
import Setting from '../models/Setting.js';
import MessengerSendService from './messengerSendService.js';
import { MessengerError } from './messengerPageService.js';

const KEY_ENABLED = 'messengerLinkedNoticeEnabled';
const KEY_TEXT = 'messengerLinkedNoticeText';

/** O teto do texto da confirmação: uma mensagem curta, bem abaixo do limite de 2000 do Messenger. */
export const NOTICE_MAX = 500;

/**
 * O texto de fábrica. Em português de propósito, como os modelos prontos da
 * régua: o texto vai para o assinante, não para a tela do operador.
 *
 * Diz POUCO de propósito. O link de vínculo não prova quem o abriu — quem o tem,
 * vincula —, então a confirmação não pode revelar o nome, o contrato nem nada do
 * cadastro: um link repassado entregaria esses dados a quem não devia.
 */
export const DEFAULT_NOTICE = 'Olá! Recebemos o seu contato pelo link do atendimento e já vinculamos esta conversa ao seu cadastro, para agilizar. Como podemos ajudar?';

const clean = (text) => String(text ?? '')
  // eslint-disable-next-line no-control-regex -- tira controle, mantém a quebra de linha
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .trim();

/**
 * A confirmação que a pessoa recebe no Messenger quando abre um link de vínculo
 * e a conversa dela é vinculada ao cadastro.
 *
 * É resposta a uma AÇÃO DELA (abrir o link), então cabe na janela de resposta;
 * o provedor pode desligar e trocar o texto. Nunca lança: a confirmação é um
 * extra, e o vínculo já está feito — uma falha da Meta não pode virar um 500
 * no webhook (a Meta reentregaria um evento que já foi tratado).
 */
class MessengerLinkedNoticeService {
  static async read() {
    const [enabled, text] = await Promise.all([Setting.getByKey(KEY_ENABLED), Setting.getByKey(KEY_TEXT)]);
    return {
      // Ligada por padrão: só um "false" gravado a desliga.
      enabled: String(enabled ?? '') !== 'false',
      text: clean(text),
      defaultText: DEFAULT_NOTICE
    };
  }

  /** Grava o que veio; campo ausente mantém o gravado. */
  static async save({ enabled, text } = {}) {
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new MessengerError('invalid_body', '`enabled` must be true or false');
    }
    if (text !== undefined) {
      if (typeof text !== 'string') throw new MessengerError('invalid_body', '`text` must be a string');
      if (clean(text).length > NOTICE_MAX) {
        throw new MessengerError('notice_too_long', `the text exceeds ${NOTICE_MAX} characters`);
      }
    }
    if (enabled !== undefined) await Setting.upsert(KEY_ENABLED, enabled ? 'true' : 'false');
    // Vazio volta ao texto de fábrica.
    if (text !== undefined) await Setting.upsert(KEY_TEXT, clean(text));
    return this.read();
  }

  /**
   * Manda a confirmação. Devolve `{ sent, reason }` (para o teste e o log).
   *
   * O clique no link é uma interação da pessoa, então vale como a última dela
   * para a janela de 24 h — mesmo quando o evento não trouxe mensagem nenhuma
   * (`referral` e `postback`). Se a Meta recusar, a tentativa fica gravada como
   * falha, com o motivo, e o atendente a vê na conversa.
   */
  static async notify({ conversationId, at = null }) {
    try {
      const config = await this.read();
      if (!config.enabled) return { sent: false, reason: 'disabled' };

      const conversation = await MessengerConversation.getById(conversationId);
      if (!conversation) return { sent: false, reason: 'conversation_not_found' };

      const when = new Date(Number(at) || Date.now());
      const last = conversation.last_inbound_at ? new Date(conversation.last_inbound_at).getTime() : 0;
      if (when.getTime() > last) {
        await MessengerConversation.update(conversationId, { last_inbound_at: when });
      }

      const message = await MessengerSendService.sendText(
        conversationId, config.text || DEFAULT_NOTICE, null, { source: 'system' }
      );
      return message?.delivery_status === 'sent'
        ? { sent: true, reason: null }
        : { sent: false, reason: 'meta_refused' };
    } catch (error) {
      console.warn(`[messenger] could not send the link confirmation: ${error.message}`);
      return { sent: false, reason: error instanceof MessengerError ? error.code : 'error' };
    }
  }
}

export default MessengerLinkedNoticeService;
