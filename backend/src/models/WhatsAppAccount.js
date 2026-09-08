import { getDb } from '../config/database.js';

/**
 * WhatsApp numbers connected through the Evolution API.
 *
 * Rows carry two encrypted secrets and neither ever leaves the server. Callers
 * that need to hand an account to the browser must go through
 * `whatsappConfigService.publicAccount()`, which builds the safe shape field by
 * field — the same reason `evolutionApi.readInstances()` does not spread the
 * server's response.
 */
class WhatsAppAccount {
  static async getAll() {
    return getDb()('whatsapp_accounts').orderBy([{ column: 'is_default', order: 'desc' }, { column: 'id' }]);
  }

  static async getById(id) {
    return (await getDb()('whatsapp_accounts').where({ id }).first()) || null;
  }

  /** The webhook resolves the account from the instance name in the payload. */
  static async getByName(name) {
    return (await getDb()('whatsapp_accounts').where({ name }).first()) || null;
  }

  /**
   * The number that should carry a given kind of traffic.
   *
   * Falls back to the default account, then to any connected one: a billing run
   * must not stop because nobody labelled a number "billing", but it also must
   * not silently use a disconnected one.
   */
  static async getForPurpose(purpose) {
    const db = getDb();
    const connected = { status: 'connected' };
    return (
      (await db('whatsapp_accounts').where({ ...connected, purpose }).orderBy('id').first())
      || (await db('whatsapp_accounts').where({ ...connected, is_default: true }).orderBy('id').first())
      || (await db('whatsapp_accounts').where(connected).orderBy('id').first())
      || null
    );
  }

  static async create(account) {
    const [id] = await getDb()('whatsapp_accounts').insert(account);
    return this.getById(id);
  }

  static async update(id, patch) {
    await getDb()('whatsapp_accounts')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  static async remove(id) {
    return getDb()('whatsapp_accounts').where({ id }).del();
  }

  /** Exactly one row may be the default; clearing the others is part of setting it. */
  static async setDefault(id) {
    const db = getDb();
    await db('whatsapp_accounts').update({ is_default: false, updated_at: new Date() });
    await db('whatsapp_accounts').where({ id }).update({ is_default: true, updated_at: new Date() });
    return this.getById(id);
  }
}

export default WhatsAppAccount;
