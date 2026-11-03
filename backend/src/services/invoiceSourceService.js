import SgpContact from '../models/SgpContact.js';
import SgpLink from '../models/SgpLink.js';
import AsaasInvoiceService from './asaasInvoiceService.js';
import { normalizeTaxId } from '../utils/taxId.js';

/**
 * Junta as faturas em aberto de um assinante que moram em mais de um sistema:
 * o SGP (o cadastro de contratos) e a conta Asaas do provedor.
 *
 * ## "A mesma dívida" nas duas fontes
 *
 * Muito provedor emite o boleto do SGP PELO Asaas: aí a fatura existe nos dois
 * lados, com o mesmo valor e o mesmo vencimento, e mostrar as duas ao assinante
 * é cobrar duas vezes na cabeça dele. Uma fatura do Asaas que bate com uma do
 * SGP em vencimento e valor é tratada como a mesma e some; a do SGP é a que
 * fica, porque o SGP é o sistema do contrato e o que o painel sempre mostrou.
 * Quando o valor ou o vencimento diferem, são dívidas diferentes e as duas
 * aparecem.
 */
export function mergeOpenInvoices(sgpInvoices, asaasInvoices) {
  const sgp = (sgpInvoices || []).filter(Boolean);
  const cents = (value) => (value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Math.round(Number(value) * 100));
  const day = (value) => String(value ?? '').slice(0, 10);
  const same = (a, b) => Boolean(day(a.dueDate)) && day(a.dueDate) === day(b.dueDate)
    && cents(a.amount) !== null && cents(a.amount) === cents(b.amount);

  const extras = (asaasInvoices || []).filter(Boolean)
    .filter((invoice) => !sgp.some((existing) => !existing.paid && same(existing, invoice)));
  return [...sgp, ...extras];
}

class InvoiceSourceService {
  /** O CPF/CNPJ (só dígitos) do contrato, pelo que o painel já sabe dele. */
  static async documentOfContract(contract) {
    const contact = await SgpContact.getByContract(contract);
    if (contact?.document) return normalizeTaxId(contact.document) || null;
    // `getByContract` devolve a LISTA de vínculos do contrato (uma linha por ONT).
    const links = await SgpLink.getByContract(contract);
    const link = (links || []).find((entry) => entry?.document);
    return link ? (normalizeTaxId(link.document) || null) : null;
  }

  /**
   * As faturas em aberto da conta Asaas deste contrato, ou `[]`: integração
   * desligada, bot sem permissão para consultá-la, contrato sem CPF/CNPJ ou
   * qualquer falha. O Asaas é um complemento do SGP aqui — o SGP fora do ar já
   * leva o bot a um atendente, e o Asaas fora do ar não pode fazer o mesmo com
   * quem tem a fatura no SGP.
   */
  static async asaasInvoicesForContract(contract, { gate = 'bot' } = {}) {
    try {
      const allowed = gate === 'billing' ? await AsaasInvoiceService.billingEnabled() : await AsaasInvoiceService.botEnabled();
      if (!allowed) return [];
      const document = await this.documentOfContract(contract);
      return document ? await AsaasInvoiceService.openByDocument(document) : [];
    } catch (error) {
      console.warn('invoiceSource asaas:', error?.message || error);
      return [];
    }
  }
}

export default InvoiceSourceService;
