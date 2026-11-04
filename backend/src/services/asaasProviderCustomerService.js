import AsaasCustomer from '../models/AsaasCustomer.js';
import AsaasProviderService, { AsaasProviderError } from './asaasProviderService.js';
import ContactProfileService, { ContactProfileError } from './contactProfileService.js';
import { personTypeOf } from './contactOnboardingService.js';
import AsaasCharge, { OPEN_STATUSES } from '../models/AsaasCharge.js';
import AsaasInvoiceService from './asaasInvoiceService.js';
import {
  createCustomer, findCustomersByDocument, getCustomer, listCustomerCharges, createCustomerCharge, AsaasError
} from './billing/asaasClient.js';
import crypto from 'node:crypto';
import { normalizeTaxId } from '../utils/taxId.js';

/**
 * O cliente do painel criado na conta Asaas DO PROVEDOR — a única escrita da
 * integração até aqui.
 *
 * ## Por que existe como segundo passo, e não dentro do cadastro
 *
 * O cadastro (painel ou SGP) acontece primeiro e é o que não pode se perder. O
 * Asaas vem depois, sobre o contato que já existe: se ele falha — chave
 * recusada, CPF que o Asaas não aceita, gateway fora do ar —, o contato está
 * salvo e a ficha oferece "Criar no Asaas" para tentar de novo. Um cadastro
 * que só vale se os dois sistemas aceitarem faria o operador digitar tudo
 * outra vez por causa do sistema que não é o dele.
 *
 * ## Nunca dois clientes com o mesmo documento
 *
 * Antes de criar, procura-se o CPF/CNPJ no banco (o que a importação trouxe) e
 * no próprio Asaas (o cadastro pode ser de depois da última importação). Se
 * já existe, o painel só o liga — não cria um segundo.
 */
/** O mínimo do boleto no Asaas é R$ 5,00; o teto é só um freio contra dedo a mais. */
const MIN_CHARGE_CENTS = 500;
const MAX_CHARGE_CENTS = 10_000_000;

/** Hoje no Brasil, onde o Asaas conta o vencimento. */
function todayBr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/** `AAAA-MM-DD`, um dia de verdade, de hoje em diante e a até dois anos. */
function validFutureDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCDate() !== Number(m[3]) || d.getUTCMonth() !== Number(m[2]) - 1) return false;
  const hoje = todayBr();
  const limite = new Date(`${hoje}T00:00:00Z`);
  limite.setUTCFullYear(limite.getUTCFullYear() + 2);
  return value >= hoje && value <= limite.toISOString().slice(0, 10);
}

class AsaasProviderCustomerService {
  /** A credencial de saída. Um ponto só, para o teste apontar o gateway de mentira. */
  static credentialFor(config) {
    return AsaasProviderService.credentialOf(config);
  }

  /** Dígitos de um telefone sem o DDI do Brasil: é como o Asaas guarda. */
  static nationalPhone(phone) {
    const digits = String(phone ?? '').replace(/\D/g, '');
    return digits.startsWith('55') && (digits.length === 12 || digits.length === 13) ? digits.slice(2) : digits;
  }

  /** O corpo de `POST /customers` a partir da ficha do painel. */
  static payloadFrom(profile, key) {
    const address = profile.fields.address?.value ?? {};
    const phone = this.nationalPhone(profile.whatsappPhone || profile.fields.phones?.value?.[0]);
    const zip = String(address.zip ?? '').replace(/\D/g, '');
    const payload = {
      name: profile.fields.name.value,
      cpfCnpj: normalizeTaxId(profile.fields.document.value),
      // Referência para achar o cliente do painel a partir do Asaas.
      externalReference: `painel:${key}`.slice(0, 100),
      // Sem e-mail nem SMS do Asaas ao cliente: a cobrança do assinante é do
      // provedor (WhatsApp, SGP), e duplicá-la pelo Asaas é o que se evita. Vale
      // só para o cliente CRIADO aqui; o que já existia no Asaas não é alterado.
      notificationDisabled: true
    };
    const email = profile.fields.emails?.value?.[0];
    if (email) payload.email = email;
    if (phone) payload.mobilePhone = phone;
    if (zip.length === 8) payload.postalCode = zip;
    if (address.street) payload.address = address.street;
    if (address.number) payload.addressNumber = address.number;
    if (address.complement) payload.complement = address.complement;
    if (address.district) payload.province = address.district;
    return payload;
  }

