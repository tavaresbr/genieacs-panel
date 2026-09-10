import { getDb, tdb } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * O extrato comercial de um provedor: o que aconteceu, e quando.
 *
 * Só escrita e leitura. Quem decide o que é um fato válido é
 * `services/subscriptionBillingService.js`; aqui não há regra de negócio, pelo
 * mesmo motivo pelo qual `AuditLog` não tem: um livro que julga o que aceita é
 * um livro que às vezes não registra.
 */
class TenantBillingEvent {
  static KINDS = Object.freeze({
    /** Entrou dinheiro, por um período. */
    PAYMENT: 'payment',
    /** O estado comercial andou. */
    STATUS_CHANGE: 'status_change'
  });

  /**
   * Escreve um fato. Devolve a linha, ou `null` quando ela já existia.
   *
   * `null` e não erro para uma reentrega: um gateway que manda o mesmo webhook
   * duas vezes não fez nada errado, e tratar isso como falha faria o gateway
   * tentar de novo — para sempre. A colisão é detectada pelo índice único e
   * confirmada por uma leitura, em vez de reconhecida pela mensagem de erro de
   * três bancos diferentes.
   *
   * tenant-scope-exempt: escrito tanto de dentro do provedor quanto do plano de
   * controle, que administra de fora e nomeia o alvo.
   */
  static async record({
    tenantId, kind, source = 'manual', externalId = null,
    statusFrom = null, statusTo = null, amountCents = null, currency = null,
    periodStart = null, periodEnd = null, detail = null, occurredAt = null
  }) {
    const id = Number(tenantId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid tenant id');
    const linha = {
      tenant_id: id,
      kind,
      source,
      external_id: externalId,
      status_from: statusFrom,
      status_to: statusTo,
      amount_cents: amountCents === null || amountCents === undefined
        ? null
        : Math.trunc(Number(amountCents)),
      currency,
      period_start: periodStart,
      period_end: periodEnd,
      detail: detail === null || detail === undefined ? null : JSON.stringify(detail),
      occurred_at: occurredAt ?? new Date(),
      created_at: new Date()
    };
    try {
      // tenant-scope-exempt: o `tenant_id` é o nomeado por quem chama, escrito à
      // mão em `linha` acima. O plano de controle escreve daqui administrando de
      // fora, no escopo de outro provedor.
      await getDb()('tenant_billing_events').insert(linha);
    } catch (error) {
      if (externalId && await this.findByExternalId(source, externalId)) return null;
      throw error;
    }
    return externalId
      ? this.findByExternalId(source, externalId)
      : this.latestFor(id);
  }

  /**
   * O fato que um id de gateway nomeia, em qualquer provedor.
   *
   * tenant-scope-exempt: a chave é `(source, external_id)`, e ela é global por
   * natureza — o id é do gateway, que não conhece a nossa noção de provedor.
   * Filtrar por provedor aqui seria já saber a resposta, e é a mesma exceção,
   * pelo mesmo motivo, que `TenantInvite.findByToken` declara para o token.
   * É também por isso que o índice único é `(source, external_id)` e não
   * `(tenant_id, source, external_id)`: uma reentrega precisa colidir mesmo
   * quando quem a reenvia se enganou sobre o provedor.
   *
   * `runUnscoped` diz isso à sentinela de SQL, que lê o SQL e não o comentário.
   */
  static async findByExternalId(source, externalId) {
    if (!externalId) return null;
    return runUnscoped(
      'idempotência de cobrança: o id do evento é do gateway e não conhece provedor',
      // tenant-scope-exempt: ver o bloco acima — a chave é do gateway, e
      // filtrar por provedor aqui seria já saber a resposta.
      async () => (await getDb()('tenant_billing_events')
        .where({ source, external_id: externalId }).first()) ?? null
    );
  }

  /** tenant-scope-exempt: usado logo após uma escrita nomeando o provedor. */
  static async latestFor(tenantId) {
    return (await getDb()('tenant_billing_events')
      .where({ tenant_id: Number(tenantId) })
      .orderBy([{ column: 'occurred_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .first()) ?? null;
  }

  /** O extrato do provedor em escopo, do mais recente para o mais antigo. */
  static async list({ limit = 50 } = {}) {
    const teto = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return tdb('tenant_billing_events')
      .orderBy([{ column: 'occurred_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(teto);
  }

  /** Como um fato aparece numa resposta. */
  static present(linha) {
    if (!linha) return null;
    let detalhe = null;
    try {
      detalhe = linha.detail ? JSON.parse(linha.detail) : null;
    } catch {
      detalhe = null;
    }
    return {
      id: linha.id,
      kind: linha.kind,
      source: linha.source,
      externalId: linha.external_id ?? null,
      statusFrom: linha.status_from ?? null,
      statusTo: linha.status_to ?? null,
      amountCents: linha.amount_cents ?? null,
      currency: linha.currency ?? null,
      periodStart: linha.period_start ?? null,
      periodEnd: linha.period_end ?? null,
      detail: detalhe,
      occurredAt: linha.occurred_at ?? null
    };
  }
}

export default TenantBillingEvent;
