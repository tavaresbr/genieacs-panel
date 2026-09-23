import SgpService, { SgpError, deriveContractState } from './sgpService.js';
import DeviceService from './deviceService.js';
import WaConversationService from './waConversationService.js';
import SgpLink from '../models/SgpLink.js';
import WaConversation from '../models/WaConversation.js';
import { maisAntigaEmAberto } from '../utils/wa/waCobranca.js';

/**
 * The "SGP module" beside a WhatsApp thread: who is writing, which contracts
 * they hold, what their router is doing and what they owe.
 *
 * It is the side panel an attendant used to keep open in the chat tool, and it
 * carries over the rules the compra-venda port brought with it:
 *
 * - Refuse rather than guess (`renderCobranca`). An action whose data is not
 *   all there is not offered: no unlock without an exact contract, and no
 *   contract the server did not itself find for this conversation.
 * - A phone match is a convenience, never an authentication
 *   (`waConversationService`). Everything here is for the operator's eyes; the
 *   panel never sends any of it to the subscriber on its own.
 * - A person's choice is exact (`exactContract`); only the automatic choice is
 *   a guess (`pickContract`).
 * - The invoice that matters is the oldest overdue one, else the next one due
 *   (`maisAntigaEmAberto`).
 * - The ERP being down degrades the panel instead of blanking it: each part
 *   answers on its own, and the stored link stands in for the lookup.
 *
 * The router half comes from GenieACS, not SGP: the ERP has no idea what
 * address the CPE holds, and the ONT does.
 */

function errorOf(error) {
  if (error instanceof SgpError) {
    return { code: error.code, key: error.translationKey || null, message: error.message };
  }
  return { code: error?.status === 404 ? 'not_found' : 'unavailable', key: null, message: error?.message || null };
}

function publicContract(contract) {
  if (!contract) return null;
  const { loginPassword, ...rest } = contract;
  return { ...rest, state: deriveContractState(contract) };
}

/** The shape of a looked-up contract, rebuilt from a stored link when SGP is unreachable. */
function contractFromLink(link) {
  if (!link?.contract) return null;
  return {
    contract: link.contract,
    status: link.status ?? null,
    statusLabel: link.status_label ?? null,
    plan: link.plan ?? null,
    name: link.client_name ?? null,
    document: link.document ?? null,
    address: null,
    login: link.login ?? null,
    phone: link.phone_e164 ?? null,
    blocked: link.state === 'blocked' ? true : null
  };
}

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** The address of a connected WAN first, then any address the ONT reported. */
function primaryAddress(connections) {
  const usable = connections.filter((c) => c.ipAddress && c.ipAddress !== '0.0.0.0');
  const connected = usable.filter((c) => /connected|up/i.test(String(c.status ?? '')));
  return (connected[0] || usable[0] || null)?.ipAddress ?? null;
}

class WaSubscriberPanelService {
  /**
   * The stored link that says who this conversation is, most specific first:
   * the ONT the thread was bound to, then any ONT of its contract, then
   * whatever the phone resolves to.
   */
  static async storedLink(conversation) {
    const byPhone = await WaConversationService.resolveSubscriber(conversation.wa_phone_e164);
    // How the number was recognised, when it still says the same thing as the
    // thread; `conversation` when an operator bound the thread by hand.
    const matchedOn = (link) => (byPhone.link && link && byPhone.link.contract === link.contract
      ? byPhone.matchedOn
      : 'conversation');
    if (conversation.device_id) {
      const byDevice = await SgpLink.getByDeviceId(conversation.device_id);
      if (byDevice) return { link: byDevice, matchedOn: matchedOn(byDevice) };
    }
    if (conversation.contract) {
      const [byContract] = await SgpLink.getByContract(conversation.contract);
      if (byContract) return { link: byContract, matchedOn: matchedOn(byContract) };
    }
    return { link: byPhone.link, matchedOn: byPhone.matchedOn };
  }

  /**
   * Every contract this conversation can act on, as the server found them.
   *
   * `document` is the operator's manual search, for a number the panel does
   * not know. Otherwise the stored document wins, then the bound contract.
   */
  static async findContracts(conversation, { document = null } = {}) {
    const { link, matchedOn } = await this.storedLink(conversation);
    const searchDocument = onlyDigits(document) || onlyDigits(link?.document);
    const searchContract = conversation.contract || link?.contract || null;

    if (!searchDocument && !searchContract) {
      return { link, matchedOn, contracts: [], error: null, stale: false, searched: false };
    }

    try {
      const { contracts } = await SgpService.lookupCustomer(
        searchDocument ? { document: searchDocument } : { contract: searchContract }
      );
      return { link, matchedOn, contracts, error: null, stale: false, searched: true };
    } catch (error) {
      if (error instanceof SgpError && error.code === 'not_configured') throw error;
      // The stored link stands in for the lookup: a stale contract the
      // operator can see beats a blank panel while the ERP is down.
      const fallback = document ? null : contractFromLink(link);
      return {
        link,
        matchedOn,
        contracts: fallback ? [fallback] : [],
        error: errorOf(error),
        cause: error,
        stale: Boolean(fallback),
        searched: true
      };
    }
  }

