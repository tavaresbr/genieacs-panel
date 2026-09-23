import WaConversation from '../models/WaConversation.js';
import WaMessage from '../models/WaMessage.js';
import WaOptOut from '../models/WaOptOut.js';
import SgpLink from '../models/SgpLink.js';
import SgpContact from '../models/SgpContact.js';
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
   * The `sgp_contacts` subscriber behind a phone — the one with no ONT in the
   * panel. Same order as `resolveSubscriber`: the operator's correction first.
   */
  /** How a conversation points at an `sgp_contacts` row: by contract, or by the row. */
  static contactBinding(contact) {
    return contact.contract
      ? { contract: contact.contract, device_id: null, sgp_contact_id: null }
      : { contract: null, device_id: null, sgp_contact_id: contact.id };
  }

  static async resolveContact(phone) {
    const spellings = variantesTelefoneBr(phone);
    if (spellings.length === 0) return null;
    return (await tdb('sgp_contacts').whereIn('phone_manual', spellings).orderBy('id', 'asc').first())
      || (await tdb('sgp_contacts').whereIn('phone_e164', spellings).orderBy('id', 'asc').first())
      || null;
  }

  /**
   * Binds a conversation to the subscriber it belongs to.
   *
   * Written once, when the thread is first resolved, and left alone afterwards:
   * an operator who corrected the link by hand must not have it overwritten by
   * the next inbound message.
   */
  static async bindSubscriber(conversation) {
    if (!conversation || conversation.contract || conversation.sgp_contact_id) return conversation;
    const { link, account } = await this.resolveSubscriber(conversation.wa_phone_e164);
    if (!link) {
      // No ONT for this number, but maybe a subscriber an operator already
      // looked up in the SGP. Bound here and not in `resolveSubscriber`: the bot
      // reads that one, and it answers about invoices and signal from the ONT.
      const contact = await this.resolveContact(conversation.wa_phone_e164);
      if (!contact) return conversation;
      return WaConversation.update(conversation.id, this.contactBinding(contact));
    }
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
    const pending = rows.filter((row) => !row.contract && !row.sgp_contact_id && row.wa_phone_e164);
    if (pending.length === 0) return rows;

    const spellingsOf = new Map(pending.map((row) => [row.id, variantesTelefoneBr(row.wa_phone_e164)]));
    const all = [...new Set([...spellingsOf.values()].flat())];
    if (all.length === 0) return rows;
    const byPhone = (match) => match.whereIn('phone_manual', all).orWhereIn('phone_e164', all);
    const links = await tdb('sgp_links').where(byPhone).orderBy('id', 'asc');
    const contacts = await tdb('sgp_contacts').where(byPhone).orderBy('id', 'asc');
    if (links.length === 0 && contacts.length === 0) return rows;

    const pick = (rowsOf, spellings) => rowsOf.find((l) => spellings.includes(l.phone_manual))
      || rowsOf.find((l) => spellings.includes(l.phone_e164));

    for (const row of pending) {
      const spellings = spellingsOf.get(row.id);
      const link = pick(links, spellings);
      if (!link) {
        const contact = pick(contacts, spellings);
        if (!contact) continue;
        const patch = this.contactBinding(contact);
        await WaConversation.update(row.id, patch);
        Object.assign(row, patch);
        continue;
      }
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
    // `c:<id>` names a client with no contract, by its `sgp_contacts` row.
    const byId = key.match(/^c:(\d+)$/);
    const links = key && !byId ? await SgpLink.getByContract(key) : [];
    // A subscriber with no ONT in the panel, found by a lookup or the sync.
    const contact = links.length === 0 && key
      ? (byId ? await SgpContact.getById(byId[1]) : await SgpContact.getByContract(key))
      : null;
    if (links.length === 0 && !contact) {
      throw new WaError('whatsapp.error.subscriberNotFound', {
        code: 'subscriber_not_found',
        status: 404
      });
    }
    const link = links[0] ?? null;
    const account = link?.device_id ? await CustomerAccount.getByDeviceId(link.device_id) : null;
    const updated = await WaConversation.update(conversation.id, link
      ? { contract: link.contract, device_id: link.device_id ?? null, sgp_contact_id: null, customer_account_id: account?.id ?? null }
      : { ...this.contactBinding(contact), customer_account_id: null });

    const phone = normalizarTelefoneBr(conversation.wa_phone_e164);
    if (savePhone && phone) {
      if (link) await SgpLink.setManualPhone(link.contract, phone);
      else await SgpContact.setManualPhoneById(contact.id, phone);
    }

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
      sgpContactId: row.sgp_contact_id ? Number(row.sgp_contact_id) : null,
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
    const contacts = await tdb('sgp_contacts').whereRaw('lower(client_name) like ?', [like]).select('contract');
    return [...new Set([...links, ...contacts].map((row) => row.contract).filter(Boolean))];
  }

  /** Same question for the clients with no contract, who are bound by row id. */
  static async contactIdsMatchingClientName(term) {
    const like = `%${WaConversation.likeTerm(term)}%`;
    if (like === '%%') return [];
    const rows = await tdb('sgp_contacts')
      .whereNull('contract')
      .whereRaw('lower(client_name) like ?', [like])
      .select('id');
    return rows.map((row) => row.id);
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
      searchContracts: term ? await this.contractsMatchingClientName(term) : [],
      searchContactIds: term ? await this.contactIdsMatchingClientName(term) : []
    });
    if (rows.length === 0) return [];
    await this.bindUnlinked(rows);

    // Two batched lookups rather than two per row: an inbox with fifty threads
    // would otherwise open a hundred queries to draw one screen.
    const contracts = [...new Set(rows.map((r) => r.contract).filter(Boolean))];
    const names = new Map();
    const contactIds = [...new Set(rows.filter((r) => !r.contract && r.sgp_contact_id).map((r) => r.sgp_contact_id))];
    const contactNames = new Map();
    if (contactIds.length > 0) {
      const found = await tdb('sgp_contacts').whereIn('id', contactIds).select('id', 'client_name');
      for (const contact of found) contactNames.set(Number(contact.id), contact.client_name);
    }
    if (contracts.length > 0) {
      // The ONT's mirror wins over a lookup's row for the same contract.
      const contacts = await tdb('sgp_contacts').whereIn('contract', contracts).select('contract', 'client_name');
      for (const contact of contacts) names.set(contact.contract, contact.client_name);
      const links = await tdb('sgp_links').whereIn('contract', contracts).select('contract', 'client_name');
      for (const link of links) names.set(link.contract, link.client_name);
    }
    const blocked = await WaOptOut.activePhones(rows.map((r) => r.wa_phone_e164));

    return rows.map((row) => this.publicConversation(row, {
      clientName: row.contract
        ? names.get(row.contract) ?? null
        : (row.sgp_contact_id ? contactNames.get(Number(row.sgp_contact_id)) ?? null : null),
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
    const link = conversation.contract && conversation.device_id
      ? await SgpLink.getByDeviceId(conversation.device_id)
      : null;
    const contact = link
      ? null
      : (conversation.contract
        ? await SgpContact.getByContract(conversation.contract)
        : (conversation.sgp_contact_id ? await SgpContact.getById(conversation.sgp_contact_id) : null));
    return this.publicConversation(conversation, {
      clientName: link?.client_name ?? contact?.client_name ?? null,
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
    if (!conversation.contract && !conversation.sgp_contact_id) conversation = await this.bindSubscriber(conversation);
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
