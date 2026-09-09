import { getDb } from '../config/database.js';

/**
 * The Wi-Fi credentials shown in the customer portal.
 *
 * `customer_wifi_credentials` has no `tenant_id`, and that is a decision rather
 * than an omission. Every query below is keyed by `account_id`, a surrogate id
 * from `customer_accounts` — a scoped table, so the id is globally unique and
 * only ever reaches here through a row the provider in scope already owns.
 * There is no lookup on a value a second provider could supply, and the unique
 * `(account_id, wifi_index)` cannot collide across providers either.
 *
 * That guarantee is in the shape of the queries, not in a constraint. A method
 * that reads without an `account_id` — a `listAll()`, a sweep over stale rows,
 * a report — breaks it silently and would need the column added first.
 */
class CustomerWifiCredential {
  static async getByAccountId(accountId) {
    return getDb()('customer_wifi_credentials')
      .where({ account_id: accountId })
      .orderBy('wifi_index');
  }

  static async getByAccountAndIndex(accountId, wifiIndex) {
    return (
      (await getDb()('customer_wifi_credentials')
        .where({ account_id: accountId, wifi_index: wifiIndex })
        .first()) || null
    );
  }

  static async upsert(record) {
    const db = getDb();
    await db('customer_wifi_credentials')
      .insert(record)
      .onConflict(['account_id', 'wifi_index'])
      .merge({
        ssid: record.ssid,
        password_ciphertext: record.password_ciphertext,
        password_iv: record.password_iv,
        password_tag: record.password_tag,
        // Must move with the ciphertext it describes: a stale version points
        // decryption at the wrong key and the password is gone.
        password_key_version: record.password_key_version ?? null,
        updated_at: new Date()
      });
    return this.getByAccountAndIndex(record.account_id, record.wifi_index);
  }

  static async updateSsid(accountId, wifiIndex, ssid) {
    return getDb()('customer_wifi_credentials')
      .where({ account_id: accountId, wifi_index: wifiIndex })
      .update({ ssid, updated_at: new Date() });
  }
}

export default CustomerWifiCredential;
