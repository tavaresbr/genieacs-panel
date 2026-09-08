import { getDb } from '../config/database.js';

/** One thread with one contact on one connected number. */
class WaConversation {
  static async getById(id) {
    return (await getDb()('wa_conversations').where({ id }).first()) || null;
  }

  static async getByThread(accountId, externalThreadId) {
    return (
      (await getDb()('wa_conversations')
        .where({ account_id: accountId, external_thread_id: externalThreadId })
        .first()) || null
    );
  }

  /**
   * Finds or creates the thread an inbound event belongs to.
   *
   * `external_thread_id` is the key because it is what both server flavors send
   * back on every event; phone and LID are attributes of the contact that may
   * arrive later, or only one of the two ever.
   */
  static async ensure({ accountId, externalThreadId, waPhone, waLid, pushName }) {
    const existing = await this.getByThread(accountId, externalThreadId);
    const now = new Date();
    if (existing) {
      // Only fill gaps. A pushName the operator already corrected, or a phone
      // learned from a richer event, must not be overwritten by a later event
      // that happens to carry less.
      const patch = {};
      if (waPhone && !existing.wa_phone_e164) patch.wa_phone_e164 = waPhone;
      if (waLid && !existing.wa_lid) patch.wa_lid = waLid;
      if (pushName && !existing.push_name) patch.push_name = pushName;
      if (Object.keys(patch).length === 0) return existing;
      await getDb()('wa_conversations').where({ id: existing.id }).update({ ...patch, updated_at: now });
      return this.getById(existing.id);
    }
    const [id] = await getDb()('wa_conversations').insert({
      account_id: accountId,
      external_thread_id: externalThreadId,
      wa_phone_e164: waPhone || null,
      wa_lid: waLid || null,
      push_name: pushName || null,
      created_at: now,
      updated_at: now
    });
    return this.getById(id);
  }

  static async update(id, patch) {
    await getDb()('wa_conversations')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  static async listRecent({ limit = 50, offset = 0 } = {}) {
    return getDb()('wa_conversations')
      .orderBy('last_message_at', 'desc')
      .limit(limit)
      .offset(offset);
  }
}

export default WaConversation;
