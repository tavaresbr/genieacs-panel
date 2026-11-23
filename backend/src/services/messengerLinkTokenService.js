import crypto from 'node:crypto';
import MessengerPage from '../models/MessengerPage.js';
import MessengerConversation from '../models/MessengerConversation.js';
import SgpLink from '../models/SgpLink.js';
import { getDb, tdb, tinsert } from '../config/database.js';
import MessengerLinkService from './messengerLinkService.js';
import { MessengerError } from './messengerPageService.js';
import { modeloCitaLinkMessenger } from '../utils/wa/waCobranca.js';

/** Quanto tempo um link vale: o assinante tem uma semana para abri-lo. */
export const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** O formato do token que o painel gera (16 bytes em base64url). Qualquer outro `ref` é de outra origem. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,64}$/;

const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** O `ref` de um evento do Messenger, onde quer que a Meta o ponha (ou `null`). */
export function refOf(event) {
  const ref = event?.referral?.ref
    ?? event?.postback?.referral?.ref
    ?? event?.message?.referral?.ref;
  return typeof ref === 'string' && TOKEN_FORMAT.test(ref) ? ref : null;
}

/**
 * Vincular a conversa do Messenger ao assinante pelo próprio assinante: um link
 * `m.me/<Página>?ref=<token>` que o painel emite (para o atendente mandar ao
 * cliente, ou para o cliente logado no portal) e que, ao ser aberto, chega ao
 * webhook como `referral`.
 *
 * O que dá segurança ao vínculo:
 * - o token é aleatório e só o hash é guardado;
 * - vale uma vez e vence em uma semana, então um link repassado não vincula uma
 *   segunda pessoa;
 * - o resgate roda no provedor dono da Página, e a leitura é escopada: um token
 *   de outro provedor não existe aqui;
 * - nunca sobrescreve um vínculo que já existe (o do atendente vale mais que o
 *   de um link aberto por quem quer que seja).
 * O que ele NÃO prova é quem abriu o link: quem o tem, vincula. Por isso o
 * vínculo é marcado `bound_via = 'link'` e o atendente pode desfazê-lo.
 */
class MessengerLinkTokenService {
  /** A Página a que o link aponta: a primeira conectada e sem erro. */
  static async activePage() {
    const pages = await MessengerPage.getAll();
    return pages.find((p) => p.status === 'connected') ?? null;
  }

  static urlFor(page, token) {
    return `https://m.me/${page.page_id}?ref=${token}`;
  }

  /**
   * Emite um link para o contrato (ou `c:<id>`).
   * @returns {Promise<{ url: string, expiresAt: Date }>}
   */
  static async create(key, { source, userId = null }) {
    const page = await this.activePage();
    if (!page) throw new MessengerError('no_page', 'no Messenger Page is connected', 409);
    const binding = await MessengerLinkService.resolveTarget(key);
    return this.issue(page, binding, { source, userId });
  }

  /** O link do próprio assinante logado no portal: o contrato sai da ONT dele. */
  static async createForPortalCustomer(account) {
    const page = await this.activePage();
    if (!page) throw new MessengerError('no_page', 'no Messenger Page is connected', 409);
    const link = account?.device_id ? await SgpLink.getByDeviceId(account.device_id) : null;
    if (!link?.contract) throw new MessengerError('subscriber_not_found', 'no contract for this account', 404);
    return this.issue(page, {
      contract: link.contract, sgp_contact_id: null, customer_account_id: account.id
    }, { source: 'portal', userId: null });
  }

  /**
   * A variável `{{link_messenger}}` de um modelo de cobrança: um link de uso
   * único para o contrato, ou nada.
   *
   * Só emite se o modelo CITA a variável (a maioria não cita, e emitir à toa
   * encheria a tabela). E NUNCA lança: o link é um extra da cobrança, e uma
   * Página fora do ar, um contrato sem cadastro ou um erro de banco não podem
   * virar "a cobrança não saiu". Sem link a variável fica vazia, e o render
   * tira a linha que a cita (`renderCobranca`, exceção à regra 1).
   *
   * @returns {Promise<{ link_messenger?: string }>} para espalhar nas variáveis
   */
  static async varsForTemplate(body, contract) {
    if (!modeloCitaLinkMessenger(body) || !contract) return {};
    try {
      const { url } = await this.create(contract, { source: 'invoice', userId: null });
      return { link_messenger: url };
    } catch (error) {
      // "Sem Página" e "contrato desconhecido" são esperados; o resto vale um aviso.
      if (!(error instanceof MessengerError)) {
        console.warn(`[messenger] could not issue an invoice link: ${error.message}`);
      }
      return {};
    }
  }

  static async issue(page, binding, { source, userId }) {
    const token = crypto.randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + LINK_TTL_MS);
    await tinsert('messenger_link_tokens', {
      token_hash: hashOf(token),
      contract: binding.contract,
      sgp_contact_id: binding.sgp_contact_id,
      customer_account_id: binding.customer_account_id,
      source,
      created_by: userId,
      expires_at: expiresAt
    });
    return { url: this.urlFor(page, token), expiresAt };
  }

  /**
   * Resgata um `ref` para a pessoa `psid` da Página. Nunca lança: um evento
   * ruim não derruba a entrega. Devolve se vinculou (para o teste e o log).
   *
   * Tudo roda numa transação — marcar o token usado e vincular a conversa ou
   * as duas coisas ou nenhuma: uma falha no meio não pode gastar o link sem
   * vincular, e a Meta reentrega o evento.
   */
  static async redeem({ page, psid, ref }) {
    if (!psid || !TOKEN_FORMAT.test(String(ref ?? ''))) return { linked: false, reason: 'ignored' };
    const hash = hashOf(ref);
    const token = await tdb('messenger_link_tokens').where({ token_hash: hash }).first();
    if (!token || token.used_at || new Date(token.expires_at).getTime() <= Date.now()) {
      return { linked: false, reason: 'invalid' };
    }

    const conversation = await MessengerConversation.ensure({ pageRowId: page.id, psid: String(psid) });
    if (conversation.contract || conversation.sgp_contact_id) {
      // Já vinculada (pelo atendente, ou por outro link): o link fica valendo.
      return { linked: false, reason: 'already_linked' };
    }

    return getDb().transaction(async (trx) => {
      // Só um resgate ganha a corrida: a condição `used_at is null` vai no UPDATE.
      const claimed = await tdb('messenger_link_tokens', trx)
        .where({ id: token.id })
        .whereNull('used_at')
        .update({ used_at: new Date() });
      if (claimed !== 1) return { linked: false, reason: 'raced' };
      await tdb('messenger_conversations', trx).where({ id: conversation.id }).update({
        contract: token.contract,
        sgp_contact_id: token.sgp_contact_id,
        customer_account_id: token.customer_account_id,
        bound_via: 'link',
        updated_at: new Date()
      });
      return { linked: true, reason: null };
    });
  }
}

export default MessengerLinkTokenService;
