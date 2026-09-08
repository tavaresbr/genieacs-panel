import { getDb } from '../config/database.js';

class SgpEvent {
  /**
   * Inserts an event unless its dedupe key is already stored. A redelivered
   * webhook must be answered with success rather than an error, or the sender
   * keeps retrying, so the caller needs to know whether the row is new.
   */
  static async insertIfNew(row) {
    const inserted = await getDb()('sgp_events')
      .insert(row)
      .onConflict('dedupe_key')
      .ignore();
    const stored = await this.getByDedupeKey(row.dedupe_key);
    const affected = Array.isArray(inserted) ? inserted.filter(Boolean).length : Number(inserted || 0);
    return { created: affected > 0, event: stored };
  }

  static async getById(id) {
    return (await getDb()('sgp_events').where({ id }).first()) || null;
  }

  static async getByDedupeKey(dedupeKey) {
    return (await getDb()('sgp_events').where({ dedupe_key: dedupeKey }).first()) || null;
  }

  static async list({ status = null, type = null, contract = null, limit = 25 } = {}) {
    const query = getDb()('sgp_events').orderBy('id', 'desc');
    if (status) query.where({ status });
    if (type) query.where({ type });
    if (contract) query.where({ contract });
    return query.limit(Math.min(Math.max(Number(limit) || 25, 1), 200));
  }

  static async getPending(limit = 20) {
    return getDb()('sgp_events')
      .where({ status: 'pending' })
      .orderBy('id', 'asc')
      .limit(Math.min(Math.max(Number(limit) || 20, 1), 100));
  }

  static async update(id, patch) {
    await getDb()('sgp_events').where({ id }).update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  static async countByStatus() {
    const rows = await getDb()('sgp_events').select('status').count({ total: '*' }).groupBy('status');
    return rows.reduce((acc, row) => ({ ...acc, [row.status]: Number(row.total) }), {});
  }

  static async pruneOlderThan(date) {
    return getDb()('sgp_events')
      .whereIn('status', ['processed', 'ignored'])
      .where('updated_at', '<', date)
      .del();
  }
}

export default SgpEvent;
