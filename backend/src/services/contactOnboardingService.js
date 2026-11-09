import SgpService, { SgpError } from './sgpService.js';
import SgpClient from '../models/SgpClient.js';
import SgpContact from '../models/SgpContact.js';
import WaContactService from './waContactService.js';
import ContactProfileService, { ContactProfileError } from './contactProfileService.js';
import { lookupCnpj } from './cnpjLookupService.js';
import TeiahService, { TeiahError } from './teiahService.js';
import AsaasCustomer from '../models/AsaasCustomer.js';
import AsaasProviderService from './asaasProviderService.js';
import { lookupCep } from './addressLookupService.js';
import { isValidCnpj, isValidCpf } from '../utils/taxId.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { tdb } from '../config/database.js';

/**
 * The "Novo cliente" flow: a CPF/CNPJ first, then the record, then — when the
 * operator asks — the same client created in the SGP.
 *
 * Its own file because it stands between two services that already import
 * each other's side of the story: `waContactService` (the SGP lookup that
 * files what it finds) imports `contactProfileService`, so the profile service
 * cannot import it back.
 */

function invalid(field) {
  return new ContactProfileError('contacts.error.invalidField', { code: 'invalid_field', vars: { field } });
}

// A street that is only its kind: "RUA", "AV.", "TRAVESSA".
const BARE_STREET = /^(rua|r|av|avenida|tv|travessa|alameda|al|pra[cç]a|pc|estrada|rodovia|vila|beco|vi[aá]|sn|s\/n)\.?$/i;

function clean(value, max = 255) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** CPF → PF, CNPJ → PJ, anything else → null. */
export function personTypeOf(document) {
  const digits = String(document ?? '').replace(/\D/g, '');
  if (digits.length === 11 && isValidCpf(digits)) return 'PF';
  if (digits.length === 14 && isValidCnpj(digits)) return 'PJ';
  return null;
}