  /** O que a ficha precisa saber: o cliente ligado, e se "Criar no Asaas" pode aparecer. */
  static async statusFor(document) {
    const config = await AsaasProviderService.getConfig();
    const ready = AsaasProviderService.isReady(config);
    const digits = normalizeTaxId(document);
    const customer = ready && digits ? (await AsaasCustomer.listByDocument(digits))[0] ?? null : null;
    return {
      connected: ready,
      customer: customer ? { asaasId: customer.asaas_id, name: customer.name } : null,
      canCreate: ready && config.allowWriteCustomers && Boolean(personTypeOf(digits)) && !customer,
      // "Gerar nova cobrança": o cliente já está no Asaas e o provedor liberou a escrita de cobranças.
      canCharge: ready && config.allowWriteCharges === true && Boolean(customer)
    };
  }


  /**
   * O cliente do Asaas LIGADO a este contato, ou o erro certo.
   *
   * O contato vem primeiro (chave de outro provedor é 404 antes de qualquer
   * outra coisa, inclusive antes de dizer se a integração está ligada), depois a
   * integração, depois o vínculo pelo CPF/CNPJ.
   */
  static async requireLinked(key) {
    const profile = await ContactProfileService.get(key);
    if (!profile) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    const config = await AsaasProviderService.getConfig();
    if (!AsaasProviderService.isReady(config)) {
      throw new AsaasProviderError('asaas.error.notConfigured', { code: 'not_configured', status: 409 });
    }
    const document = normalizeTaxId(profile.fields.document?.value);
    const customer = document ? (await AsaasCustomer.listByDocument(document))[0] : null;
    if (!customer) {
      throw new AsaasProviderError('asaas.error.customerNotLinked', { code: 'customer_not_linked', status: 409 });
    }
    return { profile, config, document, customer };
  }

  /**
   * A cobrança como a tela a mostra. Aceita as duas formas que circulam aqui: a
   * LINHA do banco (`value_cents`, `due_date`…) e a cobrança já lida do Asaas
   * (`valueCents`, `dueDate`…).
   */
  static chargeView(charge) {
    const cents = charge.value_cents ?? charge.valueCents;
    const status = charge.status ?? null;
    return {
      id: charge.asaas_id ?? charge.id,
      amount: cents === null || cents === undefined ? null : Number(cents) / 100,
      dueDate: charge.due_date ?? charge.dueDate ?? null,
      paymentDate: charge.payment_date ?? charge.paymentDate ?? null,
      status,
      billingType: charge.billing_type ?? charge.billingType ?? null,
      link: charge.invoice_url ?? charge.invoiceUrl ?? charge.bank_slip_url ?? charge.bankSlipUrl ?? null,
      open: OPEN_STATUSES.includes(status) && !charge.deleted
    };
  }

  /**
   * Relê AGORA, no Asaas, o cadastro deste cliente e as cobranças dele, guarda a
   * cópia no painel e devolve a lista — as em aberto primeiro (a mais antiga no
   * topo), depois as demais, da mais recente.
   *
   * É a ação de "Consultar boletos" e de "Atualizar do Asaas": só lê do Asaas e
   * só escreve no banco do painel. A importação inteira continua sendo a rotina
   * de fundo; esta é a do cliente que está na tela.
   */
  static async refresh(key) {
    const { document, customer, config } = await this.requireLinked(key);
    const credential = this.credentialFor(config);
    try {
      const live = await getCustomer(customer.asaas_id, credential);
      await AsaasCustomer.upsertFromAsaas(live, { seenAt: new Date() });
      const charges = await listCustomerCharges(customer.asaas_id, { limit: 30 }, credential);
      for (const charge of charges) {
        // eslint-disable-next-line no-await-in-loop -- poucas cobranças por cliente
        await AsaasCharge.upsertFromAsaas(charge, { document: live.document ? normalizeTaxId(live.document) : document, seenAt: new Date() });
      }
      const views = charges.map((charge) => this.chargeView(charge));
      const open = views.filter((v) => v.open).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
      const rest = views.filter((v) => !v.open).sort((a, b) => String(b.dueDate).localeCompare(String(a.dueDate)));
      return {
        customer: { asaasId: live.id, name: live.name },
        charges: [...open, ...rest],
        refreshedAt: new Date().toISOString()
      };
    } catch (error) {
      if (error instanceof AsaasError) throw AsaasProviderService.translateGatewayError(error);
      throw error;
    }
  }

  /**
   * O Pix e a linha digitável de uma cobrança em aberto DESTE cliente, lidos do
   * Asaas na hora. A cobrança é conferida contra o CPF/CNPJ do contato — um id de
   * outro cliente (ou de outro provedor) é "não encontrada".
   */
  static async codes(key, chargeId) {
    const { document } = await this.requireLinked(key);
    const row = await AsaasCharge.getByAsaasId(chargeId);
    if (!row || row.deleted || row.document !== document) {
      throw new ContactProfileError('contacts.error.invoiceNotFound', { code: 'invoice_not_found', status: 404 });
    }
    const ready = await AsaasInvoiceService.completeForBot(AsaasInvoiceService.toInvoice(row));
    if (!ready) throw new AsaasProviderError('asaas.error.chargeClosed', { code: 'charge_closed', status: 409 });
    return { digitableLine: ready.digitableLine, pix: ready.pix, link: ready.link };
  }

