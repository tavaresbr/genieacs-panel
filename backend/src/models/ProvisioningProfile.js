import { getDb } from '../config/database.js';

function parseList(value, fallback = []) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    plan_patterns: parseList(row.plan_patterns),
    wifi_indexes: parseList(row.wifi_indexes),
    is_default: Boolean(Number(row.is_default)),
    enabled: Boolean(Number(row.enabled)),
    apply_wan: Boolean(Number(row.apply_wan)),
    apply_pppoe_password: Boolean(Number(row.apply_pppoe_password)),
    apply_wifi: Boolean(Number(row.apply_wifi)),
    apply_credentials: Boolean(Number(row.apply_credentials)),
    wan_nat_enabled: row.wan_nat_enabled === null || row.wan_nat_enabled === undefined
      ? null
      : Boolean(Number(row.wan_nat_enabled))
  };
}

class ProvisioningProfile {
  static async getAll() {
    const rows = await getDb()('provisioning_profiles').orderBy([
      { column: 'priority', order: 'desc' },
      { column: 'name', order: 'asc' }
    ]);
    return rows.map(parseRow);
  }

  static async getEnabled() {
    const rows = await getDb()('provisioning_profiles')
      .where({ enabled: true })
      .orderBy([{ column: 'priority', order: 'desc' }, { column: 'name', order: 'asc' }]);
    return rows.map(parseRow);
  }

  static async getById(id) {
    return parseRow(await getDb()('provisioning_profiles').where({ id }).first());
  }

  static async getByName(name) {
    return parseRow(await getDb()('provisioning_profiles').where({ name }).first());
  }

  static async create(row) {
    const [id] = await getDb()('provisioning_profiles').insert(row);
    return this.getById(id);
  }

  static async update(id, patch) {
    await getDb()('provisioning_profiles')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  static async delete(id) {
    const affected = await getDb()('provisioning_profiles').where({ id }).del();
    return affected > 0;
  }

  static async count() {
    const [row] = await getDb()('provisioning_profiles').count({ total: '*' });
    return Number(row?.total ?? 0);
  }

  static async countEnabled() {
    const [row] = await getDb()('provisioning_profiles').where({ enabled: true }).count({ total: '*' });
    return Number(row?.total ?? 0);
  }
}

export { parseRow as parseProfileRow };
export default ProvisioningProfile;
