import crypto from 'node:crypto';
import SgpLink from '../models/SgpLink.js';
import { getDb, tdb, tinsert } from '../config/database.js';
import MessengerLinkService from './messengerLinkService.js';
import { TelegramChatError } from './telegramCustomerBotService.js';
import TelegramCustomerBot from '../models/TelegramCustomerBot.js';

/** Quanto tempo um link vale: o assinante tem uma semana para abri-lo. */
export const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** O formato do token que o painel gera (16 bytes em base64url). O `start` do Telegram aceita até 64 destes caracteres. */
export const TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,64}$/;

const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Vincular a conversa do Telegram ao assinante pelo próprio assinante: um link
 * `t.me/<bot>?start=<token>` que o painel emite (para o atendente mandar ao
 * cliente, ou para o cliente logado no portal) e que, ao ser aberto, chega ao
 * webhook como `/start <token>`.
 *
 * É o mesmo desenho do `messengerLinkTokenService.js`: o token é aleatório e só
 * o hash é guardado; vale uma vez e vence em uma semana; nunca sobrescreve um
 * vínculo que já existe (o do atendente vale mais). O que ele NÃO prova é quem
 * abriu o link — quem o tem, vincula —, por isso o vínculo é `bound_via='link'`
 * e o atendente pode desfazê-lo.
 */
class TelegramLinkTokenService {
  static async activeBot() {
    const bot = await TelegramCustomerBot.get();
    return bot && bot.token && bot.bot_username && (bot.enabled === true || bot.enabled === 1) ? bot : null;
  }

  static urlFor(bot, token) {
    return `https://t.me/${bot.bot_username}?start=${token}`;
  }

  /** Emite um link para o contrato (ou `c:<id>`). */
  static async create(key, { source, userId = null }) {
    const bot = await this.activeBot();
    if (!bot) throw new TelegramChatError('no_bot', 'the customer bot is not on', 409);
    const binding = await MessengerLinkService.resolveTarget(key);
    return this.issue(bot, binding, { source, userId });
  }

  /** O link do próprio assinante logado no portal: o contrato sai da ONT dele. */
  static async createForPortalCustomer(account) {
    const bot = await this.activeBot();
    if (!bot) throw new TelegramChatError('no_bot', 'the customer bot is not on', 409);
    const link = account?.device_id ? await SgpLink.getByDeviceId(account.device_id) : null;
    if (!link?.contract) throw new TelegramChatError('subscriber_not_found', 'no contract for this account', 404);
    return this.issue(bot, {
      contract: link.contract, sgp_contact_id: null, customer_account_id: account.id
    }, { source: 'portal', userId: null });
  }

  static async issue(bot, binding, { source, userId }) {
    const token = crypto.randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + LINK_TTL_MS);
    await tinsert('telegram_link_tokens', {
      token_hash: hashOf(token),
      contract: binding.contract,
      sgp_contact_id: binding.sgp_contact_id,
      customer_account_id: binding.customer_account_id,
      source,
      created_by: userId,
      expires_at: expiresAt
    });
    return { url: this.urlFor(bot, token), expiresAt };
  }

  /**
   * Resgata um token para a conversa. Nunca lança. Devolve se vinculou.
   *
   * Marcar o token usado e vincular a conversa é UMA transação: uma falha no
   * meio não gasta o link sem vincular, e o Telegram reentrega o evento.
   */
  static async redeem({ conversation, token }) {
    if (!TOKEN_FORMAT.test(String(token ?? ''))) return { linked: false, reason: 'ignored' };
    const found = await tdb('telegram_link_tokens').where({ token_hash: hashOf(token) }).first();
    if (!found || found.used_at || new Date(found.expires_at).getTime() <= Date.now()) {
      return { linked: false, reason: 'invalid' };
    }
    if (conversation.contract || conversation.sgp_contact_id) {
      // Já vinculada (pelo atendente, ou por outro link): o link fica valendo.
      return { linked: false, reason: 'already_linked' };
    }
    return getDb().transaction(async (trx) => {
      // Só um resgate ganha a corrida: a condição `used_at is null` vai no UPDATE.
      const claimed = await tdb('telegram_link_tokens', trx)
        .where({ id: found.id })
        .whereNull('used_at')
        .update({ used_at: new Date() });
      if (claimed !== 1) return { linked: false, reason: 'raced' };
      await tdb('telegram_conversations', trx).where({ id: conversation.id }).update({
        contract: found.contract,
        sgp_contact_id: found.sgp_contact_id,
        customer_account_id: found.customer_account_id,
        bound_via: 'link',
        updated_at: new Date()
      });
      return { linked: true, reason: null };
    });
  }
}

export default TelegramLinkTokenService;
