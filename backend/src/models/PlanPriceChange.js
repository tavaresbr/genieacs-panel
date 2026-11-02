import { getDb, insertReturningId, isUniqueViolation } from '../config/database.js';

/**
 * O reajuste de preço de um plano com data de vigência (0122).
 *
 * Fora de `tdb`, como `plans`: é do catálogo, e não de um provedor. Quem
 * escreve é o console (atrás de `requirePlatformAdmin`) e o agendador da
 * plataforma; a leitura é livre, porque é ela que decide o preço de toda
 * cobrança do plano — ver `planAt`.
 */
export const PRICE_CHANGE_STATUSES = Object.freeze(['scheduled', 'applied', 'canceled']);
export const PRICE_CHANGE_CYCLES = Object.freeze(['monthly', 'annual']);

/** A coluna de `plans` que cada ciclo reajusta. */
export function priceColumnOf(cycle) {
  return cycle === 'annual' ? 'price_yearly_cents' : 'price_cents';
}

function normalizar(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    plan_id: Number(row.plan_id),
    old_cents: Number(row.old_cents),
    new_cents: Number(row.new_cents),
    notice_days: Number(row.notice_days),
    notify: row.notify === true || row.notify === 1 || row.notify === '1' || row.notify === 't',
    effective_at: String(row.effective_at).slice(0, 10)
  };
}

class PlanPriceChange {
  static async findById(id, db = getDb()) {
    if (!id) return null;
    return normalizar(await db('plan_price_changes').where({ id }).first());
  }

  /** Os reajustes de um plano (ou de todos), mais novos primeiro. */
  static async list({ planId = null, statuses = null } = {}, db = getDb()) {
    let query = db('plan_price_changes').orderBy('effective_at', 'desc').orderBy('id', 'desc');
    if (planId) query = query.where({ plan_id: planId });
    if (statuses?.length) query = query.whereIn('status', statuses);
    return (await query).map(normalizar);
  }

  /** O reajuste ainda agendado deste plano neste ciclo — no máximo um (ver o serviço). */
  static async scheduledFor(planId, cycle, db = getDb()) {
    return normalizar(await db('plan_price_changes')
      .where({ plan_id: planId, cycle, status: 'scheduled' })
      .orderBy('effective_at', 'asc')
      .first());
  }

  static async create(row, db = getDb()) {
    const id = await insertReturningId('plan_price_changes', row, db);
    return PlanPriceChange.findById(id, db);
  }

  /**
   * Muda o estado SÓ de quem ainda está em `from` — a escrita condicional é a
   * trava: de duas passadas (ou de um clique e uma passada), uma muda e a
   * outra recebe `false`.
   */
  static async transition(id, from, patch, db = getDb()) {
    const n = await db('plan_price_changes').where({ id, status: from }).update(patch);
    return Number(n) > 0;
  }

  static async update(id, patch, db = getDb()) {
    await db('plan_price_changes').where({ id }).update(patch);
  }

  /**
   * O preço de `cycle` de `plan` para a cobrança cujo período vence em
   * `dueKey` (a chave do período, `YYYY-MM-DD` no fuso da cobrança) — a regra
   * do reajuste, sem tabela por assinante:
   *
   *   - a cobrança que vence ANTES de um reajuste já aplicado paga o preço de
   *     antes dele (`old_cents` do primeiro aplicado depois do vencimento);
   *   - a que vence NA data de um reajuste ainda agendado, ou depois, paga o
   *     preço novo (`new_cents` do último agendado até o vencimento);
   *   - o resto, o preço do plano.
   *
   * Nulo quando nada disso muda o preço do plano (o caso de quase sempre).
   */
  static resolvePrice(changes, plan, cycle, dueKey) {
    if (!changes?.length || !dueKey) return null;
    const doCiclo = changes
      .filter((c) => c.cycle === cycle && c.status !== 'canceled')
      .sort((a, b) => (a.effective_at < b.effective_at ? -1 : a.effective_at > b.effective_at ? 1 : a.id - b.id));
    const aplicadoDepois = doCiclo.find((c) => c.status === 'applied' && c.effective_at > dueKey);
    if (aplicadoDepois) return aplicadoDepois.old_cents;
    const agendados = doCiclo.filter((c) => c.status === 'scheduled' && c.effective_at <= dueKey);
    if (agendados.length) return agendados[agendados.length - 1].new_cents;
    return null;
  }

