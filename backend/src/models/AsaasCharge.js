import { tdb, tinsert, withDeadlockRetry } from '../config/database.js';

/** O que ainda se espera receber: o que o gateway chama de em aberto. */
export const OPEN_STATUSES = Object.freeze(['PENDING', 'OVERDUE']);

/**
 * As cobranças da conta Asaas do provedor, como a importação as guarda.
 *
 * `document` é copiado do cliente na entrada: é por ele que a fatura encontra o
 * assinante (e o SGP) e que o dossiê e a exclusão do titular a alcançam.
 */
class AsaasCharge {
  static async upsertFromAsaas(row, { document, seenAt }) {
    const now = new Date();
    const values = {
      asaas_id: row.id,
      customer_asaas_id: row.customerId ?? null,
      document: document ?? null,
      status: row.status ?? null,
      billing_type: row.billingType ?? null,
      value_cents: row.valueCents ?? null,
      due_date: row.dueDate ?? null,
      payment_date: row.paymentDate ?? null,
      description: row.description ?? null,
      invoice_url: row.invoiceUrl ?? null,
      bank_slip_url: row.bankSlipUrl ?? null,
      invoice_number: row.invoiceNumber ?? null,
      external_reference: row.externalReference ?? null,
      deleted: row.deleted === true,
      last_seen_at: seenAt,
      updated_at: now
    };
    const existing = await tdb('asaas_charges').where({ asaas_id: row.id }).first();
    await withDeadlockRetry(() => tinsert('asaas_charges', values)
      .onConflict(['tenant_id', 'asaas_id']).merge(values));
    return existing ? 'updated' : 'created';
  }

  static async getByAsaasId(asaasId) {
    return (await tdb('asaas_charges').where({ asaas_id: String(asaasId) }).first()) || null;
  }

  /** Todas as cobranças que o painel tem como em aberto (id interno e id do gateway). */
  static async listOpen() {
    return tdb('asaas_charges')
      .whereIn('status', OPEN_STATUSES)
      .where({ deleted: false })
      .orderBy('id')
      .select('id', 'asaas_id');
  }

  /** Atualiza o que o gateway disse da cobrança depois que ela saiu da lista de abertas. */
  static async applyStatus(asaasId, { status, paymentDate, dueDate }) {
    await tdb('asaas_charges').where({ asaas_id: String(asaasId) }).update({
      status: status ?? null,
      payment_date: paymentDate ?? null,
      ...(dueDate ? { due_date: dueDate } : {}),
      updated_at: new Date()
    });
  }

  /** Marca como removida uma cobrança que o gateway já não conhece. */
  static async markDeleted(asaasId) {
    await tdb('asaas_charges').where({ asaas_id: String(asaasId) })
      .update({ deleted: true, updated_at: new Date() });
  }

  /** As cobranças em aberto de um CPF/CNPJ (só dígitos), da mais antiga à mais nova. */
  static async listOpenByDocument(document) {
    if (!document) return [];
    return tdb('asaas_charges')
      .where({ document, deleted: false })
      .whereIn('status', OPEN_STATUSES)
      .orderBy('due_date', 'asc');
  }

  /** Os ids (do gateway) dos clientes que têm cobrança em aberto. */
  static async openCustomerIds() {
    const rows = await tdb('asaas_charges')
      .where({ deleted: false })
      .whereIn('status', OPEN_STATUSES)
      .whereNotNull('customer_asaas_id')
      .distinct('customer_asaas_id');
    return rows.map((row) => row.customer_asaas_id);
  }

  /** As cobranças em aberto de UM cliente do gateway, da mais antiga à mais nova. */
  static async listOpenByCustomer(customerAsaasId) {
    return tdb('asaas_charges')
      .where({ customer_asaas_id: String(customerAsaasId), deleted: false })
      .whereIn('status', OPEN_STATUSES)
      .orderBy('due_date', 'asc');
  }

  /** O que o painel tem dessas cobranças (para conferir o pagamento de uma mensagem já enfileirada). */
  static async getByAsaasIds(ids) {
    const wanted = [...new Set(ids.map(String))];
    const rows = [];
    for (let i = 0; i < wanted.length; i += 200) {
      // eslint-disable-next-line no-await-in-loop -- poucos blocos
      rows.push(...await tdb('asaas_charges').whereIn('asaas_id', wanted.slice(i, i + 200)));
    }
    return rows;
  }

  static async countOpen() {
    const [row] = await tdb('asaas_charges')
      .where({ deleted: false })
      .whereIn('status', OPEN_STATUSES)
      .count({ n: '*' });
    return Number(row?.n ?? 0);
  }

  static async countOverdue() {
    const [row] = await tdb('asaas_charges')
      .where({ deleted: false, status: 'OVERDUE' })
      .count({ n: '*' });
    return Number(row?.n ?? 0);
  }
}

export default AsaasCharge;
