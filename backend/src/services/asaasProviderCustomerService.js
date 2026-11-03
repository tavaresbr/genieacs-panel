import AsaasCustomer from '../models/AsaasCustomer.js';
import AsaasProviderService, { AsaasProviderError } from './asaasProviderService.js';
import ContactProfileService, { ContactProfileError } from './contactProfileService.js';
import { personTypeOf } from './contactOnboardingService.js';
import { createCustomer, findCustomersByDocument, AsaasError } from './billing/asaasClient.js';
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
      externalReference: `painel:${key}`.slice(0, 100)
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
      canCreate: ready && config.allowWriteCustomers && Boolean(personTypeOf(digits)) && !customer
    };
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
