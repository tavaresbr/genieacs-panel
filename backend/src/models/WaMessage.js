import { getDb, tdb, tinsertReturningId } from '../config/database.js';

/** How long a message may sit in 'sending' before another pass may retake it. */
export const RECLAIM_MS = 5 * 60 * 1000;

/**
 * `wa_messages` is the outbox. There is no separate queue table: an outbound
 * message is a row whose `delivery_status` walks
 * queued → sending → sent → delivered → read, or → failed.
 */
class WaMessage {
  static async getById(id) {
    return (await tdb('wa_messages').where({ id }).first()) || null;
  }

  static async getByExternalId(externalId) {
    return (await tdb('wa_messages').where({ external_id: externalId }).first()) || null;
  }

  /**
   * One page of a thread, newest first.
   *
   * `before` is a keyset cursor — the id of the oldest row the caller already
   * has — and not an offset. This table grows while it is being read: a
   * customer answering mid-scroll shifts every offset by one, so an offset
   * page would repeat a message or skip one, and the operator would never know
   * which. A cursor on the id cannot move.
   *
   * Ordered by `id` rather than `created_at` for the same reason: two rows can
   * share a timestamp, and a tie makes the page boundary arbitrary. Insertion
   * order is arrival order here — `created_at` is when the panel received the
   * message, not when the sender typed it.
   */
  static async listForConversation(conversationId, { limit = 100, before = null } = {}) {
    const query = tdb('wa_messages')
      .where({ conversation_id: conversationId })
      .orderBy('id', 'desc')
      .limit(limit);
    if (Number.isInteger(before) && before > 0) query.where('id', '<', before);
    return query;
  }

  static async create(message) {
    const id = await tinsertReturningId('wa_messages', message);
    return this.getById(id);
  }

  static async update(id, patch) {
    await tdb('wa_messages')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  /** Ids the outbox worker should try next, oldest first. */
  static async listSendable(limit) {
    const cutoff = new Date(Date.now() - RECLAIM_MS);
    return tdb('wa_messages')
      .whereNull('external_id')
      .where((q) => {
        q.where({ delivery_status: 'queued' })
          // A pass that died mid-send leaves a row in 'sending' forever.
          // Retaking it after the cutoff is what makes a crash recoverable.
          .orWhere((stale) => stale.where({ delivery_status: 'sending' }).where('claimed_at', '<', cutoff));
      })
      .orderBy('created_at')
      .limit(limit)
      .pluck('id');
  }

  /**
   * Takes ownership of one message, or reports that someone else already has it.
   *
   * This is a conditional UPDATE checked by affected-row count rather than
   * `SELECT ... FOR UPDATE SKIP LOCKED`, because SQLite has no such clause. The
   * WHERE repeats the eligibility test so two concurrent passes cannot both
   * win: whoever's UPDATE lands first changes the status, and the loser's UPDATE
   * matches zero rows.
   *
   * @returns {Promise<object|null>} the claimed row, or null when not claimable
   */
  static async claim(id) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - RECLAIM_MS);
    const changed = await tdb('wa_messages')
      .where({ id })
      .whereNull('external_id')
      .where((q) => {
        q.where({ delivery_status: 'queued' })
          .orWhere((stale) => stale.where({ delivery_status: 'sending' }).where('claimed_at', '<', cutoff));
      })
      .update({
        delivery_status: 'sending',
        claimed_at: now,
        attempts: getDb().raw('attempts + 1'),
        updated_at: now
      });
    return changed > 0 ? this.getById(id) : null;
  }

  /**
   * Applies a delivery receipt.
   *
   * Never walks the status backwards: a 'delivered' event arriving after 'read'
   * (the two can cross on the wire) must not turn the blue ticks grey again.
   */
  static async applyReceipt(externalIds, status) {
    const rank = { sent: 1, delivered: 2, read: 3 };
    const weaker = Object.keys(rank).filter((s) => rank[s] < rank[status]);
    const patch = { delivery_status: status, updated_at: new Date() };
    if (status === 'read') patch.read_at = new Date();
    return tdb('wa_messages')
      .whereIn('external_id', externalIds)
      .whereIn('delivery_status', ['sending', ...weaker])
      .update(patch);
  }
}

export default WaMessage;
