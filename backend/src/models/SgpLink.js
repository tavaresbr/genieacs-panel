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

  static async getAll() {
    return getDb()('sgp_links').orderBy('device_id', 'asc');
  }
}

export default SgpLink;
