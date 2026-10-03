import { getDb, tdb, tinsertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * A NFS-e de uma cobrança paga — uma por cobrança, pelo índice único em
 * `charge_id`.
 *
 * Só por `tdb`/`tinsert`, como `BillingCharge`: quem chama abre o escopo do
 * provedor antes. A única leitura sem escopo é a do webhook
 * (`tenantOfExternalId`), que chega sem provedor nenhum e precisa descobrir
 * de quem é a nota antes de abrir o escopo dele.
 */

export const INVOICE_STATUSES = Object.freeze([
  /** Na fila: o pagamento entrou e a nota ainda não foi pedida (ou falhou e espera a próxima tentativa). */
  'pending',
  /** A Asaas recebeu o pedido e a prefeitura ainda não respondeu. */
  'scheduled',
  /** Emitida: tem número e PDF. */
  'authorized',
  /** A prefeitura (ou a Asaas) recusou — ou as tentativas acabaram. Reemitir pelo console. */
  'error',
  /** Cancelada — pelo estorno da cobrança, ou no painel da Asaas. */
  'canceled'
]);

/** Os estados de que o console pode pedir uma nota nova para a mesma cobrança. */
export const REISSUABLE_INVOICE_STATUSES = Object.freeze(['error', 'canceled']);

const texto = (valor, max) => (valor === null || valor === undefined || valor === ''
  ? null
  : String(valor).slice(0, max));

class BillingInvoice {
  /** A nota de uma cobrança, dentro do provedor em escopo. */
  static async forCharge(chargeId) {
    const id = Number(chargeId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return (await tdb('billing_invoices').where({ charge_id: id }).first()) || null;
  }

  /** As notas de várias cobranças, num mapa `charge_id → linha`. */
  static async forCharges(chargeIds) {
    const ids = [...new Set((chargeIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return new Map();
    const linhas = await tdb('billing_invoices').whereIn('charge_id', ids);
    return new Map(linhas.map((linha) => [Number(linha.charge_id), linha]));
  }

  static async findById(id) {
    const numero = Number(id);
    if (!Number.isInteger(numero) || numero <= 0) return null;
    return (await tdb('billing_invoices').where({ id: numero }).first()) || null;
  }

  static async byExternalId(externalId) {
    const id = texto(externalId, 64);
    if (!id) return null;
    return (await tdb('billing_invoices').where({ external_id: id }).first()) || null;
  }

  /**
   * De qual provedor é a nota que a Asaas nomeia — ou nulo.
   *
   * A entrega do webhook não diz o provedor; diz o id da nota, que só este
   * painel sabe de quem é. A leitura é por id e devolve só o `tenant_id`:
   * todo o resto acontece depois, no escopo dele.
   */
  static async tenantOfExternalId(externalId) {
    const id = texto(externalId, 64);
    if (!id) return null;
    // tenant-scope-exempt: o webhook chega sem provedor; o id da nota é o que o descobre.
    const linha = await runUnscoped('the invoice webhook resolves its provider by the invoice id', () => getDb()('billing_invoices')
      .where({ external_id: id })
      .first('tenant_id'));
    return linha ? Number(linha.tenant_id) : null;
  }

  /** Abre a nota na fila. Lança a violação de unicidade quando a cobrança já tem uma. */
  static async enqueue(chargeId) {
    return tinsertReturningId('billing_invoices', {
      charge_id: Number(chargeId),
      status: 'pending',
      attempts: 0
    });
  }

  static async update(id, patch) {
    const changed = await tdb('billing_invoices').where({ id }).update({ ...patch, updated_at: new Date() });
    return changed > 0;
  }

  /**
   * Devolve à fila a nota que deu erro ou foi cancelada — a MESMA linha, para
   * que o índice único continue impedindo duas notas vivas da mesma cobrança.
   * Condicional ao estado lido: se o webhook a mudou no meio, nada muda.
   */
  static async reopen(id, fromStatus) {
    const changed = await tdb('billing_invoices').where({ id, status: fromStatus }).update({
      status: 'pending',
      external_id: null,
      number: null,
      pdf_url: null,
      xml_url: null,
      error: null,
      attempts: 0,
      next_attempt_at: null,
      issued_at: null,
      updated_at: new Date()
    });
    return changed > 0;
  }

  /**
   * Toma a linha para falar com a Asaas por ela, até `until` — ou não toma.
   *
   * O `next_attempt_at` faz as vezes de garra: só segue quem o empurrou para
   * a frente a partir do valor que leu. Duas passadas que se cruzassem (dois
   * processos, ou o agendador e um clique do console) pediriam DUAS notas para
   * o mesmo pagamento — e nota fiscal emitida não se apaga, se cancela, com
   * prazo e às vezes com a prefeitura dizendo não.
   */
  static async claim(linha, { until, now = new Date() }) {
    const changed = await tdb('billing_invoices')
      .where({ id: linha.id, status: linha.status })
      .where((livre) => livre.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))
      .update({ next_attempt_at: until, updated_at: new Date() });
    return changed > 0;
  }

  /** As linhas que o agendador deve levar adiante agora, deste provedor. */
  static async due({ statuses, now = new Date(), limit = 5 }) {
    return tdb('billing_invoices')
      .whereIn('status', statuses)
      .where((livre) => livre.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))
      .orderBy('id')
      .limit(limit);
  }

  /** A nota como o CONSOLE a vê: com o último erro, que é o que diz por que não saiu. */
  static presentForConsole(row) {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      number: row.number ?? null,
      pdfUrl: row.pdf_url ?? null,
      xmlUrl: row.xml_url ?? null,
      error: row.error ?? null,
      attempts: Number(row.attempts ?? 0),
      issuedAt: row.issued_at ?? null
    };
  }

  /**
   * A nota como o PROVEDOR a vê: estado, número e onde baixar. Sem o erro —
   * é texto cru da Asaas e da prefeitura, sobre a NOSSA conta.
   */
  static present(row) {
    if (!row) return null;
    const emitida = row.status === 'authorized';
    return {
      status: row.status,
      number: emitida ? (row.number ?? null) : null,
      pdfUrl: emitida ? (row.pdf_url ?? null) : null,
      xmlUrl: emitida ? (row.xml_url ?? null) : null,
      issuedAt: emitida ? (row.issued_at ?? null) : null
    };
  }
}

export default BillingInvoice;
export { BillingInvoice };