  /**
   * `plan` com os preços que valem para a cobrança que vence em `dueKey` — uma
   * CÓPIA quando um reajuste muda algum, o mesmo objeto quando não muda. Quem
   * calcula o preço da cobrança (`issueCurrent`, a reprecificação) passa o
   * plano por aqui e segue lendo `cyclePriceCents` como sempre.
   */
  static async planAt(plan, dueKey, db = getDb()) {
    if (!plan?.id || !dueKey) return plan;
    const changes = (await db('plan_price_changes')
      .where({ plan_id: plan.id })
      .whereIn('status', ['scheduled', 'applied'])).map(normalizar);
    if (!changes.length) return plan;
    const mensal = PlanPriceChange.resolvePrice(changes, plan, 'monthly', dueKey);
    const anual = PlanPriceChange.resolvePrice(changes, plan, 'annual', dueKey);
    if (mensal === null && anual === null) return plan;
    return {
      ...plan,
      ...(mensal !== null ? { price_cents: mensal } : {}),
      ...(anual !== null ? { price_yearly_cents: anual } : {})
    };
  }

  // ── A memória por provedor (`plan_price_change_marks`) ───────────────

  /**
   * Toma a marca `(changeId, tenantId, mark)` para quem chama, até `until`.
   * `true` quando é dela: a linha nasceu agora, ou existia sem estar feita e
   * com a garra vencida. `false` quando já foi feita, ou outra passada a tem.
   * `maxAttempts` desiste da que falhou demais.
   */
  static async claimMark({ changeId, tenantId, mark, now, until, maxAttempts = 10 }, db = getDb()) {
    try {
      await db('plan_price_change_marks').insert({
        change_id: changeId, tenant_id: tenantId, mark, status: 'claimed', claimed_until: until, attempts: 0
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existente = await db('plan_price_change_marks')
        .where({ change_id: changeId, tenant_id: tenantId, mark }).first();
      if (!existente) throw error;
      if (existente.status === 'done') return false;
      if (Number(existente.attempts ?? 0) >= maxAttempts) return false;
      const n = await db('plan_price_change_marks')
        .where({ id: existente.id })
        .whereNot({ status: 'done' })
        .where((q) => q.whereNull('claimed_until').orWhere('claimed_until', '<=', now))
        .update({ status: 'claimed', claimed_until: until });
      return Number(n) > 0;
    }
  }

  static async finishMark({ changeId, tenantId, mark, detail = null, now }, db = getDb()) {
    await db('plan_price_change_marks')
      .where({ change_id: changeId, tenant_id: tenantId, mark })
      .update({ status: 'done', done_at: now, claimed_until: null, detail: detail ? String(detail).slice(0, 255) : null });
  }

  /** A falha: a marca volta a ficar livre em `retryAt`, com uma tentativa a mais. */
  static async failMark({ changeId, tenantId, mark, detail = null, retryAt }, db = getDb()) {
    await db('plan_price_change_marks')
      .where({ change_id: changeId, tenant_id: tenantId, mark })
      .update({
        status: 'failed',
        claimed_until: retryAt,
        attempts: db.raw('attempts + 1'),
        detail: detail ? String(detail).slice(0, 255) : null
      });
  }

  static async marksOf(changeId, { prefix = null, status = null } = {}, db = getDb()) {
    let query = db('plan_price_change_marks').where({ change_id: changeId });
    if (prefix) query = query.where('mark', 'like', `${prefix}%`);
    if (status) query = query.where({ status });
    return query.orderBy('id', 'asc');
  }
}

export default PlanPriceChange;
