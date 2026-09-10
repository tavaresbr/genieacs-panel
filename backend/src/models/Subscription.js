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
        'plans.max_devices'
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

  /** A do provedor em escopo — o caminho que um controlador do próprio provedor usaria. */
  static async createCurrent(row) {
    await tinsert('subscriptions', row);
    return Subscription.current();
  }
}

export default Subscription;
