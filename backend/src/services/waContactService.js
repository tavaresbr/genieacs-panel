import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import SgpLink from '../models/SgpLink.js';
import SgpContact from '../models/SgpContact.js';
import SgpService from './sgpService.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import CustomerAccount from '../models/CustomerAccount.js';
import { WaError } from './whatsappConfigService.js';
import WaBillingService from './waBillingService.js';
import WaConversationService from './waConversationService.js';
import { tdb } from '../config/database.js';
import { normalizarTelefoneBr, variantesTelefoneBr } from '../utils/wa/waDestino.js';

/** The page the screen asks for, and the most it may ask for. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * How many `sgp_links` rows one listing reads before collapsing them into
 * subscribers. A contract can cover several ONTs, so paging by row would split
 * a subscriber across two pages; reading a bounded window and paging the
 * collapsed list keeps one subscriber per line at the cost of a ceiling that a
 * search narrows long before anyone reaches it.
 */
const ROW_CEILING = 5000;

/** CPF/CNPJ on screen as its last digits only — the search still sees all of it. */
function maskDocument(document) {
  const digits = String(document ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return `•••${digits.slice(-4)}`;
}

/**
 * The SGP's subscribers as WhatsApp contacts.
 *
 * The inbox knew a subscriber only after they wrote in. This is the other
 * direction: the operator looks a subscriber up — by name, contract, document
 * or number — sees whether there is already a thread with them, and opens one
 * when there is not.
 *
 * Two directories, both read through `tdb` because two providers can hold the
 * same contract number and neither may see the other's subscriber here:
 * `sgp_links`, the mirror of the ERP per ONT, and `sgp_contacts`, the
 * subscribers an operator looked up in the SGP that have no ONT in the panel.
 */
class WaContactService {
  static async list({ search = '', limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    const size = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = Math.max(Number(offset) || 0, 0);
    const raw = String(search ?? '').trim();

    const withDevice = WaBillingService.subscribersFrom(await this.searchTable('sgp_links', raw));
    const known = new Set(withDevice.map((s) => s.contract));
    // A contract that has since gained an ONT is drawn from `sgp_links`, which
    // is the fresher mirror; its `sgp_contacts` row is only a leftover.
    const withoutDevice = (await this.searchTable('sgp_contacts', raw))
      .filter((row) => !known.has(String(row.contract)))
      .map((row) => this.subscriberFromContact(row));

    const subscribers = [...withDevice, ...withoutDevice].sort((a, b) => (
      String(a.clientName ?? '').localeCompare(String(b.clientName ?? ''), 'pt-BR')
      || String(a.contract).localeCompare(String(b.contract))
    ));
    const page = subscribers.slice(skip, skip + size);
    return {
      total: subscribers.length,
      contacts: await this.decorate(page)
    };
  }

  /**
   * One of the two directories, filtered by what the operator typed. The two
   * tables share every column the search reads, on purpose.
   */
  static async searchTable(table, raw) {
    const query = tdb(table);
    const term = WaConversation.likeTerm(raw);
    if (raw) {
      const like = `%${term}%`;
      const digits = term.replace(/\D/g, '');
      query.where((match) => {
        // Same rule as the inbox: a term that stripping LIKE's wildcards
        // emptied must match nothing, not everything.
        if (!term) {
          match.whereRaw('1 = 0');
          return;
        }
        match
          .whereRaw('lower(client_name) like ?', [like])
          .orWhereRaw('lower(contract) like ?', [like]);
        if (digits) {
          match
            .orWhere('document', 'like', `%${digits}%`)
            .orWhere('phone_e164', 'like', `%${digits}%`)
            .orWhere('phone_manual', 'like', `%${digits}%`);
        }
      });
    }
    return query
      .orderBy('client_name', 'asc')
      .orderBy('contract', 'asc')
      .orderBy('id', 'asc')
      .limit(ROW_CEILING);
  }

  /** An `sgp_contacts` row in the shape `subscribersFrom` gives an `sgp_links` one. */
  static subscriberFromContact(row) {
    const manual = normalizarTelefoneBr(row.phone_manual);
    const fromSgp = normalizarTelefoneBr(row.phone_e164);
    return {
      contract: String(row.contract),
      clientName: row.client_name || null,
      document: row.document || null,
      deviceId: null,
      phone: manual || fromSgp || null,
      phoneSource: manual ? 'manual' : (fromSgp ? 'sgp' : null)
    };
  }

  /**
   * The subscriber behind a contract, from whichever directory holds it: the
   * one with an ONT first, then the one found by a lookup.
   */
  static async subscriberFor(contract) {
    const key = String(contract ?? '').trim();
    if (!key) return null;
    const links = await SgpLink.getByContract(key);
    if (links.length > 0) return WaBillingService.subscribersFrom(links)[0];
    const contact = await SgpContact.getByContract(key);
    return contact ? this.subscriberFromContact(contact) : null;
  }

  /**
   * Asks the SGP itself, for the subscriber the panel has no ONT for.
   *
   * The SGP answers by document or by contract, never by name, so the term is
   * read as a CPF (11 digits) or CNPJ (14 digits) when it is one, and as a
   * contract otherwise. What comes back is kept in `sgp_contacts` — unless the
   * contract already has an ONT, in which case `sgp_links` owns it — so that
   * the thread opened from it has a subscriber to point at, and the number
   * resolves when the subscriber writes in.
   */
  static async lookupSgp(term) {
    const raw = String(term ?? '').trim();
    const digits = raw.replace(/\D/g, '');
    if (!raw) {
      throw new WaError('whatsapp.error.lookupTermRequired', { code: 'lookup_term_required', status: 400 });
    }
    const filters = digits.length === 11 || digits.length === 14
      ? { document: digits }
      : { contract: raw };

    const found = await SgpService.lookupContacts(filters);
    const contracts = [];
    for (const contract of found) {
      if ((await SgpLink.getByContract(contract.contract)).length === 0) {
        await SgpContact.upsertFromSgp(SgpService.contractToContactRow(contract));
      }
      if (!contracts.includes(contract.contract)) contracts.push(contract.contract);
    }

    const subscribers = [];
    for (const contract of contracts) {
      const subscriber = await this.subscriberFor(contract);
      if (subscriber) subscribers.push(subscriber);
    }
    return { total: subscribers.length, contacts: await this.decorate(subscribers) };
  }

  /**
   * Which of these subscribers already has a thread, and who asked not to be
   * contacted. Two batched lookups for the page, never one per row.
   */
  static async decorate(subscribers) {
    if (subscribers.length === 0) return [];
    const contracts = subscribers.map((s) => s.contract);
    const phones = [...new Set(subscribers.flatMap((s) => variantesTelefoneBr(s.phone)))];

    const threads = await tdb('wa_conversations')
      .where((match) => {
        match.whereIn('contract', contracts);
        if (phones.length > 0) match.orWhereIn('wa_phone_e164', phones);
      })
      .orderBy('last_message_at', 'desc')
      .select('id', 'contract', 'wa_phone_e164', 'last_message_at', 'closed_at');
    const blocked = await WaOptOut.activePhones(phones);

    return subscribers.map((subscriber) => {
      const spellings = variantesTelefoneBr(subscriber.phone);
      // The thread bound to the contract first: it is the one an operator
      // already confirmed. A thread matched only by number comes second.
      const thread = threads.find((row) => row.contract === subscriber.contract)
        || threads.find((row) => spellings.includes(row.wa_phone_e164))
        || null;
      return {
        contract: subscriber.contract,
        clientName: subscriber.clientName,
        document: maskDocument(subscriber.document),
        deviceId: subscriber.deviceId,
        // False for a subscriber found by a lookup: the SGP knows them, the
        // panel has no ONT of theirs.
        hasDevice: Boolean(subscriber.deviceId),
        phone: subscriber.phone,
        phoneSource: subscriber.phoneSource,
        optedOut: spellings.some((phone) => blocked.has(phone)),
        conversationId: thread?.id ?? null,
        lastMessageAt: thread?.last_message_at ?? null
      };
    });
  }

  /**
   * The thread with this subscriber: the one that exists, or a new one.
   *
   * Opening is not sending. A new thread is an empty row the operator writes
   * into; nothing leaves the panel until they press send, and then it leaves
   * through the same queue, opt-out check and all, as any other reply.
   *
   * @returns {Promise<{ conversation: object, created: boolean }>}
   */
  static async openConversation(contract) {
    const subscriber = await this.subscriberFor(contract);
    if (!subscriber) {
      throw new WaError('whatsapp.error.subscriberNotFound', {
        code: 'subscriber_not_found',
        status: 404
      });
    }
    const [contact] = await this.decorate([subscriber]);

    if (contact.conversationId) {
      const existing = await WaConversation.getById(contact.conversationId);
      return { conversation: await WaConversationService.decorate(existing), created: false };
    }

    const number = normalizarTelefoneBr(subscriber.phone);
    if (!number) {
      throw new WaError('whatsapp.error.subscriberNoPhone', {
        code: 'subscriber_no_phone',
        status: 409
      });
    }
    const account = await WhatsAppAccount.getForPurpose('general');
    if (!account) {
      throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 400 });
    }

    const conversation = await WaConversation.ensure({
      accountId: account.id,
      // The canonical form the inbound handler builds, so the subscriber's
      // answer lands in this thread — `ensure` also finds it under the other
      // spelling of the ninth digit.
      externalThreadId: `${number}@s.whatsapp.net`,
      waPhone: number,
      pushName: subscriber.clientName || null
    });
    const customer = subscriber.deviceId ? await CustomerAccount.getByDeviceId(subscriber.deviceId) : null;
    const bound = conversation.contract
      ? conversation
      : await WaConversation.update(conversation.id, {
        contract: subscriber.contract,
        device_id: subscriber.deviceId,
        customer_account_id: conversation.customer_account_id ?? customer?.id ?? null
      });
    return { conversation: await WaConversationService.decorate(bound), created: true };
  }
}

export default WaContactService;
