import { tdb, tinsertReturningId } from '../config/database.js';

/**
 * A cobrança que o painel emitiu a um provedor.
 *
 * Só por `tdb`/`tinsert`, como o extrato e a assinatura: quem chama abre o
 * escopo do provedor antes. Uma cobrança gravada fora do escopo do dono é uma
 * cobrança que o dono não vê — e, pior que no extrato, é um link de pagamento
 * pendurado no provedor errado.
 *
 * Ao contrário de `BillingEvent`, este modelo ATUALIZA. É a diferença que
 * justifica a tabela: uma cobrança tem ciclo de vida, e o extrato não tem.
 */

export const CHARGE_STATUSES = Object.freeze([
  /** Emitida, ninguém pagou ainda. É o estado em que ela nasce. */
  'pending',
  /** O webhook creditou o pagamento dela. */
  'paid',
  /** Cancelada — pelo console, ou porque o provedor saiu. */
  'canceled',
  /**
   * O gateway recusou a criação. Fica na tabela de propósito: sem esta linha,
   * "o cliente nunca recebeu a cobrança" e "ninguém tentou emitir" são o mesmo
   * silêncio, e são problemas com consertos opostos.
   */
  'failed'
]);

class BillingCharge {
  /** A cobrança de um período, ou nada. É a leitura de idempotência da emissão. */
  static async forPeriod(periodEnd, trx = null) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    if (!chave) return null;
    return (await tdb('billing_charges', trx).where({ period_end: chave }).first()) || null;
  }

  /** A cobrança que o gateway nomeia, dentro do provedor em escopo. */
  static async byGatewayId(gatewayChargeId) {
    const id = String(gatewayChargeId ?? '').slice(0, 128);
    if (!id) return null;
    return (await tdb('billing_charges').where({ gateway_charge_id: id }).first()) || null;
  }

  /**
   * Grava a cobrança do período ANTES de falar com o gateway.
   *
   * Antes, e não depois, porque é a linha que impede a segunda emissão: se ela
   * só nascesse com a resposta na mão, duas passadas do agendador que se
   * cruzassem criariam duas cobranças de verdade na mão de um cliente pagante.
   * O índice único `(tenant_id, period_end)` decide a corrida; esta inserção é
   * o bilhete que a ganha.
   */
  static async open({ subscriptionId = null, periodEnd, amountCents, currency, provider, dueDate = null }) {
    return tinsertReturningId('billing_charges', {
      subscription_id: subscriptionId,
      period_end: String(periodEnd).slice(0, 10),
      amount_cents: amountCents,
      currency: String(currency || 'BRL').toUpperCase().slice(0, 3),
      provider: String(provider).slice(0, 32),
      status: 'pending',
      due_date: dueDate
    });
  }

  static async update(id, patch) {
    const changed = await tdb('billing_charges').where({ id })
      .update({ ...patch, updated_at: new Date() });
    return changed > 0;
  }

  /** O que o gateway devolveu quando a criação deu certo. */
  static async markIssued(id, { gatewayChargeId, invoiceUrl = null, dueDate = null }) {
    return BillingCharge.update(id, {
      gateway_charge_id: String(gatewayChargeId).slice(0, 128),
      invoice_url: invoiceUrl ? String(invoiceUrl).slice(0, 512) : null,
      ...(dueDate ? { due_date: dueDate } : {}),
      status: 'pending',
      last_error: null
    });
  }

  /**
   * A tentativa falhou. `attempts` sobe e o motivo fica — e é o motivo que
   * separa "o gateway recusou o CNPJ" de "a rede caiu", que é a diferença entre
   * um chamado para o cliente e um para a infraestrutura.
   */
  static async markFailed(id, motivo, { retryAfterMs = 0 } = {}) {
    // `increment` e não ler-somar-gravar: duas passadas que se cruzassem
    // perderiam um incremento, e o teto de tentativas é justamente o que
    // impede uma cobrança recusada de ser tentada para sempre.
    const changed = await tdb('billing_charges').where({ id }).update({
      status: 'failed',
      last_error: String(motivo ?? '').slice(0, 500),
      next_attempt_at: retryAfterMs > 0 ? new Date(Date.now() + retryAfterMs) : null,
      updated_at: new Date()
    });
    await tdb('billing_charges').where({ id }).increment('attempts', 1);
    return changed > 0;
  }

  /** As cobranças ainda em aberto de períodos anteriores a este. */
  static async openBefore(periodEnd) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    if (!chave) return [];
    return tdb('billing_charges')
      .whereIn('status', ['pending', 'failed'])
      .where('period_end', '<', chave)
      .orderBy('period_end');
  }

  /** A cobrança em aberto mais recente deste provedor — a que o aviso linka. */
  static async currentOpen() {
    return (await tdb('billing_charges')
      .whereIn('status', ['pending', 'failed'])
      .orderBy('period_end', 'desc')
      .first()) || null;
  }

  static async listRecent({ limit = 50 } = {}) {
    const teto = Math.min(200, Math.max(1, Number(limit) || 50));
    return tdb('billing_charges').orderBy('id', 'desc').limit(teto);
  }
}

export default BillingCharge;
export { BillingCharge };