/** A plan name compared loosely: no accents, no case, single spaces. */
function looseName(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The day a due-day label or value names: "Dia 10" → 10, "10" → 10. */
function dayOf(value) {
  const match = String(value ?? '').match(/\d{1,2}/);
  if (!match) return null;
  const day = Number(match[0]);
  return day >= 1 && day <= 31 ? day : null;
}

/** The login a PPPoE account would get from what the operator typed. */
function loginBase(value) {
  return String(value ?? '').trim().toLowerCase();
}

class ContactOnboardingService {
  /**
   * What the "Cliente com contrato" form picks from: the lists configured in
   * Settings → SGP, and the plan and due day most active contracts already
   * have, so the usual choice is the one pre-selected.
   */
  static async preRegistrationOptions() {
    const config = await SgpService.getConfig();
    const options = {
      ready: SgpService.isReady(config),
      plans: config.preRegPlans,
      dueDays: config.preRegDueDays,
      sellers: config.preRegSellers,
      technicians: config.preRegTechnicians,
      splitters: config.preRegSplitters,
      defaultSellerId: config.preRegVendedorId,
      installOs: config.preRegInstallOs,
      suggestedPlanId: null,
      suggestedDueDayId: null
    };
    if (config.preRegPlans.length === 0 && config.preRegDueDays.length === 0) return options;
    try {
      const rows = await tdb('sgp_contacts')
        .whereNotNull('contract')
        .where({ state: 'active' })
        .select('plan', 'due_day');
      const planIds = new Map(config.preRegPlans.map((plan) => [looseName(plan.name), plan.id]));
      const dayIds = new Map();
      for (const entry of config.preRegDueDays) {
        const day = dayOf(entry.label);
        if (day !== null && !dayIds.has(day)) dayIds.set(day, entry.id);
      }
      const planCount = new Map();
      const dayCount = new Map();
      for (const row of rows) {
        const planId = planIds.get(looseName(row.plan));
        if (planId) planCount.set(planId, (planCount.get(planId) || 0) + 1);
        const dayId = dayIds.get(dayOf(row.due_day));
        if (dayId) dayCount.set(dayId, (dayCount.get(dayId) || 0) + 1);
      }
      const top = (counts) => [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      options.suggestedPlanId = top(planCount);
      options.suggestedDueDayId = top(dayCount);
    } catch (error) {
      console.warn(`Pre-registration suggestion failed: ${error.message}`);
    }
    return options;
  }

  /**
   * Whether a PPPoE login is already someone's — in the SGP contracts the
   * panel synced, or in the panel's own accounts — and, when it is, the first
   * free variation (`maria.souza2`, `maria.souza3`…).
   */
  static async checkLogin(value) {
    const login = loginBase(value);
    if (!login || /\s/.test(login) || login.length > 64) throw invalid('login');
    const base = login.replace(/\d+$/, '') || login;
    const candidates = [login, ...Array.from({ length: 49 }, (_, i) => `${base}${i + 2}`)];
    const [contracts, accounts] = await Promise.all([
      tdb('sgp_contacts').whereNotNull('login').whereRaw('lower(login) like ?', [`${base}%`]).select('login'),
      tdb('customer_accounts').whereNotNull('pppoe_username')
        .whereRaw('lower(pppoe_username) like ?', [`${base}%`]).select('pppoe_username')
    ]);
    const taken = new Set([
      ...contracts.map((row) => loginBase(row.login)),
      ...accounts.map((row) => loginBase(row.pppoe_username))
    ]);
    if (!taken.has(login)) return { login, taken: false, suggestion: null };
    return { login, taken: true, suggestion: candidates.find((candidate) => !taken.has(candidate)) ?? null };
  }

  /**
   * What the panel knows about a document before anything is typed:
   * - `inSgp`: the SGP's clients under it (already filed in the contacts list
   *   by the lookup, so "Abrir ficha" opens them);
   * - `inPanel`: a client typed in the panel before, with no SGP behind it;
   * - `prefill`: for a CNPJ nobody has yet, the Receita's record.
   *
   * A CPF has no public source — the Receita does not open it — so a person
   * not in the SGP is typed by hand.
   */
  static async lookupDocument(document, { fresh = false } = {}) {
    const digits = String(document ?? '').replace(/\D/g, '');
    const personType = personTypeOf(digits);
    if (!personType) {
      throw new ContactProfileError('contacts.error.invalidDocument', { code: 'invalid_document' });
    }

    let inSgp = [];
    let sgpChecked = false;
    if (SgpService.isReady(await SgpService.getConfig())) {
      const found = await WaContactService.lookupSgp(digits);
      inSgp = found.contacts.map((contact) => ({
        key: contact.key,
        name: contact.clientName,
        contract: contact.contract,
        state: contact.state
      }));
      sgpChecked = true;
    }

    const local = await SgpClient.getByDocument(digits);
    let inPanel = null;
    if (local && local.source === 'panel') {
      const row = await SgpContact.getClientRow(local.sgp_client_id);
      if (row) {
        inPanel = { key: `c:${row.id}`, name: local.overrides?.name?.value ?? row.client_name ?? null };
      }
    }

    let prefill = null;
    let prefillError = false;
    let teiahScore = null;
    let teiahConsulted = false;
    let teiahCached = false;
    // The month's TeiaH limit stopped the consultation: the form says so.
    let teiahLimitReached = false;
    let teiahConsultedAt = null;
    let deceased = false;
    const known = inSgp.length > 0 || Boolean(inPanel);

    // O mesmo CPF/CNPJ na conta Asaas do provedor (o que a importação trouxe) e
    // se o painel pode criar o cliente lá: a tela oferece "Cadastrar também no
    // Asaas" só quando pode e quando ainda não existe.
    const asaasConfig = await AsaasProviderService.getConfig();
    const inAsaas = AsaasProviderService.isReady(asaasConfig)
      ? (await AsaasCustomer.listByDocument(digits)).map((row) => ({ asaasId: row.asaas_id, name: row.name }))
      : [];
    const asaasWritable = AsaasProviderService.isReady(asaasConfig) && asaasConfig.allowWriteCustomers;

    // Nobody here knows this document: the TeiaH, when the provider has it,
    // fills the form — a CPF has no other source.
    // Whether the TeiaH is configured: also what shows the address check in the form.
    const teiahReady = TeiahService.isReady(await TeiahService.getConfig());
    if (!known && teiahReady) {
      teiahConsulted = true;
      try {
        // A consultation younger than 30 days is not paid for twice.
        const consulted = await TeiahService.consultCached(digits, { fresh });
        const found = consulted.result;
        teiahCached = consulted.cached;
        teiahConsultedAt = consulted.consultedAt;
        teiahScore = found.score ?? null;
        deceased = found.deceased === true;
        if (found.found) {
          prefill = {
            source: 'teiah',
            name: found.name,
            tradeName: found.tradeName,
            birthDate: found.birthDate,
            email: found.emails?.[0] ?? null,
            phone: found.phones?.[0] ?? null,
            address: found.address ?? {}
          };
        }
      } catch (error) {
        console.warn(`TeiaH document lookup failed: ${error.code || error.message}`);
        prefillError = true;
        if (error?.code === 'teiah_limit_reached') teiahLimitReached = true;
      }
    }

    // A company the TeiaH did not fill: the Receita, as before.
    if (!prefill && personType === 'PJ' && inSgp.length === 0) {
      try {
        const result = await lookupCnpj(digits);
        if (result.found) {
          const data = result.data;
          prefill = {
            source: 'receita',
            name: data.legalName || null,
            tradeName: data.tradeName || null,
            birthDate: null,
            email: data.email || null,
            phone: data.phone || null,
            address: {
              street: data.addressLine || null,
              number: data.addressNumber || null,
              complement: data.addressExtra || null,
              district: data.district || null,
              city: data.city || null,
              state: data.state || null,
              zip: data.postalCode || null
            }
          };
          prefillError = false;
        }
      } catch {
        // The Receita down is a form typed by hand, not a failed lookup.
        prefillError = true;
      }
    }

    // Already in the SGP: what it holds of the client, for "Novo contrato
    // para este cliente" — the record's own values (the operator's edits
    // first), never a paid consultation.
    let existing = null;
    if (inSgp.length > 0) {
      // The record the "Abrir ficha" button opens: the client's values, the
      // operator's edits first; the contract's address when the client's own
      // record has none (many installs only send it per contract).
      const profile = await ContactProfileService.get(inSgp[0].key).catch(() => null);
      const shown = (field) => profile?.fields?.[field]?.value ?? null;
      let address = shown('address') || {};
      if (!address.street && inSgp[0].contract) {
        const row = await SgpContact.getByContract(inSgp[0].contract);
        try {
          address = (typeof row?.address_parts === 'string' ? JSON.parse(row.address_parts) : row?.address_parts) || address;
        } catch {
          // An unreadable address is a form typed by hand.
        }
      }
      existing = {
        source: 'sgp',
        name: shown('name') || inSgp[0].name || null,
        tradeName: null,
        birthDate: shown('birthDate') || null,
        email: shown('emails')?.[0] ?? null,
        phone: shown('phones')?.[0] ?? null,
        address: {
          street: address.street ?? null,
          number: address.number ?? null,
          complement: address.complement ?? null,
          district: address.district ?? null,
          city: address.city ?? null,
          state: address.state ?? null,
          zip: address.zip ?? null,
          reference: address.reference ?? null,
          latitude: address.latitude ?? null,
          longitude: address.longitude ?? null
        }
      };
    }

    // A source that gave a name and no (or half an) address leaves the form
    // with the part the operator least wants to type: complete it.
    if (prefill) prefill.address = await this.completeAddress(prefill.address, { digits, personType, fromReceita: prefill.source === 'receita' });

    return {
      document: digits,
      personType,
      sgpChecked,
      inSgp,
      inPanel,
      inAsaas,
      asaasWritable,
      prefill,
      existing,
      prefillError,
      teiahConsulted,
      teiahReady,
      teiahCached,
      teiahLimitReached,
      teiahConsultedAt,
      teiahScore,
      deceased
    };
  }

  /**
   * Fills what the first source left empty, never what it wrote: the CEP gives
   * street, district, city and state; for a company still without an address,
   * the Receita's record does. Best effort — a lookup that fails leaves the
   * address as it was.
   */
  static async completeAddress(address, { digits, personType, fromReceita }) {
    const result = { ...(address || {}) };
    // The TeiaH sometimes gives only the kind of street ("RUA"): that is no
    // street, and the SGP refuses it. Blank, it is filled from the CEP or typed.
    if (BARE_STREET.test(clean(result.street, 64))) result.street = '';
    const fill = (extra) => {
      for (const [field, value] of Object.entries(extra)) {
        if (value && !result[field]) result[field] = value;
      }
    };
    const incomplete = () => !result.street || !result.district || !result.city || !result.state;

    const zip = String(result.zip ?? '').replace(/\D/g, '');
    if (incomplete() && zip.length === 8) {
      try {
        const found = await lookupCep(zip);
        if (found.found) {
          fill({
            street: found.data.addressLine, district: found.data.district, city: found.data.city, state: found.data.state
          });
        }
      } catch {
        // The CEP services down: the form keeps what it has.
      }
    }

    if (incomplete() && personType === 'PJ' && !fromReceita) {
      try {
        const receita = await lookupCnpj(digits);
        if (receita.found) {
          const data = receita.data;
          fill({
            street: data.addressLine,
            number: data.addressNumber,
            complement: data.addressExtra,
            district: data.district,
            city: data.city,
            state: data.state,
            zip: data.postalCode
          });
        }
      } catch {
        // Same: a hand-typed address, not a failed lookup.
      }
    }
    return result;
  }

  /** The address the TeiaH address check needs: CEP, street and number. */
  static addressForTeiah(body) {
    const address = body?.address ?? body ?? {};
    const cep = String(address.zip ?? address.cep ?? '').replace(/\D/g, '');
    const street = clean(address.street);
    const number = clean(address.number, 20);
    if (cep.length !== 8 || !street || !number || BARE_STREET.test(street)) {
      throw new ContactProfileError('contacts.error.addressIncomplete', { code: 'address_incomplete' });
    }
    return {
      cep,
      street,
      number,
      district: clean(address.district),
      complement: clean(address.complement)
    };
  }

  /**
   * "Consultar endereço na TeiaH" in Novo cliente: whether the installation
   * address has a debt history, before anyone is registered. A paid call,
   * behind the panel's 30-day memory of the same CEP and number.
   */
  static async lookupAddressTeiah(body, { override = false } = {}) {
    const address = this.addressForTeiah(body);
    TeiahService.requireReady(await TeiahService.getConfig());
    return TeiahService.consultAddressCached(address, { fresh: body?.fresh === true, override });
  }

  /** The TeiaH's report PDF of that address check, from its history: no new paid call. */
  static async addressTeiahReport(query, mode) {
    const cep = String(query?.cep ?? '').replace(/\D/g, '');
    const number = clean(query?.number ?? query?.numero, 20);
    if (cep.length !== 8 || !number) {
      throw new ContactProfileError('contacts.error.addressIncomplete', { code: 'address_incomplete' });
    }
    TeiahService.requireReady(await TeiahService.getConfig());
    const found = await TeiahService.findPrintableAddressConsultation(cep, number);
    if (!found) throw new TeiahError('teiah.error.reportNone', { code: 'teiah_report_none', status: 404 });
    const pdf = await TeiahService.consultationPdf(found.id, mode);
    return { pdf, consultationId: found.id, cep };
  }

  static async lookupCep(cep) {
    const digits = String(cep ?? '').replace(/\D/g, '');
    if (digits.length !== 8) {
      throw new ContactProfileError('contacts.error.invalidCep', { code: 'invalid_cep' });
    }
    return lookupCep(digits);
  }

  /**
   * Creates the client in the SGP, then files it here under the SGP's own id,
   * so the next contacts sync finds the same record instead of a second one.
   *
   * The SGP is asked first whether the document is already there: a second
   * client with the same CPF is the one mistake this button must not make.
   */
  /**
   * The client fields both SGP calls need, checked here in the operator's
   * language instead of refused by the SGP in its own — and the SGP asked
   * first whether the document is already there: a second client with the
   * same CPF is the one mistake these buttons must not make.
   */
  static async prepareSgpClient(body, { newContract = false } = {}) {
    const input = body && typeof body === 'object' ? body : {};
    const document = String(input.document ?? '').replace(/\D/g, '');
    const personType = personTypeOf(document);
    if (!personType) {
      throw new ContactProfileError('contacts.error.invalidDocument', { code: 'invalid_document' });
    }
    const name = clean(input.name);
    if (!name) throw invalid('name');

    const address = input.address && typeof input.address === 'object' ? input.address : {};
    const zip = String(address.zip ?? '').replace(/\D/g, '');
    const state = clean(address.state, 2).toUpperCase();
    if (!clean(address.street)) throw invalid('street');
    if (!clean(address.district)) throw invalid('district');
    if (!clean(address.city)) throw invalid('city');
    if (zip.length !== 8) throw invalid('zip');
    if (!/^[A-Z]{2}$/.test(state)) throw invalid('state');

    const phone = input.whatsappPhone ? normalizarTelefoneBr(input.whatsappPhone) : null;
    if (input.whatsappPhone && !phone) throw invalid('whatsappPhone');
    const email = clean(input.email).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw invalid('email');

    const config = SgpService.requireReady(await SgpService.getConfig());
    const existing = await WaContactService.lookupSgp(document);
    // A new contract is for a client the SGP already has; anything else must
    // not be there yet, or it would be filed twice.
    if (newContract && existing.total === 0) {
      throw new ContactProfileError('contacts.error.notInSgp', { code: 'not_in_sgp', status: 400 });
    }
    if (!newContract && existing.total > 0) {
      throw new ContactProfileError('contacts.error.alreadyInSgp', {
        code: 'already_in_sgp',
        status: 409,
        vars: { name: existing.contacts[0].clientName || document }
      });
    }

    const cleanAddress = {
      street: clean(address.street),
      number: clean(address.number, 32),
      complement: clean(address.complement),
      district: clean(address.district),
      city: clean(address.city),
      state,
      zip,
      reference: clean(address.reference)
    };
    return { input, config, document, personType, name, phone, email, address, cleanAddress, existing };
  }

  /** Files the client just created in the SGP here, under the SGP's own id. */
  static async fileSgpClient({ clientId, document, personType, name, birthDate, cleanAddress, phone, email }) {
    const record = Object.fromEntries(Object.entries(cleanAddress).filter(([, value]) => value));
    await SgpClient.upsertFromSgp({
      clientId,
      document,
      personType,
      name,
      birthDate: birthDate || null,
      address: record,
      phones: phone ? [phone] : [],
      emails: email ? [email] : []
    });
    const row = await SgpContact.upsertFromSgp(SgpService.contractToContactRow({
      contract: null, clientId, document, name, phone
    }));
    if (!row) {
      throw new SgpError('sgp.error.clientCreateFailed', { code: 'client_create_failed', status: 502 });
    }
    return row;
  }

  /**
   * Creates the client in the SGP, then files it here under the SGP's own id,
   * so the next contacts sync finds the same record instead of a second one.
   */
  static async createInSgp(body) {
    const {
      input, document, personType, name, phone, email, address, cleanAddress
    } = await this.prepareSgpClient(body);
    const created = await SgpService.createClient({
      personType,
      document,
      name,
      tradeName: clean(input.tradeName),
      responsibleName: clean(input.responsibleName),
      responsibleDocument: input.responsibleDocument,
      email,
      phone,
      birthDate: clean(input.birthDate, 32),
      notes: clean(input.notes, 2000),
      address: { ...cleanAddress, latitude: address.latitude, longitude: address.longitude }
    });

    const row = await this.fileSgpClient({
      clientId: created.clientId, document, personType, name,
      birthDate: clean(input.birthDate, 32), cleanAddress, phone, email
    });
    const profile = await ContactProfileService.get(`c:${row.id}`);
    return { profile, clientId: created.clientId, message: created.message };
  }

  /**
   * The client WITH a contract, through the SGP's pre-registration: plan and
   * due day picked from the lists the admin keeps in Settings → SGP, POP,
   * carrier and seller from the same place, and the PPPoE login typed here.
   *
   * The pre-registration's answer is not documented. When the SGP names the
   * client, the client is filed here under that id, like `createInSgp`; when
   * it does not (a pre-registration not converted yet), the SGP is asked by
   * document, and failing that the client is kept here with a note — the next
   * contacts sync joins it to what the SGP made of it.
   */
  static async createPreRegistration(body) {
    const newContract = body?.newContract === true;
    const prepared = await this.prepareSgpClient(body, { newContract });
    const {
      input, config, document, personType, name, phone, email, address, cleanAddress, existing
    } = prepared;

    const planId = Number.parseInt(String(input.planId ?? ''), 10);
    if (!config.preRegPlans.some((plan) => plan.id === planId)) throw invalid('planId');
    const dueDayId = Number.parseInt(String(input.dueDayId ?? ''), 10);
    if (!config.preRegDueDays.some((day) => day.id === dueDayId)) throw invalid('dueDayId');
    const login = clean(input.login, 64);
    if (login && /\s/.test(login)) throw invalid('login');
    // Picked from a list when the list exists; an id nobody listed is refused.
    const listed = (value, list, field) => {
      if (value === undefined || value === null || value === '') return null;
      const id = Number.parseInt(String(value), 10);
      if (!Number.isInteger(id) || id <= 0) throw invalid(field);
      if (list.length > 0 && !list.some((entry) => entry.id === id)) throw invalid(field);
      return id;
    };
    const sellerId = listed(input.sellerId, config.preRegSellers, 'sellerId') ?? config.preRegVendedorId;
    const technicianId = listed(input.technicianId, config.preRegTechnicians, 'technicianId');
    const splitterId = listed(input.splitterId, config.preRegSplitters, 'splitterId');
    let splitterPort = null;
    if (splitterId && input.splitterPort !== undefined && input.splitterPort !== null && input.splitterPort !== '') {
      const splitter = config.preRegSplitters.find((entry) => entry.id === splitterId);
      splitterPort = Number.parseInt(String(input.splitterPort), 10);
      if (!Number.isInteger(splitterPort) || splitterPort < 1 || splitterPort > (splitter?.ports ?? 128)) {
        throw invalid('splitterPort');
      }
    }
    if (login) {
      // Checked again here: two operators may type the same login at once.
      const check = await this.checkLogin(login);
      if (check.taken) {
        throw new ContactProfileError('contacts.error.loginTaken', {
          code: 'login_taken',
          status: 409,
          vars: { suggestion: check.suggestion || '' }
        });
      }
    }
    const password = String(input.password ?? '').trim().slice(0, 64);

    const sent = await SgpService.createPreRegistration({
      personType,
      document,
      name,
      email,
      phone,
      birthDate: clean(input.birthDate, 32),
      notes: clean(input.notes, 2000),
      serviceDescription: clean(input.serviceDescription, 500),
      address: { ...cleanAddress, latitude: address.latitude, longitude: address.longitude },
      planId,
      dueDayId,
      popId: config.preRegPopId,
      portadorId: config.preRegPortadorId,
      vendedorId: sellerId,
      technicianId,
      splitterId,
      splitterPort,
      login,
      password,
      installOs: input.installOs === undefined ? config.preRegInstallOs : input.installOs === true,
      activate: config.preRegActivate
    });

    if (newContract) {
      // The client is already filed: what the SGP holds now (its new contract
      // among the rest) is asked again, and the record opened is the client's
      // own — the address typed for this contract does not overwrite it.
      let key = existing.contacts[0]?.key ?? null;
      try {
        const found = await WaContactService.lookupSgp(document);
        key = found.contacts[0]?.key ?? key;
      } catch (error) {
        console.warn(`SGP lookup after new contract failed: ${error.code || error.message}`);
      }
      return { profile: await ContactProfileService.get(key), sent, filed: 'sgp', newContract: true };
    }

    let row = null;
    if (sent.clientId) {
      row = await this.fileSgpClient({
        clientId: sent.clientId, document, personType, name,
        birthDate: clean(input.birthDate, 32), cleanAddress, phone, email
      });
    } else {
      // Not named: what the SGP holds under the document now, if anything.
      try {
        const found = await WaContactService.lookupSgp(document);
        const key = found.contacts[0]?.key;
        if (key) {
          return { profile: await ContactProfileService.get(key), sent, filed: 'sgp' };
        }
      } catch (error) {
        console.warn(`SGP lookup after pre-registration failed: ${error.code || error.message}`);
      }
    }
    if (row) {
      return { profile: await ContactProfileService.get(`c:${row.id}`), sent, filed: 'sgp' };
    }

    // Kept here until the sync brings the SGP's record: the operator's work
    // is not lost because the SGP answered without an id.
    const plan = config.preRegPlans.find((entry) => entry.id === planId);
    const profile = await ContactProfileService.create({
      name,
      document,
      personType,
      ...(email ? { emails: [email] } : {}),
      ...(phone ? { whatsappPhone: phone } : {}),
      birthDate: clean(input.birthDate, 32) || undefined,
      address: Object.fromEntries(Object.entries(cleanAddress).filter(([, value]) => value)),
      notes: `Pré-cadastro enviado ao SGP em ${new Date().toISOString().slice(0, 10)}`
        + `${plan ? ` — plano ${plan.name}` : ''}${sent.preRegistrationId ? ` (#${sent.preRegistrationId})` : ''}.`
    }, null);
    return { profile, sent, filed: 'panel' };
  }
}

export default ContactOnboardingService;
