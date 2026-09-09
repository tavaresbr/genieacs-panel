import { tdb, tinsert } from '../config/database.js';

class SgpLink {
  static async getByDeviceId(deviceId) {
    return (await tdb('sgp_links').where({ device_id: deviceId }).first()) || null;
  }

  static async getByAccountId(accountId) {
    return (await tdb('sgp_links').where({ account_id: accountId }).first()) || null;
  }

  static async upsert(link) {
    const now = new Date();
    // The conflict target is the composite unique, not `device_id` alone:
    // since 0017 the same device id exists once per provider, and two providers
    // reading one ACS do see the same ids. On MySQL the target is ignored
    // either way, so naming it wrongly is invisible there and fails loudly on
    // SQLite and Postgres.
    await tinsert('sgp_links', { ...link, updated_at: now })
      .onConflict(['tenant_id', 'device_id'])
      .merge({ ...link, updated_at: now });
    return this.getByDeviceId(link.device_id);
  }

  static async deleteByDeviceId(deviceId) {
    const affected = await tdb('sgp_links').where({ device_id: deviceId }).del();
    return affected > 0;
  }

  static async getByDeviceIds(deviceIds) {
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return [];
    return tdb('sgp_links').whereIn('device_id', deviceIds);
  }

  /** One contract can cover several CPEs, so an event fans out to all of them. */
  static async getByContract(contract) {
    if (!contract) return [];
    return tdb('sgp_links').where({ contract: String(contract) }).orderBy('id', 'asc');
  }

  /**
   * The operator's correction to a subscriber's number, written on every ONT
   * the contract covers.
   *
   * All of them, not just one: the reader collapses `sgp_links` to one
   * subscriber per contract and keeps whichever row sorts first by `device_id`,
   * so correcting a single row would leave the panel showing the old number
   * whenever a different ONT happened to sort ahead of it.
   *
   * `null` clears the override; nothing else in the row is touched, because
   * everything else in it belongs to the ERP.
   */
  static async setManualPhone(contract, phone) {
    return tdb('sgp_links')
      .where({ contract: String(contract) })
      .update({ phone_manual: phone, updated_at: new Date() });
  }

  /** Round-robin page used by reconciliation so no link is starved. */
  static async listAfterId(afterId = 0, limit = 25) {
    return tdb('sgp_links')
      .where('id', '>', Number(afterId) || 0)
      .orderBy('id', 'asc')
      .limit(Math.min(Math.max(Number(limit) || 25, 1), 200));
  }

  static async count() {
    const [row] = await tdb('sgp_links').count({ total: '*' });
    return Number(row?.total ?? 0);
  }

  static async getAll() {
    return tdb('sgp_links').orderBy('device_id', 'asc');
  }
}

export default SgpLink;
