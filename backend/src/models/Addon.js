import { getDb, insertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * O catálogo de add-ons pagos (0126) — ver `services/addonService.js`.
 *
 * Lido fora de `tdb`, pelo motivo de `plans` e `coupons`: não tem `tenant_id`
 * porque é do deploy inteiro — o provedor contrata O add-on `whatsapp`, não
 * tem o seu. Quem escreve é só o console, atrás de `requirePlatformAdmin`.
 */
export const ADDON_KINDS = Object.freeze(['feature', 'limit']);
export const ADDON_LIMIT_RESOURCES = Object.freeze(['operators', 'subscribers', 'devices']);

/** O código como se guarda e se compara: sem espaço nas pontas, em minúsculas. */
export function normalizeAddonCode(code) {
  return String(code ?? '').trim().toLowerCase();
}

class Addon {
  static async list() {
    return getDb()('addons').orderBy('sort', 'asc').orderBy('id', 'asc');
  }

  static async findById(id) {
    const numero = Number(id);
    if (!Number.isInteger(numero) || numero <= 0) return null;
    return (await getDb()('addons').where({ id: numero }).first()) || null;
  }

  static async findByCode(code) {
    const codigo = normalizeAddonCode(code);
    if (!codigo) return null;
    return (await getDb()('addons').where({ code: codigo }).first()) || null;
  }

  static async create(row) {
    const id = await insertReturningId('addons', { ...row, code: normalizeAddonCode(row.code) });
    return Addon.findById(id);
  }

  static async update(id, patch) {
    const changed = await getDb()('addons').where({ id }).update({ ...patch, updated_at: new Date() });
    return changed > 0 ? Addon.findById(id) : null;
  }

  /** Quantos provedores já tiveram este add-on (qualquer estado) — o que decide se ele pode ser apagado. */
  static async usageCount(id) {
    // tenant-scope-exempt: conta ACIMA dos provedores — é o console perguntando se o add-on já foi contratado.
    const [row] = await runUnscoped('the console counts the providers that had an add-on', () => getDb()('tenant_addons')
      .where({ addon_id: id })
      .count({ n: '*' }));
    return Number(row?.n ?? 0);
  }

  /** Quantos provedores têm cada add-on ATIVO agora, por id. */
  static async activeUsage() {
    // tenant-scope-exempt: a lista do catálogo no console, acima dos provedores.
    const linhas = await runUnscoped('the console counts the active add-ons of every provider', () => getDb()('tenant_addons')
      .where({ status: 'active' })
      .groupBy('addon_id')
      .select('addon_id')
      .count({ n: '*' }));
    return new Map(linhas.map((linha) => [Number(linha.addon_id), Number(linha.n)]));
  }

  /**
   * Quantos provedores PERDERIAM o recurso de cada add-on de recurso se a
   * porta dele fosse ligada agora (0126): os provedores ativos, com
   * assinatura viva, que não têm nenhum add-on vivo daquele recurso — fora a
   * caixa da plataforma e os isentos de cobrança (que a porta não fecha), e
   * fora quem está em teste quando o add-on dá acesso no teste. É a conta do
   * aviso do console antes de ligar `gated`.
   *
   * @returns {Promise<Map<number, number>>} por id do add-on
   */
  static async gateImpact(addons, now = new Date()) {
    const deRecurso = (addons ?? []).filter((addon) => addon.kind === 'feature' && addon.feature);
    if (!deRecurso.length) return new Map();
    const [provedores, vivas] = await runUnscoped('the console previews who a gated add-on would lock out', async () => {
      const db = getDb();
      // tenant-scope-exempt: a prévia do console, acima dos provedores.
      const tenants = await db('tenants')
        .leftJoin('subscriptions', 'subscriptions.tenant_id', 'tenants.id')
        .where('tenants.status', 'active')
        .whereNot('tenants.kind', 'platform')
        .whereIn('subscriptions.status', ['trial', 'active', 'past_due'])
        .whereNull('subscriptions.billing_exempt_at')
        .select('tenants.id as id', 'subscriptions.status as status');
      // tenant-scope-exempt: a prévia do console, acima dos provedores.
      const linhas = await db('tenant_addons').where({ status: 'active' })
        .where((q) => q.whereNull('cancel_at').orWhere('cancel_at', '>', now))
        .select('tenant_id', 'addon_id');
      return [tenants, linhas];
    });
    const recursoDoAddon = new Map((addons ?? []).map((addon) => [Number(addon.id), addon.kind === 'feature' ? addon.feature : null]));
    const temRecurso = new Map();
    for (const linha of vivas) {
      const recurso = recursoDoAddon.get(Number(linha.addon_id));
      if (!recurso) continue;
      if (!temRecurso.has(recurso)) temRecurso.set(recurso, new Set());
      temRecurso.get(recurso).add(Number(linha.tenant_id));
    }
    const saida = new Map();
    for (const addon of deRecurso) {
      const com = temRecurso.get(addon.feature) ?? new Set();
      const perdem = provedores.filter((p) => !com.has(Number(p.id)) && !(addon.trial_access && p.status === 'trial'));
      saida.set(Number(addon.id), new Set(perdem.map((p) => Number(p.id))).size);
    }
    return saida;
  }

  /** Apaga o add-on que NUNCA foi contratado; devolve se apagou. */
  static async deleteIfUnused(id) {
    if (await Addon.usageCount(id)) return false;
    const changed = await getDb()('addons').where({ id }).del();
    return changed > 0;
  }
}

export default Addon;
