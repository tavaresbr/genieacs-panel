import { tdb, tinsert } from '../config/database.js';

/**
 * O extrato da assinatura, sempre no escopo do provedor a quem pertence.
 *
 * Só `tdb`/`tinsert`, de propósito: o console, que registra pagamento de um
 * provedor que não é o seu, abre o escopo dele com `runInTenant` antes de
 * chamar aqui — o mesmo que `PlatformController.setStatus` já faz para gravar
 * na trilha do provedor suspenso. Uma linha de extrato gravada fora do escopo
 * do dono é uma linha que o dono não vê no próprio painel.
 */
export const BILLING_EVENT_TYPES = Object.freeze({
  TRIAL_STARTED: 'trial.started',
  PAYMENT_RECORDED: 'payment.recorded',
  PLAN_CHANGED: 'plan.changed',
  STATUS_CHANGED: 'status.changed'
});

class BillingEvent {
  static async record({
    subscriptionId = null, type, amountCents = null, currency = null,
    provider = 'manual', externalId = null, createdBy = null, detail = null
  }) {
    await tinsert('billing_events', {
      subscription_id: subscriptionId,
      type,
      amount_cents: amountCents,
      currency: currency ? String(currency).toUpperCase().slice(0, 3) : null,
      provider: String(provider).slice(0, 32),
      external_id: externalId ? String(externalId).slice(0, 128) : null,
      created_by: createdBy,
      detail: detail === null || detail === undefined ? null : JSON.stringify(detail).slice(0, 4000)
    });
    return true;
  }

  /** Do mais recente para o mais antigo. */
  static async listRecent({ limit = 50 } = {}) {
    return tdb('billing_events')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
  }
}

export default BillingEvent;
