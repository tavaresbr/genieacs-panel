import { tdb, tinsertReturningId } from '../config/database.js';

/**
 * Os add-ons de UM provedor (0125). Só por `tdb`: quem chama abre o escopo do
 * provedor antes — o add-on de um nunca aparece, nem é cobrado, no outro.
 *
 * A linha VIVA de um add-on é a `active` com `active_key = addon_id`; o índice
 * único `(tenant_id, active_key)` é o que faz dois cliques darem uma linha só.
 * Cancelada, `active_key` vira nulo e a linha fica como histórico.
 */
class TenantAddon {
  /** As linhas ativas do provedor em escopo (com e sem cancelamento agendado). */
  static async listActive(trx = null) {
    return tdb('tenant_addons', trx).where({ status: 'active' }).orderBy('id');
  }

  /** Todas as linhas do provedor em escopo, as mais recentes primeiro. */
  static async listAll({ limit = 100 } = {}) {
    return tdb('tenant_addons').orderBy('id', 'desc').limit(Math.min(500, Math.max(1, Number(limit) || 100)));
  }

  /** A linha ativa deste add-on, ou nada. */
  static async activeFor(addonId, trx = null) {
    return (await tdb('tenant_addons', trx).where({ addon_id: addonId, status: 'active' }).first()) || null;
  }

  static async findById(id) {
    return (await tdb('tenant_addons').where({ id }).first()) || null;
  }

  /** Insere a linha ativa. O índice único recusa a segunda (`isUniqueViolation`). */
  static async insertActive({
    addonId, startedAt = new Date(), free = false, source = 'provider', reason = null, createdBy = null
  }) {
    return tinsertReturningId('tenant_addons', {
      addon_id: addonId,
      status: 'active',
      active_key: addonId,
      started_at: startedAt,
      free: Boolean(free),
      source: String(source).slice(0, 16),
      reason: reason ? String(reason).slice(0, 255) : null,
      created_by: createdBy ?? null
    });
  }

  static async update(id, patch) {
    const changed = await tdb('tenant_addons').where({ id }).update({ ...patch, updated_at: new Date() });
    return changed > 0;
  }

  /** Encerra a linha AGORA: deixa de valer e sai do índice da linha viva. */
  static async endNow(id, { at = new Date(), by = null, reason = undefined } = {}) {
    return TenantAddon.update(id, {
      status: 'canceled',
      active_key: null,
      canceled_at: at,
      canceled_by: by ?? null,
      ...(reason !== undefined ? { reason: reason ? String(reason).slice(0, 255) : null } : {})
    });
  }

  /**
   * Encerra as linhas cujo cancelamento agendado já chegou (`cancel_at` no
   * passado) — a faxina preguiçosa: quem lê o direito já ignora a linha pelo
   * horário, e esta escrita só põe o estado gravado em dia com ele.
   */
  static async finalizeDue(now = new Date()) {
    const vencidas = await tdb('tenant_addons')
      .where({ status: 'active' })
      .whereNotNull('cancel_at')
      .where('cancel_at', '<=', now);
    for (const linha of vencidas) {
      // eslint-disable-next-line no-await-in-loop -- poucas por provedor
      await tdb('tenant_addons').where({ id: linha.id, status: 'active' }).update({
        status: 'canceled', active_key: null, canceled_at: linha.cancel_at, updated_at: new Date()
      });
    }
    return vencidas.length;
  }
}

export default TenantAddon;
