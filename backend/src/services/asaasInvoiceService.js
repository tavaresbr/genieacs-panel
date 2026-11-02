import AsaasCharge, { OPEN_STATUSES } from '../models/AsaasCharge.js';
import AsaasProviderService from './asaasProviderService.js';
import { AsaasError, getCharge, getIdentificationField, getPixQrCode } from './billing/asaasClient.js';

/**
 * As faturas da conta Asaas do provedor, no formato das faturas do SGP.
 *
 * O resto do painel (o bot, a ficha, a régua) já sabe ler uma fatura do SGP:
 * `{ id, amount, dueDate, paid, link, digitableLine, pix }`. Aqui a cobrança do
 * Asaas é traduzida para esse formato, com `source: 'asaas'`, e quem lê não
 * precisa saber de onde ela veio.
 *
 * ## A linha digitável e o Pix não vêm do banco
 *
 * A importação NÃO os guarda: mudam, expiram e o boleto pode ser reemitido.
 * Quem vai MOSTRAR a fatura a um assinante (`completeForBot`) pede os dois ao
 * Asaas na hora — e antes disso lê a cobrança de novo, porque a linha do
 * banco é de até um dia atrás e mandar o código de uma fatura que o assinante
 * já pagou é pior que não mandar nada.
 */
class AsaasInvoiceService {
  /** A credencial de saída. Um ponto só, para o teste apontar o gateway de mentira. */
  static credentialFor(config) {
    return AsaasProviderService.credentialOf(config);
  }

  /** A cobrança importada no formato da fatura do SGP. */
  static toInvoice(charge) {
    return {
      id: charge.asaas_id,
      sgpId: null,
      source: 'asaas',
      description: charge.description ?? null,
      amount: charge.value_cents === null || charge.value_cents === undefined
        ? null
        : Number(charge.value_cents) / 100,
      dueDate: charge.due_date ?? null,
      paidAt: charge.payment_date ?? null,
      status: charge.status ?? null,
      billingType: charge.billing_type ?? null,
      digitableLine: null,
      barcode: null,
      // O link da fatura do Asaas mostra Pix, boleto e cartão numa página só.
      link: charge.invoice_url || charge.bank_slip_url || null,
      pix: null,
      paid: false
    };
  }

  /**
   * A integração pode responder pelo bot? Ligada, com chave, e o provedor
   * escolheu isso — o padrão é desligado, porque muda o que o assinante lê.
   */
  static async botEnabled() {
    const config = await AsaasProviderService.getConfig();
    return AsaasProviderService.isReady(config) && config.botLookup === true;
  }

  /** As faturas em aberto importadas de um CPF/CNPJ (só dígitos). Lê o banco, não o gateway. */
  static async openByDocument(document) {
    const charges = await AsaasCharge.listOpenByDocument(document);
    return charges.map((charge) => this.toInvoice(charge));
  }

  /**
   * A fatura pronta para o assinante: relida ao vivo e com os códigos.
   *
   * Devolve `null` quando o Asaas diz que ela já não está em aberto (e o banco
   * é corrigido na hora): quem chama escolhe a próxima. Uma falha de rede
   * NÃO é "não está em aberto" — nesse caso a fatura segue só com o link, que
   * é o que o painel sabe, e o link do Asaas mostra o estado de verdade.
   */
  static async completeForBot(invoice) {
    const config = await AsaasProviderService.getConfig();
    const credential = this.credentialFor(config);
    try {
      const live = await getCharge(invoice.id, credential);
      if (live.status && !OPEN_STATUSES.includes(live.status)) {
        await AsaasCharge.applyStatus(invoice.id, { status: live.status, paymentDate: live.paidOn, dueDate: live.dueDate });
        return null;
      }
      invoice = {
        ...invoice,
        dueDate: live.dueDate || invoice.dueDate,
        amount: live.valueCents === null || live.valueCents === undefined ? invoice.amount : live.valueCents / 100,
        link: live.invoiceUrl || live.bankSlipUrl || invoice.link,
        billingType: live.billingType || invoice.billingType
      };
    } catch (error) {
      if (error instanceof AsaasError && error.status === 404) {
        await AsaasCharge.markDeleted(invoice.id);
        return null;
      }
      return invoice;
    }

    // Boleto e Pix, cada um só onde faz sentido: uma cobrança só de cartão não tem nenhum dos dois.
    const type = invoice.billingType;
    const [line, pix] = await Promise.all([
      (type === 'BOLETO' || type === 'UNDEFINED')
        ? getIdentificationField(invoice.id, credential).catch(() => null)
        : null,
      (type === 'PIX' || type === 'UNDEFINED' || type === 'BOLETO')
        ? getPixQrCode(invoice.id, credential).catch(() => null)
        : null
    ]);
    return {
      ...invoice,
      digitableLine: line?.identificationField ?? null,
      barcode: line?.barCode ?? null,
      pix: pix?.payload ?? null
    };
  }
}

export default AsaasInvoiceService;
