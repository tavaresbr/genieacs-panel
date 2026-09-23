import WaConversation from '../models/WaConversation.js';
import WaMessage from '../models/WaMessage.js';
import WaOptOut from '../models/WaOptOut.js';
import SgpLink from '../models/SgpLink.js';
import CustomerAccount from '../models/CustomerAccount.js';
import { WaError } from './whatsappConfigService.js';
import WaSendService from './waSendService.js';
import { tdb } from '../config/database.js';
import { normalizarTelefoneBr, variantesTelefoneBr } from '../utils/wa/waDestino.js';

/** How many messages a thread hands back before the caller has to ask for more. */
const PAGE = 100;

/**
 * Reading the inbox, and knowing who is on the other end.
 *
 * The identity half is the interesting one. A WhatsApp message arrives with a
 * phone number and nothing else — no login, no session, no contract. Resolving
 * it to a subscriber is what lets an operator see the ONT and the invoices next
 * to the conversation, and it is what the self-service bot needs before it can
 * answer anything specific.
 *
 * That resolution is a CONVENIENCE, never an authentication. Whoever wrote in
 * proved only that they hold a phone that WhatsApp will deliver to. Nothing
 * that resolution unlocks may be a secret or a destructive action: the panel
 * has a customer portal with a real password for that, and the bot's job is to
 * send its link rather than to become a second, weaker door into the same data.
 */
class WaConversationService {
  /**
   * Resolves the subscriber behind a phone number.
   *
   * Ordered by how much the match is worth: the manual number an operator typed
   * beats the one SGP synced, because the operator was correcting the ERP when
   * they typed it. The portal account comes last and only through the device,
   * since it has no phone of its own.
   *
   * @returns {Promise<{ link: object|null, account: object|null, matchedOn: 'manual'|'sgp'|null }>}
   */
  static async resolveSubscriber(phone) {
    const digits = String(phone ?? '').replace(/\D/g, '');
    if (!digits) return { link: null, account: null, matchedOn: null };
    // Com e sem o nono dígito: o WhatsApp entrega muito celular antigo como
    // 55 + DDD + 8, e o SGP guarda o mesmo aparelho com o 9. Comparar só a
    // grafia exata deixava o assinante que escreve do número cadastrado como
    // "não vinculado".
    const spellings = [...new Set([digits, ...variantesTelefoneBr(digits)])];

    // Through `tdb`: a number that belongs to another provider's subscriber has
    // to come back unknown here. Resolving it would hand this provider's
    // operator — and, through the bot, whoever holds that phone — a contract,
    // a name and a document from a cadastre they have no part in.
    const manual = await tdb('sgp_links').whereIn('phone_manual', spellings).orderBy('id', 'asc').first();
    const link = manual
      || (await tdb('sgp_links').whereIn('phone_e164', spellings).orderBy('id', 'asc').first())
      || null;
    if (!link) return { link: null, account: null, matchedOn: null };

    const account = link.device_id ? await CustomerAccount.getByDeviceId(link.device_id) : null;
    return { link, account, matchedOn: manual ? 'manual' : 'sgp' };
  }

  /**
   * Binds a conversation to the subscriber it belongs to.
   *
   * Written once, when the thread is first resolved, and left alone afterwards:
   * an operator who corrected the link by hand must not have it overwritten by
   * the next inbound message.
   */
  static async bindSubscriber(conversation) {
    if (!conversation || conversation.contract) return conversation;
    const { link, account } = await this.resolveSubscriber(conversation.wa_phone_e164);
    if (!link) return conversation;
    return WaConversation.update(conversation.id, {
      contract: link.contract,
      device_id: link.device_id,
      // `account?.id`, e não o próprio valor de volta.
      //
      // Esta linha gravava `conversation.customer_account_id ?? null`, que é
      // sempre nulo: `WaConversation.ensure` não preenche a coluna no insert, e
      // este era o único outro lugar do produto que a mencionava. A coluna
      // existe desde que a caixa de entrada nasceu, com chave estrangeira e
      // tudo, e nunca teve um valor — o `resolveSubscriber` logo acima já
      // devolvia a conta e ela era descartada aqui.
      //
      // Descoberto ao procurar, para a exportação de dados por assinante, qual
      // coluna liga uma conversa a um titular. Era esta, e ela estava morta.
      customer_account_id: conversation.customer_account_id ?? account?.id ?? null
    });
  }