  /**
   * Cria uma cobrança avulsa para o cliente do contato — a segunda escrita na
   * conta do provedor, e a que mexe com dinheiro. Opção própria (desligada),
   * `asaas.act`, valor mínimo do boleto e vencimento que não seja passado.
   */
  static async createCharge(key, input = {}) {
    const { document, customer, config } = await this.requireLinked(key);
    if (!config.allowWriteCharges) {
      throw new AsaasProviderError('asaas.error.chargeWriteDisabled', { code: 'write_disabled', status: 409 });
    }
    const valueCents = Math.round(Number(input.value) * 100);
    if (!Number.isFinite(valueCents) || valueCents < MIN_CHARGE_CENTS || valueCents > MAX_CHARGE_CENTS) {
      throw new AsaasProviderError('asaas.error.chargeValueInvalid', { code: 'invalid_value' });
    }
    const dueDate = String(input.dueDate ?? '').trim();
    if (!validFutureDate(dueDate)) {
      throw new AsaasProviderError('asaas.error.chargeDueInvalid', { code: 'invalid_due_date' });
    }
    const billingType = String(input.billingType ?? 'UNDEFINED').toUpperCase();
    if (!['BOLETO', 'PIX', 'UNDEFINED'].includes(billingType)) {
      throw new AsaasProviderError('asaas.error.chargeTypeInvalid', { code: 'invalid_billing_type' });
    }
    const description = String(input.description ?? '').trim().slice(0, 500);

    try {
      const created = await createCustomerCharge({
        customerId: customer.asaas_id,
        billingType,
        valueCents,
        dueDate,
        description,
        // Única por pedido: a mesma referência nunca é de duas cobranças.
        externalReference: `painel:${key}:${crypto.randomBytes(4).toString('hex')}`.slice(0, 100)
      }, this.credentialFor(config));
      await AsaasCharge.upsertFromAsaas(created, { document, seenAt: new Date() });
      return { charge: this.chargeView(created) };
    } catch (error) {
      if (error instanceof AsaasError) throw AsaasProviderService.translateGatewayError(error);
      throw error;
    }
  }

  /**
   * Cria (ou liga) o cliente do contato `key` no Asaas.
   *
   * @returns {Promise<{ created: boolean, customer: { asaasId: string, name: string|null } }>}
   *   `created: false` quando o cliente já existia e só foi ligado.
   */
  static async createFromContact(key) {
    // O contato primeiro: uma chave que não é deste provedor é 404 antes de
    // qualquer coisa — inclusive antes de dizer se a integração está ligada.
    const profile = await ContactProfileService.get(key);
    if (!profile) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });

    const config = await AsaasProviderService.getConfig();
    if (!AsaasProviderService.isReady(config)) {
      throw new AsaasProviderError('asaas.error.notConfigured', { code: 'not_configured', status: 409 });
    }
    if (!config.allowWriteCustomers) {
      throw new AsaasProviderError('asaas.error.writeDisabled', { code: 'write_disabled', status: 409 });
    }

    const document = normalizeTaxId(profile.fields.document?.value);
    if (!personTypeOf(document)) {
      throw new AsaasProviderError('asaas.error.documentRequired', { code: 'document_required' });
    }
    if (!profile.fields.name?.value) {
      throw new AsaasProviderError('asaas.error.nameRequired', { code: 'name_required' });
    }

    // 1. Já importado: só liga.
    const local = (await AsaasCustomer.listByDocument(document))[0];
    if (local) return { created: false, customer: { asaasId: local.asaas_id, name: local.name } };

    const credential = this.credentialFor(config);
    try {
      // 2. Existe no Asaas e a importação ainda não viu: guarda e liga.
      const remote = (await findCustomersByDocument(document, credential))[0];
      if (remote) {
        await AsaasCustomer.upsertFromAsaas(remote, { seenAt: new Date() });
        return { created: false, customer: { asaasId: remote.id, name: remote.name } };
      }
      // 3. Não existe: cria, e guarda o que o Asaas devolveu.
      const { customer } = await createCustomer(this.payloadFrom(profile, key), credential);
      await AsaasCustomer.upsertFromAsaas(customer, { seenAt: new Date() });
      return { created: true, customer: { asaasId: customer.id, name: customer.name } };
    } catch (error) {
      if (error instanceof AsaasError) throw AsaasProviderService.translateGatewayError(error);
      throw error;
    }
  }
}

export default AsaasProviderCustomerService;
