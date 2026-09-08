import WaConversation from '../models/WaConversation.js';
import WaMessage from '../models/WaMessage.js';
import WaOptOut from '../models/WaOptOut.js';
import SgpLink from '../models/SgpLink.js';
import CustomerAccount from '../models/CustomerAccount.js';
import { WaError } from './whatsappConfigService.js';
import WaSendService from './waSendService.js';
import { getDb } from '../config/database.js';

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

    const db = getDb();
    const manual = await db('sgp_links').where({ phone_manual: digits }).first();
    const link = manual || (await db('sgp_links').where({ phone_e164: digits }).first()) || null;
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
    const { link } = await this.resolveSubscriber(conversation.wa_phone_e164);
    if (!link) return conversation;
    return WaConversation.update(conversation.id, {
      contract: link.contract,
      device_id: link.device_id,
      customer_account_id: conversation.customer_account_id ?? null
    });
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

  static async list({ limit = 50, offset = 0 } = {}) {
    const rows = await WaConversation.listRecent({
      limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
      offset: Math.max(Number(offset) || 0, 0)
    });
    if (rows.length === 0) return [];

    // Two batched lookups rather than two per row: an inbox with fifty threads
    // would otherwise open a hundred queries to draw one screen.
    const contracts = [...new Set(rows.map((r) => r.contract).filter(Boolean))];
    const names = new Map();
    if (contracts.length > 0) {
      const links = await getDb()('sgp_links').whereIn('contract', contracts).select('contract', 'client_name');
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

  /**
   * One thread's messages, newest first.
   *
   * Reading a thread clears its unread count — the operator is looking at it,
   * which is the only thing "read" can mean here.
   */
  static async messages(id, { limit = PAGE } = {}) {
    const conversation = await this.get(id);
    const rows = await WaMessage.listForConversation(conversation.id, {
      limit: Math.min(Math.max(Number(limit) || PAGE, 1), 500)
    });
    if (conversation.unread_count > 0) await WaConversation.update(conversation.id, { unread_count: 0 });

    const link = conversation.contract ? await SgpLink.getByDeviceId(conversation.device_id) : null;
    return {
      conversation: this.publicConversation(conversation, {
        clientName: link?.client_name ?? null,
        optedOut: await WaOptOut.isActive({
          waPhone: conversation.wa_phone_e164,
          waLid: conversation.wa_lid
        })
      }),
      messages: rows.map((row) => WaSendService.publicMessage(row))
    };
  }
}

export default WaConversationService;
