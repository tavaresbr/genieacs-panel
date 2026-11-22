import MessengerConversation from '../models/MessengerConversation.js';
import SgpLink from '../models/SgpLink.js';
import SgpContact from '../models/SgpContact.js';
import CustomerAccount from '../models/CustomerAccount.js';
import { tdb } from '../config/database.js';
import { MessengerError } from './messengerPageService.js';

/**
 * Quem é a pessoa do outro lado da conversa do Messenger.
 *
 * O PSID não traz telefone nem nome confiável, então ao contrário do WhatsApp
 * não há vínculo automático: quem diz de quem é a conversa é o atendente, e o
 * vínculo é o MESMO do WhatsApp — um contrato do SGP, ou o cadastro de um
 * cliente sem contrato (`c:<id>`) —, para que o dossiê e a exclusão do
 * assinante o alcancem pelos mesmos caminhos.
 *
 * Toda leitura aqui passa por `tdb`, então um contrato de OUTRO provedor não
 * existe para quem tenta vinculá-lo: a resposta é a mesma de um contrato que
 * nunca existiu.
 */
class MessengerLinkService {
  static async get(id) {
    const conversation = await MessengerConversation.getById(id);
    if (!conversation) throw new MessengerError('conversation_not_found', 'conversation not found', 404);
    return conversation;
  }

  /** Vincula a conversa ao contrato (ou `c:<id>`) que o atendente escolheu. */
  static async link(id, key) {
    const conversation = await this.get(id);
    const wanted = String(key ?? '').trim();
    if (!wanted) throw new MessengerError('invalid_body', '`contract` is required');

    const byId = wanted.match(/^c:(\d+)$/);
    const links = byId ? [] : await SgpLink.getByContract(wanted);
    const contact = links.length === 0
      ? (byId ? await SgpContact.getById(byId[1]) : await SgpContact.getByContract(wanted))
      : null;
    if (links.length === 0 && !contact) {
      throw new MessengerError('subscriber_not_found', 'subscriber not found', 404);
    }

    const link = links[0] ?? null;
    // O mesmo caminho do WhatsApp: a conta do portal é a da ONT do contrato.
    const account = link?.device_id ? await CustomerAccount.getByDeviceId(link.device_id) : null;
    const binding = link
      ? { contract: link.contract, sgp_contact_id: null, customer_account_id: account?.id ?? null }
      : contact.contract
        ? { contract: contact.contract, sgp_contact_id: null, customer_account_id: null }
        : { contract: null, sgp_contact_id: contact.id, customer_account_id: null };
    return MessengerConversation.update(conversation.id, { ...binding, bound_via: 'operator' });
  }

  /** Tira o vínculo (o atendente vinculou a pessoa errada). */
  static async unlink(id) {
    const conversation = await this.get(id);
    return MessengerConversation.update(conversation.id, {
      contract: null, sgp_contact_id: null, customer_account_id: null, bound_via: null
    });
  }

  /**
   * O nome do cliente de cada conversa vinculada, em duas leituras para a lista
   * inteira (e não duas por linha). A ONT vence a linha do cadastro, e um nome
   * vazio na ONT não apaga o que o contrato já tinha — a mesma regra da lista do
   * WhatsApp.
   *
   * @returns {Promise<Map<number, string|null>>} conversa → nome
   */
  static async clientNames(rows) {
    const out = new Map();
    const contracts = [...new Set(rows.map((r) => r.contract).filter(Boolean))];
    const contactIds = [...new Set(rows.filter((r) => !r.contract && r.sgp_contact_id).map((r) => r.sgp_contact_id))];
    const byContract = new Map();
    if (contracts.length > 0) {
      const contacts = await tdb('sgp_contacts').whereIn('contract', contracts).select('contract', 'client_name');
      for (const c of contacts) byContract.set(c.contract, c.client_name);
      const links = await tdb('sgp_links').whereIn('contract', contracts).select('contract', 'client_name');
      for (const l of links) if (l.client_name) byContract.set(l.contract, l.client_name);
    }
    const byContact = new Map();
    if (contactIds.length > 0) {
      const found = await tdb('sgp_contacts').whereIn('id', contactIds).select('id', 'client_name');
      for (const c of found) byContact.set(Number(c.id), c.client_name);
    }
    for (const row of rows) {
      const name = row.contract
        ? byContract.get(row.contract)
        : (row.sgp_contact_id ? byContact.get(Number(row.sgp_contact_id)) : null);
      out.set(row.id, name ?? null);
    }
    return out;
  }
}

export default MessengerLinkService;
