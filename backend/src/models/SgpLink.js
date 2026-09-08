import { getDb } from '../config/database.js';

class SgpLink {
  static async getByDeviceId(deviceId) {
    return (await getDb()('sgp_links').where({ device_id: deviceId }).first()) || null;
  }

  static async getByAccountId(accountId) {
    return (await getDb()('sgp_links').where({ account_id: accountId }).first()) || null;
  }

  static async upsert(link) {
    const now = new Date();
    await getDb()('sgp_links')
      .insert({ ...link, updated_at: now })
      .onConflict('device_id')
      .merge({ ...link, updated_at: now });
    return this.getByDeviceId(link.device_id);
  }

  static async deleteByDeviceId(deviceId) {
    const affected = await getDb()('sgp_links').where({ device_id: deviceId }).del();
    return affected > 0;
  }

  static async getByDeviceIds(deviceIds) {
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return [];
    return getDb()('sgp_links').whereIn('device_id', deviceIds);
  }

  /** One contract can cover several CPEs, so an event fans out to all of them. */
  static async getByContract(contract) {
    if (!contract) return [];
    return getDb()('sgp_links').where({ contract: String(contract) }).orderBy('id', 'asc');
  }

  /** Round-robin page used by reconciliation so no link is starved. */
  static async listAfterId(afterId = 0, limit = 25) {
    return getDb()('sgp_links')
      .where('id', '>', Number(afterId) || 0)
      .orderBy('id', 'asc')
      .limit(Math.min(Math.max(Number(limit) || 25, 1), 200));
  }

  static async count() {
    const [row] = await getDb()('sgp_links').count({ total: '*' });
    return Number(row?.total ?? 0);
  }
}

export default SgpLink;
