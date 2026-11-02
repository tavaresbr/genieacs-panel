import { getDb, insertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * O catálogo de add-ons pagos (0125) — ver `services/addonService.js`.
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

  /** Apaga o add-on que NUNCA foi contratado; devolve se apagou. */
  static async deleteIfUnused(id) {
    if (await Addon.usageCount(id)) return false;
    const changed = await getDb()('addons').where({ id }).del();
    return changed > 0;
  }
}

export default Addon;
