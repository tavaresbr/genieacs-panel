import { getDb } from '../config/database.js';

class CustomerAccount {
  static async getAll() {
    return getDb()('customer_accounts').orderBy('created_at', 'desc');
  }

  static async getById(id) {
    return (await getDb()('customer_accounts').where({ id }).first()) || null;
  }

  static async getByCustomerId(customerId) {
    return (
      (await getDb()('customer_accounts')
        .where({ customer_id: customerId, active: true })
        .first()) || null
    );
  }

  static async getByDeviceId(deviceId) {
    return (await getDb()('customer_accounts').where({ device_id: deviceId }).first()) || null;
  }

  static async getByPppoeUsername(pppoeUsername) {
    if (!pppoeUsername) return null;
    return (
      (await getDb()('customer_accounts')
        .where({ pppoe_username: pppoeUsername })
        .orderBy('id', 'desc')
        .first()) || null
    );
  }

  static async getByIdentityHash(identityHash) {
    return (
      (await getDb()('customer_accounts').where({ identity_hash: identityHash }).first()) || null
    );
  }

  static async create(account) {
    const [id] = await getDb()('customer_accounts').insert(account);
    return this.getById(id);
  }

  static async touch(id, deviceId) {
    await getDb()('customer_accounts').where({ id }).update({
      device_id: deviceId,
      last_seen_at: new Date(),
      updated_at: new Date()
    });
    return this.getById(id);
  }

  static async updatePassword(id, record) {
    await getDb()('customer_accounts').where({ id }).update({
      ...record,
      updated_at: new Date()
    });
    return this.getById(id);
  }

  static async getWithoutPassword(limit = 25) {
    return getDb()('customer_accounts')
      .select('id')
      .whereNull('password_hash')
      .orderBy('id', 'asc')
      .limit(limit);
  }

  static async countWithoutPassword() {
    const row = await getDb()('customer_accounts')
      .whereNull('password_hash')
      .count({ n: '*' })
      .first();
    return Number(row?.n || 0);
  }

  static async getIdsByDeviceIds(deviceIds) {
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return [];
    return getDb()('customer_accounts')
      .select('device_id', 'customer_id')
      .whereIn('device_id', deviceIds);
  }

  static async getSyncTargets() {
    return getDb()('customer_accounts')
      .select('id', 'device_id', 'customer_id', 'pppoe_username')
      .whereNotNull('device_id')
      .orderBy('id', 'asc');
  }

  static async getExistingForIdentities(deviceIds, identityHashes) {
    const normalizedDeviceIds = Array.isArray(deviceIds) ? deviceIds.filter(Boolean) : [];
    const normalizedIdentityHashes = Array.isArray(identityHashes) ? identityHashes.filter(Boolean) : [];
    if (normalizedDeviceIds.length === 0 && normalizedIdentityHashes.length === 0) return [];

    return getDb()('customer_accounts')
      .select('id', 'device_id', 'identity_hash', 'customer_id')
      .where((query) => {
        if (normalizedDeviceIds.length > 0) {
          query.whereIn('device_id', normalizedDeviceIds);
        }
        if (normalizedIdentityHashes.length > 0) {
          const method = normalizedDeviceIds.length > 0 ? 'orWhereIn' : 'whereIn';
          query[method]('identity_hash', normalizedIdentityHashes);
        }
      });
  }
}

export default CustomerAccount;
