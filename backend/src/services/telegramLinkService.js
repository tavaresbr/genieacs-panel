import TelegramConversation from '../models/TelegramConversation.js';
import MessengerLinkService from './messengerLinkService.js';
import { TelegramChatError } from './telegramCustomerBotService.js';

/**
 * Quem é a pessoa do outro lado da conversa do Telegram.
 *
 * O chat_id não traz telefone nem nome confiável, então, como no Messenger, não
 * há vínculo automático: quem diz de quem é a conversa é o atendente (aqui) ou o
 * próprio cliente (pelo link `?start=`, `telegramLinkTokenService.js`). O vínculo
 * é o MESMO do WhatsApp — um contrato do SGP, ou o cadastro de um cliente sem
 * contrato (`c:<id>`) —, para que o dossiê e a exclusão do assinante o alcancem.
 *
 * `resolveTarget` e `clientNames` são as do Messenger (não têm nada de Meta):
 * toda leitura passa por `tdb`, então um contrato de OUTRO provedor não existe
 * para quem tenta vinculá-lo.
 */
class TelegramLinkService {
  static async get(id) {
    const conversation = await TelegramConversation.getById(id);
    if (!conversation) throw new TelegramChatError('conversation_not_found', 'conversation not found', 404);
    return conversation;
  }

  static resolveTarget(key) {
    return MessengerLinkService.resolveTarget(key);
  }

  static clientNames(rows) {
    return MessengerLinkService.clientNames(rows);
  }

  /** Vincula a conversa ao contrato (ou `c:<id>`) que o atendente escolheu. */
  static async link(id, key) {
    const conversation = await this.get(id);
    const binding = await this.resolveTarget(key);
    return TelegramConversation.update(conversation.id, { ...binding, bound_via: 'operator' });
  }

  /** Tira o vínculo (o atendente vinculou a pessoa errada). */
  static async unlink(id) {
    const conversation = await this.get(id);
    return TelegramConversation.update(conversation.id, {
      contract: null, sgp_contact_id: null, customer_account_id: null, bound_via: null
    });
  }
}

export default TelegramLinkService;