  static async router(contract, conversation) {
    const links = contract ? await SgpLink.getByContract(contract) : [];
    const deviceIds = links.map((l) => l.device_id).filter(Boolean);
    // The ONT the thread was bound to, when it belongs to this contract.
    const deviceId = deviceIds.includes(conversation.device_id) ? conversation.device_id : deviceIds[0] ?? null;
    if (!deviceId) return { available: false, reason: 'unlinked', deviceId: null, deviceIds: [] };

    const [overview, wan] = await Promise.allSettled([
      DeviceService.getCustomerPortalOverview(deviceId),
      DeviceService.getWanAddresses(deviceId)
    ]);
    if (overview.status === 'rejected' && wan.status === 'rejected') {
      return { available: false, reason: 'unreachable', deviceId, deviceIds, error: errorOf(overview.reason) };
    }
    const info = overview.status === 'fulfilled' ? overview.value : null;
    const connections = wan.status === 'fulfilled' ? wan.value : [];
    return {
      available: true,
      deviceId,
      deviceIds,
      status: info?.status ?? null,
      lastInform: info?.lastInform ?? null,
      ont: info?.ont ?? null,
      rxPower: info?.optical?.rxPower ?? null,
      connectedDevices: info?.connectedDevices ?? null,
      ipAddress: primaryAddress(connections),
      connections
    };
  }

  static async invoices(contract) {
    if (!contract) return { items: [], highlight: null, error: null };
    try {
      const { invoices } = await SgpService.listInvoices({ contract, onlyOpen: true });
      // `true`: here a not-yet-due invoice is still the one to point at, the
      // way a reminder would — the operator is answering, not dunning.
      const { fatura } = maisAntigaEmAberto(invoices, new Date(), true);
      return { items: invoices, highlight: fatura?.id ?? null, error: null };
    } catch (error) {
      return { items: [], highlight: null, error: errorOf(error) };
    }
  }

  /**
   * The whole panel for one conversation.
   *
   * `contract` is the operator's pick from "contracts found", and is exact: a
   * number that is not in the list selects nothing rather than falling back to
   * a guess. `document` is the manual search for an unknown number.
   */
  static async build(conversationId, { contract: wanted = null, document = null } = {}) {
    let conversation = await WaConversationService.get(conversationId);
    conversation = await WaConversationService.bindSubscriber(conversation);

    const config = await SgpService.getConfig();
    const attendance = {
      conversationId: conversation.id,
      phone: conversation.wa_phone_e164 || null,
      pushName: conversation.push_name || null,
      contract: conversation.contract || null,
      deviceId: conversation.device_id || null
    };

    if (!SgpService.isReady(config)) {
      return { ready: false, attendance, ticketEnabled: false };
    }

    const found = await this.findContracts(conversation, { document });
    const contracts = found.contracts;
    const selected = wanted
      ? SgpService.exactContract(contracts, wanted)
      : SgpService.pickContract(contracts, conversation.contract || found.link?.contract || null);

    const [router, invoices] = await Promise.all([
      this.router(selected?.contract ?? null, conversation),
      this.invoices(selected?.contract ?? null)
    ]);

    return {
      ready: true,
      attendance: {
        ...attendance,
        clientName: selected?.name || found.link?.client_name || null,
        document: selected?.document || found.link?.document || null,
        matchedOn: found.matchedOn || null
      },
      contracts: {
        items: contracts.map(publicContract),
        selected: selected?.contract ?? null,
        // "you asked for one that is not here" is its own answer, not a guess.
        missing: Boolean(wanted && !selected),
        searched: found.searched,
        stale: found.stale,
        error: found.error
      },
      contract: publicContract(selected),
      router,
      invoices,
      ticketEnabled: config.ticketEnabled === true
    };
  }

  /**
   * The contract an action may touch, or a refusal.
   *
   * The browser names the contract, but the server decides whether it may: it
   * has to be the one this conversation is bound to, or one the lookup for
   * this conversation returned. Anything else is someone else's contract.
   */
  static async actionContract(conversationId, wanted, { document = null } = {}) {
    const conversation = await WaConversationService.get(conversationId);
    SgpService.requireReady(await SgpService.getConfig());
    const clean = String(wanted ?? '').trim() || conversation.contract || null;
    if (!clean) {
      throw new SgpError('sgp.error.contractRequired', { code: 'missing_contract', status: 400 });
    }
    if (clean === String(conversation.contract ?? '') && !document) {
      return { conversation, contract: clean };
    }
    const { contracts, error, cause, stale } = await this.findContracts(conversation, { document });
    // Nothing the server could check against — or only the stored link standing
    // in for a lookup that failed — is not a list to authorise from.
    if (error && (contracts.length === 0 || stale)) throw cause;
    if (!SgpService.exactContract(contracts, clean)) {
      throw new SgpError('sgp.error.contractNotInConversation', {
        code: 'contract_not_in_conversation',
        status: 409
      });
    }
    return { conversation, contract: clean };
  }

  /** The operator's correction: this thread belongs to that contract. */
  static async bind(conversationId, { contract, document = null }) {
    const { conversation, contract: clean } = await this.actionContract(conversationId, contract, { document });
    const [first] = await SgpLink.getByContract(clean);
    await WaConversation.update(conversation.id, {
      contract: clean,
      device_id: first?.device_id ?? null
    });
    return this.build(conversation.id, { contract: clean });
  }

  static async unlock(conversationId, { contract }) {
    const { contract: clean } = await this.actionContract(conversationId, contract);
    const result = await SgpService.requestTrustUnlock({ contract: clean });
    return { contract: clean, message: result.message };
  }

  static async ticket(conversationId, { contract, content, note }) {
    const { contract: clean } = await this.actionContract(conversationId, contract);
    return SgpService.openTicket({ contract: clean, content, note });
  }
}

export default WaSubscriberPanelService;