  /**
   * `bindSubscriber` for a whole page of the inbox, in two queries.
   *
   * The inbox used to show every thread from before the binding existed — and
   * every thread the bot never answered — as "not linked to any subscriber",
   * forever. Resolving them here fixes the backlog as the operator scrolls,
   * without a migration and without one query per row on a list that polls.
   * Rows are patched in place, so the caller draws the contract it just
   * learned. A thread that already carries a contract is never touched.
   */
  static async bindUnlinked(rows) {
    const pending = rows.filter((row) => !row.contract && row.wa_phone_e164);
    if (pending.length === 0) return rows;

    const spellingsOf = new Map(pending.map((row) => [row.id, variantesTelefoneBr(row.wa_phone_e164)]));
    const all = [...new Set([...spellingsOf.values()].flat())];
    if (all.length === 0) return rows;
    const links = await tdb('sgp_links')
      .where((match) => match.whereIn('phone_manual', all).orWhereIn('phone_e164', all))
      .orderBy('id', 'asc');
    if (links.length === 0) return rows;

    for (const row of pending) {
      const spellings = spellingsOf.get(row.id);
      const link = links.find((l) => spellings.includes(l.phone_manual))
        || links.find((l) => spellings.includes(l.phone_e164));
      if (!link) continue;
      const account = link.device_id ? await CustomerAccount.getByDeviceId(link.device_id) : null;
      const patch = {
        contract: link.contract,
        device_id: link.device_id,
        customer_account_id: row.customer_account_id ?? account?.id ?? null
      };
      await WaConversation.update(row.id, patch);
      Object.assign(row, patch);
    }
    return rows;
  }

  /**
   * The operator saying who this thread is, by hand.
   *
   * For the number the ERP does not know — the subscriber writing from a
   * relative's phone, a new chip, a cadastre with no mobile at all. Unlike
   * `bindSubscriber` this DOES overwrite: it is the correction that the
   * automatic binding promises never to undo.
   *
   * `savePhone` also records the thread's number as the contract's manual
   * phone, so the next message from it resolves on its own and billing reaches
   * the number the subscriber actually answers. It is the same write as the
   * billing screen's number correction, and the controller holds it to the
   * same permission.
   */
  static async linkSubscriber(id, { contract, savePhone = false } = {}) {
    const conversation = await this.get(id);
    const key = String(contract ?? '').trim();
    const links = key ? await SgpLink.getByContract(key) : [];
    if (links.length === 0) {
      throw new WaError('whatsapp.error.subscriberNotFound', {
        code: 'subscriber_not_found',
        status: 404
      });
    }
    const link = links[0];
    const account = link.device_id ? await CustomerAccount.getByDeviceId(link.device_id) : null;
    const updated = await WaConversation.update(conversation.id, {
      contract: link.contract,
      device_id: link.device_id,
      customer_account_id: account?.id ?? null
    });

    const phone = normalizarTelefoneBr(conversation.wa_phone_e164);
    if (savePhone && phone) await SgpLink.setManualPhone(link.contract, phone);

    return this.decorate(updated);
  }

