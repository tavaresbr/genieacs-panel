import { getDb } from '../config/database.js';

/** Event view for the API. */
export function publicEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    source: event.source,
    type: event.type,
    rawType: event.raw_type,
    contract: event.contract,
    document: event.document,
    login: event.login,
    deviceId: event.device_id,
    status: event.status,
    attempts: event.attempts,
    payload: event.payload,
    error: event.error,
    occurredAt: event.occurred_at ? new Date(event.occurred_at).toISOString() : null,
    receivedAt: event.received_at ? new Date(event.received_at).toISOString() : null,
    processedAt: event.processed_at ? new Date(event.processed_at).toISOString() : null
  };
}

class SgpEvent {
  /**
   * Inserts an event unless its dedupe key is already stored. A redelivered
   * webhook must be answered with success rather than an error, or the sender
   * keeps retrying, so the caller needs to know whether the row is new.
   */
  static async insertIfNew(row) {
    const existing = await this.getByDedupeKey(row.dedupe_key);
    if (existing) return { created: false, event: existing };
    try {
      await getDb()('sgp_events').insert(row);
    } catch (error) {
      // Two deliveries of the same event in flight at once: the unique index
      // decides, and the loser reports the row the winner stored. The return
      // value of `onConflict().ignore()` cannot be used for this, since SQLite
      // and MySQL disagree on what it reports for an ignored insert.
      const stored = await this.getByDedupeKey(row.dedupe_key);
      if (!stored) throw error;
      return { created: false, event: stored };
    }
    return { created: true, event: await this.getByDedupeKey(row.dedupe_key) };
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
