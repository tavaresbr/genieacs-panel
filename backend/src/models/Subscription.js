import { getDb, tdb, tinsert } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * A assinatura de um provedor: uma linha, uma por provedor.
 *
 * Duas portas de entrada, e a diferença entre elas é quem pergunta.
 *
 * `current()` é o provedor lendo a própria assinatura — a tela de plano e uso,
 * e o gate, que já roda dentro do escopo que o resolvedor abriu. Passa por
 * `tdb`, como tudo que é dele.
 *
 * `forTenant(id)` e `upsertForTenant(id, …)` são o plano de controle olhando
 * para um provedor de fora, e o seed, que roda antes de haver escopo. Levam o
 * provedor no argumento e filtram à mão, como `TenantInvite.findByToken`: o
 * marcador diz à guarda estática que a ausência de `tdb` é decisão, não
 * esquecimento.
 */
export const SUBSCRIPTION_STATUSES = Object.freeze([
  'trial', 'active', 'past_due', 'suspended', 'canceled'
]);

class Subscription {
  static async current() {
    return (await tdb('subscriptions').first()) || null;
  }

  static async forTenant(tenantId, db = getDb()) {
    if (!tenantId) return null;
    // tenant-scope-exempt: o provedor vem no argumento — quem chama está acima dele (console, seed, gate).
    return (await db('subscriptions').where({ tenant_id: tenantId }).first()) || null;
  }

  /**
   * Todas, com o plano ao lado: o que o console lista.
   *
   * `runUnscoped` e não só o marcador: a sentinela de SQL (`sqlSentinel.js`)
   * derruba, em teste, qualquer leitura de tabela escopada sem filtro de
   * provedor — e esta leitura não tem filtro DE PROPÓSITO, porque o console
   * está acima de todos eles. A razão fica escrita aqui, onde a sentinela a
   * lê, e não numa lista de exceções longe do sítio.
   */
  static async listWithPlans() {
    // tenant-scope-exempt: listagem do plano de controle, acima dos provedores.
    return runUnscoped('the console lists every provider\'s subscription', () => getDb()('subscriptions')
      .join('plans', 'plans.id', 'subscriptions.plan_id')
      .select(
        'subscriptions.*',
        'plans.code as plan_code',
        'plans.name as plan_name',
        'plans.max_operators',
        'plans.max_subscribers',
        'plans.max_devices',
        // O preço vem junto para a tela de Assinaturas, que mostra quanto cada
        // um paga — e uma segunda leitura de `plans` por linha seria a
        // consulta N+1 que esta junção existe para não fazer.
        'plans.price_cents as plan_price_cents',
        'plans.currency as plan_currency'
      ));
  }

  /**
   * Cria ou altera a assinatura de um provedor nomeado.
   *
   * `patch` só leva colunas; quem decide o que a mudança significa (extrato,
   * trilha, cache) é o serviço. Aqui é só a linha.
   */
  static async upsertForTenant(tenantId, patch, db = getDb()) {
    const existing = await Subscription.forTenant(tenantId, db);
    if (existing) {
      // tenant-scope-exempt: o provedor vem no argumento (ver acima).
      await db('subscriptions')
        .where({ tenant_id: tenantId })
        .update({ ...patch, updated_at: new Date() });
    } else {
      // tenant-scope-exempt: idem — e o seed chama isto sem escopo nenhum aberto.
      await db('subscriptions').insert({ tenant_id: tenantId, ...patch });
    }
    return Subscription.forTenant(tenantId, db);
  }

  /**
   * Aplica a descida agendada (0074) — só se ela ainda é a que se leu.
   *
   * Condicional pelo `pending_plan_id`, e não um `upsertForTenant` cego: o
   * agendador e um pagamento podem chegar ao mesmo prazo no mesmo minuto, e
   * sem a condição os dois trocariam o plano e gravariam cada um a sua linha
   * de "plano trocado" no extrato. Quem muda a linha é quem aplicou; o outro
   * recebe `false` e não grava nada. Também não passa por cima de um
   * cancelamento ou de uma troca pelo console que entrou no meio — os dois
   * limpam a coluna, e a condição deixa de casar.
   */
  static async applyPendingPlan(tenantId, pendingPlanId, db = getDb()) {
    if (!tenantId || !pendingPlanId) return false;
    // tenant-scope-exempt: o provedor vem no argumento (ver acima).
    const changed = await db('subscriptions')
      .where({ tenant_id: tenantId, pending_plan_id: pendingPlanId })
      .update({
        plan_id: pendingPlanId,
        pending_plan_id: null,
        pending_plan_at: null,
        pending_plan_locked_at: null,
        // O plano novo é o de baixo: não há subida no período a proteger.
        upgraded_at: null,
        updated_at: new Date()
      });
    return changed > 0;
  }

  /**
   * Grava uma mudança do "isento de cobrança" — só se a isenção ainda está
   * como se leu (`wasExempt`) e, no fim automático (`expiredBy`), só se o
   * `billing_exempt_until` gravado já passou daquele instante.
   *
   * Condicional pelo mesmo motivo de `applyPendingPlan`: duas voltas do
   * agendador (ou o agendador e o console) podem desligar a mesma isenção no
   * mesmo minuto, e sem a condição as duas gravariam a sua linha no extrato e
   * reabririam a cobrança. Quem muda a linha é quem desligou; o outro recebe
   * `false` e não grava nada.
   */
  static async changeBillingExemptIf(tenantId, { wasExempt, expiredBy = null }, patch, db = getDb()) {
    if (!tenantId) return false;
    // tenant-scope-exempt: o provedor vem no argumento (ver acima).
    const query = db('subscriptions').where({ tenant_id: tenantId });
    if (wasExempt) query.whereNotNull('billing_exempt_at');
    else query.whereNull('billing_exempt_at');
    if (expiredBy) query.whereNotNull('billing_exempt_until').where('billing_exempt_until', '<=', expiredBy);
    const changed = await query.update({ ...patch, updated_at: new Date() });
    return changed > 0;
  }

  /** A do provedor em escopo — o caminho que um controlador do próprio provedor usaria. */
  static async createCurrent(row) {
    await tinsert('subscriptions', row);
    return Subscription.current();
  }
}

export default Subscription;
