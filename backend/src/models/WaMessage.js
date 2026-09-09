import { getDb, tdb, tinsertReturningId } from '../config/database.js';

/** How long a message may sit in 'sending' before another pass may retake it. */
export const RECLAIM_MS = 5 * 60 * 1000;

/**
 * What the outbox may take, as one WHERE both the listing and the claim use.
 *
 * A queued row is only sendable once its backoff has run out. `next_attempt_at`
 * NULL means due now, and it has to: the column arrived in migration 0018 with
 * every existing row already written, so any other reading would strand an
 * install's whole queue the moment it upgraded. The index behind this test is
 * `(delivery_status, next_attempt_at)`, added by the same migration.
 *
 * The stale branch deliberately ignores the due time. A row stuck in 'sending'
 * is a pass that died mid-send, not a backoff: retaking it after the cutoff is
 * what makes a crash recoverable, and making that wait on a due time written by
 * an earlier failure would leave the row untouchable for as long as the backoff
 * had grown.
 */
function sendable(query, now) {
  const cutoff = new Date(now.getTime() - RECLAIM_MS);
  return query
    .where((ready) => ready
      .where({ delivery_status: 'queued' })
      .where((due) => due.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now)))
    .orWhere((stale) => stale
      .where({ delivery_status: 'sending' })
      .where('claimed_at', '<', cutoff));
}

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

  /**
   * Puts a failed message back in the queue, as itself.
   *
   * The screen's old "resend" was not this: it read the row's `body` and sent a
   * NEW message, which left the failed row sitting there and produced a second
   * one — and it did nothing at all for a message whose content was an
   * attachment, because there was no body to read. Requeuing the row keeps its
   * attachment, its `source`, its place in the thread and its id, so a
   * subscriber sees one message rather than a duplicate every time a send is
   * retried.
   *
   * `attempts` goes back to zero and `next_attempt_at` to NULL, which means due
   * now: an operator pressing this has decided the reason for the failure is
   * over, and making them wait out a backoff computed from attempts that are no
   * longer relevant would be the panel arguing with them.
   *
   * Only a `failed` row is eligible, and the WHERE says so rather than the
   * caller: requeuing a `sent` row would send a subscriber the same message
   * twice, and requeuing a `queued` one would reset a backoff that is doing its
   * job. The affected-row count is the answer, so two operators pressing at
   * once cannot both win.
   *
   * @returns {Promise<object|null>} the requeued row, or null when not eligible
   */
  static async requeue(id) {
    const changed = await tdb('wa_messages')
      .where({ id, delivery_status: 'failed' })
      .update({
        delivery_status: 'queued',
        delivery_error: null,
        claimed_at: null,
        attempts: 0,
        next_attempt_at: null,
        updated_at: new Date()
      });
    return changed > 0 ? this.getById(id) : null;
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
    const now = new Date();
    return tdb('wa_messages')
      .whereNull('external_id')
      .where((q) => sendable(q, now))
      .orderBy('created_at')
      .limit(limit)
      .pluck('id');
  }

  /**
   * Takes ownership of one message, or reports that someone else already has it.
   *
   * This is a conditional UPDATE checked by affected-row count rather than
   * `SELECT ... FOR UPDATE SKIP LOCKED`, because SQLite has no such clause. The
   * WHERE repeats the eligibility test — the same `sendable` predicate the
   * listing uses — so two concurrent passes cannot both win: whoever's UPDATE
   * lands first changes the status, and the loser's UPDATE matches zero rows.
   * Repeating the due time in it also means a row that came due between the
   * listing and the claim is the only kind that can slip through, which is a
   * message sent on time rather than one sent early.
   *
   * @returns {Promise<object|null>} the claimed row, or null when not claimable
   */
  static async claim(id) {
    const now = new Date();
    const changed = await tdb('wa_messages')
      .where({ id })
      .whereNull('external_id')
      .where((q) => sendable(q, now))
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
