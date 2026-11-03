import AsaasCustomer from '../models/AsaasCustomer.js';
import AsaasCharge from '../models/AsaasCharge.js';
import AsaasInvoiceService from './asaasInvoiceService.js';
import { tdb } from '../config/database.js';

/**
 * O cliente que só existe no Asaas, como assinante da régua de cobrança e das
 * campanhas.
 *
 * ## O contrato sintético
 *
 * A régua e as campanhas gravam o assinante por CONTRATO — `wa_dunning_sends`,
 * `wa_dunning_pauses`, `wa_broadcast_recipients` —, sempre como texto. O Asaas
 * não tem contrato; em vez de uma coluna de origem em cada uma dessas tabelas
 * (e nas chaves únicas e no dossiê do titular), o cliente só-Asaas ganha a
 * chave `asaas:<cus_id>`, que cabe onde um contrato cabe. O que muda é de onde
 * vêm os assinantes e as faturas; nada no banco.
 *
 * O preço dessa economia é que o contrato sintético NÃO é contrato do SGP, e
 * qualquer lugar que o leve ao SGP quebra. Por isso quem consulta o SGP por
 * contrato (`pacedInvoices`, `detectPayments`) e quem prende a conversa a um
 * contrato (a régua e a campanha) pergunta `isAsaasContract` antes.
 *
 * ## Quem é "só-Asaas"
 *
 * Um cliente do Asaas com cobrança em aberto cujo CPF/CNPJ NÃO é de ninguém com
 * contrato no SGP. Quem tem contrato NÃO vira assinante à parte: as faturas dele
 * do Asaas são somadas às do SGP (`mergeOpenInvoices`), e o assinante é um só —
 * senão a mesma pessoa receberia duas cobranças pela mesma dívida.
 */
export const ASAAS_CONTRACT_PREFIX = 'asaas:';

export function isAsaasContract(contract) {
  return String(contract ?? '').startsWith(ASAAS_CONTRACT_PREFIX);
}

export function asaasContractOf(asaasId) {
  return `${ASAAS_CONTRACT_PREFIX}${asaasId}`;
}

export function asaasIdOf(contract) {
  return isAsaasContract(contract) ? String(contract).slice(ASAAS_CONTRACT_PREFIX.length) : null;
}

const CHUNK = 200;

/** A mais antiga das faturas em aberto — a que a régua e a campanha vão escolher. */
function maisAntiga(invoices) {
  return invoices
    .filter((f) => f && !f.paid && f.dueDate)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0] || null;
}

class AsaasBillingSource {
  /** Cobrar o Asaas está ligado e a integração pronta. */
  static enabled() {
    return AsaasInvoiceService.billingEnabled();
  }

  /** Os CPF/CNPJ (de `documents`) que são de alguém com contrato no SGP. */
  static async documentsWithSgpContract(documents) {
    const matched = new Set();
    for (let i = 0; i < documents.length; i += CHUNK) {
      const chunk = documents.slice(i, i + CHUNK);
      // eslint-disable-next-line no-await-in-loop -- poucos blocos
      const contacts = await tdb('sgp_contacts').whereNotNull('contract').whereIn('document', chunk).distinct('document');
      // eslint-disable-next-line no-await-in-loop -- idem
      const links = await tdb('sgp_links').whereIn('document', chunk).distinct('document');
      for (const row of [...contacts, ...links]) if (row.document) matched.add(String(row.document));
    }
    return matched;
  }

  /**
   * Os assinantes só-Asaas, no formato de `WaBillingService.subscribers()`.
   *
   * `contracts` restringe aos pedidos (a campanha já escolheu); sem ele, todos
   * os que têm cobrança em aberto — um cliente sem nada em aberto não tem o que
   * cobrar, e listá-lo só pesaria a passada.
   */
  static async subscribers({ contracts } = {}) {
    if (!(await this.enabled())) return [];

    let ids;
    if (Array.isArray(contracts)) {
      ids = contracts.filter(isAsaasContract).map(asaasIdOf).filter(Boolean);
    } else {
      ids = await AsaasCharge.openCustomerIds();
      // Quem já foi cobrado e ainda não foi dado como pago TEM que continuar na
      // lista mesmo sem fatura aberta: é a passada sobre ele que percebe o
      // pagamento, retira a mensagem da fila e libera o agradecimento. Sem isto,
      // quem paga some da régua antes de ela saber que pagou.
      const cobrados = await tdb('wa_dunning_sends')
        .where({ kind: 'step', status: 'queued' })
        .whereNull('paid_at')
        .where('contract', 'like', `${ASAAS_CONTRACT_PREFIX}%`)
        .distinct('contract');
      ids = [...ids, ...cobrados.map((row) => asaasIdOf(row.contract)).filter(Boolean)];
    }
    ids = [...new Set(ids)];
    if (ids.length === 0) return [];

    const customers = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      // eslint-disable-next-line no-await-in-loop -- poucos blocos
      customers.push(...await tdb('asaas_customers').whereIn('asaas_id', ids.slice(i, i + CHUNK)).where({ deleted: false }).orderBy('id'));
    }

    const matched = await this.documentsWithSgpContract(customers.map((c) => c.document).filter(Boolean));
    const seen = new Set();
    const result = [];
    for (const customer of customers) {
      if (customer.document && matched.has(String(customer.document))) continue;
      // Dois cadastros do mesmo CPF no Asaas são UMA pessoa: um assinante só.
      if (customer.document) {
        if (seen.has(customer.document)) continue;
        seen.add(customer.document);
      }
      result.push({
        contract: asaasContractOf(customer.asaas_id),
        clientName: customer.name || null,
        document: customer.document || null,
        deviceId: null,
        phone: customer.phone_e164 || null,
        phoneSource: null
      });
    }
    return result;
  }

  /** As faturas em aberto de um contrato sintético: lê o banco, sem ir ao gateway. */
  static async invoicesOf(contract) {
    const customer = await AsaasCustomer.getByAsaasId(asaasIdOf(contract));
    if (!customer || customer.deleted) return [];
    const charges = customer.document
      ? await AsaasCharge.listOpenByDocument(customer.document)
      : await AsaasCharge.listOpenByCustomer(customer.asaas_id);
    return charges.map((charge) => AsaasInvoiceService.toInvoice(charge));
  }

  /**
   * Completa a fatura que será escolhida — e só ela — com o Pix e a linha
   * digitável de agora, lidos do gateway.
   *
   * A régua e a campanha sempre escolhem a MAIS ANTIGA em aberto (a vencida mais
   * velha, ou, num lembrete, a mais próxima), então completar só essa é exato e
   * custa de 1 a 3 idas ao gateway por assinante em vez de três por fatura. Uma
   * fatura que o gateway diz já paga sai da lista e a seguinte é a escolhida.
   * Só toca em faturas do Asaas: as do SGP passam como vieram.
   */
  static async completeOldest(invoices) {
    let restantes = [...invoices];
    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      const alvo = maisAntiga(restantes);
      if (!alvo || alvo.source !== 'asaas') return restantes;
      // eslint-disable-next-line no-await-in-loop -- uma por vez: a próxima só se pede se esta já estava paga
      const pronta = await AsaasInvoiceService.completeForBot(alvo);
      if (pronta) return restantes.map((f) => (f === alvo ? pronta : f));
      restantes = restantes.filter((f) => f !== alvo);
    }
    return restantes;
  }
}

export default AsaasBillingSource;