  /** The browser shape. Built field by field, like every other public shape here. */
  static publicConversation(row, extra = {}) {
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      waPhoneE164: row.wa_phone_e164 || null,
      waLid: row.wa_lid || null,
      pushName: row.push_name || null,
      deviceId: row.device_id || null,
      contract: row.contract || null,
      clientName: extra.clientName ?? null,
      optedOut: extra.optedOut ?? false,
      lastMessageAt: row.last_message_at || null,
      lastInboundAt: row.last_inbound_at || null,
      unreadCount: Number(row.unread_count || 0),
      closedAt: row.closed_at || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };
  }

  /**
   * The contracts whose subscriber name matches what the operator typed.
   *
   * One batched query standing in for a join, scoped like every other read of
   * `sgp_links` since 0017. Two providers can now hold the same contract
   * number, so an unfiltered search would not merely be untidy: it would let a
   * name typed here match a contract that exists in both and pull this
   * provider's threads up under the other provider's subscriber name.
   */
  static async contractsMatchingClientName(term) {
    const like = `%${WaConversation.likeTerm(term)}%`;
    if (like === '%%') return [];
    const links = await tdb('sgp_links').whereRaw('lower(client_name) like ?', [like]).select('contract');
    return [...new Set(links.map((link) => link.contract).filter(Boolean))];
  }

  /**
   * @param {'open'|'closed'|'all'} status which pile to draw.
   *
   * The default is `open`, and that is the whole point of the closing work: an
   * inbox is a list of what still needs answering, not an archive of everything
   * that ever arrived. A thread an operator closed is a decision already taken,
   * and leaving it in the default view would put the panel back where it
   * started — a list nobody can read past its first hundred rows. Closing is
   * still not deletion, so `closed` and `all` are one parameter away.
   */
  static async list({ limit = 50, offset = 0, search = '', status = 'open' } = {}) {
    const term = String(search ?? '').trim();
    const rows = await WaConversation.listRecent({
      limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
      offset: Math.max(Number(offset) || 0, 0),
      status: ['open', 'closed', 'all'].includes(status) ? status : 'open',
      search: term,
      searchContracts: term ? await this.contractsMatchingClientName(term) : []
    });
    if (rows.length === 0) return [];
    await this.bindUnlinked(rows);

    // Two batched lookups rather than two per row: an inbox with fifty threads
    // would otherwise open a hundred queries to draw one screen.
    const contracts = [...new Set(rows.map((r) => r.contract).filter(Boolean))];
    const names = new Map();
    if (contracts.length > 0) {
      const links = await tdb('sgp_links').whereIn('contract', contracts).select('contract', 'client_name');
      for (const link of links) names.set(link.contract, link.client_name);
    }
    const blocked = await WaOptOut.activePhones(rows.map((r) => r.wa_phone_e164));

    return rows.map((row) => this.publicConversation(row, {
      clientName: row.contract ? names.get(row.contract) ?? null : null,
      optedOut: blocked.has(row.wa_phone_e164)
    }));
  }

  static async get(id) {
    const numeric = Number.parseInt(String(id ?? ''), 10);
    // Parsed here rather than in the controller: a non-numeric id reaching knex
    // is a database error on Postgres, not a 404.
    const row = Number.isInteger(numeric) && numeric > 0 ? await WaConversation.getById(numeric) : null;
    if (!row) {
      throw new WaError('whatsapp.error.conversationNotFound', {
        code: 'conversation_not_found',
        status: 404
      });
    }
    return row;
  }

  /** The thread as the browser wants it, with the two facts the row cannot hold. */
  static async decorate(conversation) {
    const link = conversation.contract ? await SgpLink.getByDeviceId(conversation.device_id) : null;
    return this.publicConversation(conversation, {
      clientName: link?.client_name ?? null,
      optedOut: await WaOptOut.isActive({
        waPhone: conversation.wa_phone_e164,
        waLid: conversation.wa_lid
      })
    });
  }

  /**
   * Files a thread away, or takes it back out.
   *
   * Closing is a filing decision and nothing else: the conversation and every
   * message in it stay exactly where they are, and only `closed_at` moves. The
   * counterpart lives in `waInboundService` — a customer who writes again
   * reopens their own thread, because an archive cannot answer anybody.
   */
  static async setStatus(id, status) {
    const conversation = await this.get(id);
    const closing = status === 'closed';
    // Reopening an open thread and closing a closed one are both writes that
    // change nothing; letting them through keeps the route idempotent, which is
    // what a double-click on the button deserves.
    const updated = await WaConversation.update(conversation.id, {
      closed_at: closing ? new Date() : null
    });
    return this.decorate(updated);
  }

  /**
   * One thread's messages, newest first.
   *
   * Reading a thread clears its unread count — the operator is looking at it,
   * which is the only thing "read" can mean here.
   */
  static async messages(id, { limit = PAGE, before = null } = {}) {
    let conversation = await this.get(id);
    // A thread that arrived before the subscriber's number was known — or
    // before inbound messages bound it at all — is resolved when it is opened.
    if (!conversation.contract) conversation = await this.bindSubscriber(conversation);
    const cursor = Number.parseInt(String(before ?? ''), 10);
    const rows = await WaMessage.listForConversation(conversation.id, {
      limit: Math.min(Math.max(Number(limit) || PAGE, 1), 500),
      before: Number.isInteger(cursor) && cursor > 0 ? cursor : null
    });
    if (conversation.unread_count > 0) await WaConversation.update(conversation.id, { unread_count: 0 });

    return {
      conversation: await this.decorate(conversation),
      messages: rows.map((row) => WaSendService.publicMessage(row))
    };
  }
}

export default WaConversationService;
