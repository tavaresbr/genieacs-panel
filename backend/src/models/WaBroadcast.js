import { getDb, tbatchInsert, tdb, tinsertReturningId } from '../config/database.js';

/** How long a recipient may sit in 'sending' before another tick may retake it. */
export const RECLAIM_MS = 5 * 60 * 1000;

/** Attempts one recipient gets before the campaign gives up on it. */
export const MAX_ATTEMPTS = 3;

/**
 * A campaign and the people it is addressed to.
 *
 * `wa_broadcast_recipients` is a work queue with the same shape as the outbox:
 * a row walks pending → sending → sent, or → skipped / failed. It is a separate
 * table from `wa_messages` because the two answer different questions — the
 * outbox knows whether WhatsApp accepted a message, the campaign knows whether
 * a subscriber was contacted at all, and a recipient dropped for an opt-out
 * never becomes a message.
 *
 * 'sent' here means "handed to the outbox", which is as far as the campaign's
 * responsibility reaches; `message_id` points at the row that carries the real
 * delivery state.
 */
class WaBroadcast {
  static async getById(id) {
    return (await tdb('wa_broadcasts').where({ id }).first()) || null;
  }

  static async list({ limit = 100 } = {}) {
    return tdb('wa_broadcasts').orderBy('id', 'desc').limit(limit);
  }

  static async listByStatus(status) {
    return tdb('wa_broadcasts').where({ status }).orderBy('id');
  }

  static async create(broadcast) {
    const now = new Date();
    const id = await tinsertReturningId('wa_broadcasts', {
      ...broadcast,
      created_at: now,
      updated_at: now
    });
    return this.getById(id);
  }

  static async update(id, patch) {
    await tdb('wa_broadcasts')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  /**
   * Writes the recipient list.
   *
   * Chunked because a campaign can carry 300 rows and SQLite has a hard ceiling
   * on bound parameters per statement.
   */
  static async addRecipients(broadcastId, recipients) {
    if (!Array.isArray(recipients) || recipients.length === 0) return 0;
    const now = new Date();
    const rows = recipients.map((recipient) => ({
      broadcast_id: broadcastId,
      phone_e164: recipient.phone,
      contract: recipient.contract || null,
      client_name: recipient.clientName || null,
      rendered_body: recipient.body,
      status: 'pending',
      created_at: now
    }));
    await tbatchInsert('wa_broadcast_recipients', rows, 50);
    return rows.length;
  }

  static async listRecipients(broadcastId) {
    return tdb('wa_broadcast_recipients')
      .where({ broadcast_id: broadcastId })
      .orderBy('id');
  }

  /** Ids the flush loop should try next for one campaign, oldest first. */
  static async listPendingIds(broadcastId, limit) {
    const cutoff = new Date(Date.now() - RECLAIM_MS);
    return tdb('wa_broadcast_recipients')
      .where({ broadcast_id: broadcastId })
      .where((q) => {
        q.where({ status: 'pending' })
          // A tick that died mid-send leaves a row in 'sending' forever.
          // Retaking it is what makes a crash recoverable. The age is measured
          // from `created_at` because this table has no claim timestamp of its
          // own — which is safe here only because the window between a claim
          // and its outcome is a single enqueue: a row that reached the outbox
          // is already 'sent' by the time the next tick looks.
          .orWhere((stale) => stale.where({ status: 'sending' }).where('created_at', '<', cutoff));
      })
      .orderBy('id')
      .limit(limit)
      .pluck('id');
  }

  /**
   * Takes ownership of one recipient, or reports that someone else already has.
   *
   * A conditional UPDATE checked by affected-row count, exactly like
   * `WaMessage.claim()`: SQLite has no `SKIP LOCKED`, and the repeated WHERE is
   * what stops two overlapping ticks from both contacting the same subscriber.
   */
  static async claimRecipient(id) {
    const cutoff = new Date(Date.now() - RECLAIM_MS);
    const changed = await tdb('wa_broadcast_recipients')
      .where({ id })
      .where((q) => {
        q.where({ status: 'pending' })
          .orWhere((stale) => stale.where({ status: 'sending' }).where('created_at', '<', cutoff));
      })
      .update({
        status: 'sending',
        attempts: getDb().raw('attempts + 1')
      });
    return changed > 0 ? this.getRecipient(id) : null;
  }

  static async getRecipient(id) {
    return (await tdb('wa_broadcast_recipients').where({ id }).first()) || null;
  }

  static async updateRecipient(id, patch) {
    await tdb('wa_broadcast_recipients').where({ id }).update(patch);
    return this.getRecipient(id);
  }

  /**
   * Recipients still owed an attempt.
   *
   * Counts 'sending' as well as 'pending': a row another tick is holding is not
   * finished, and calling the campaign done while one is in flight would close
   * it a message short.
   */
  static async countUnfinished(broadcastId) {
    const [row] = await tdb('wa_broadcast_recipients')
      .where({ broadcast_id: broadcastId })
      .whereIn('status', ['pending', 'sending'])
      .count({ total: '*' });
    return Number(row?.total ?? 0);
  }

  /** Totals for the campaign header, recomputed from the recipient rows. */
  static async tally(broadcastId) {
    const rows = await tdb('wa_broadcast_recipients')
      .where({ broadcast_id: broadcastId })
      .select('status')
      .count({ total: '*' })
      .groupBy('status');
    const counts = {};
    for (const row of rows) counts[row.status] = Number(row.total ?? 0);
    return {
      sent: counts.sent ?? 0,
      // A skip is a failure to reach someone as far as the header is concerned:
      // the operator needs one number for "did not arrive", and the per-row
      // `error_msg` says which of the two it was.
      failed: (counts.failed ?? 0) + (counts.skipped ?? 0)
    };
  }
}

export default WaBroadcast;
