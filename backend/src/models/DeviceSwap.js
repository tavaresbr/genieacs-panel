import { tdb, tinsertReturningId } from '../config/database.js';
import { timestampMs } from '../utils/helpers.js';

/** Row view for the API. */
export function publicSwap(swap) {
  if (!swap) return null;
  return {
    id: swap.id,
    customerId: swap.customer_id,
    pppoeUsername: swap.pppoe_username,
    previousDeviceId: swap.previous_device_id,
    deviceId: swap.device_id,
    contract: swap.contract,
    matchedBy: swap.matched_by,
    linkAction: swap.link_action,
    flapping: Boolean(swap.flapping),
    repeatCount: Number(swap.repeat_count ?? 1),
    occurredAt: swap.occurred_at ? new Date(timestampMs(swap.occurred_at)).toISOString() : null,
    acknowledgedAt: swap.acknowledged_at
      ? new Date(timestampMs(swap.acknowledged_at)).toISOString()
      : null
  };
}

class DeviceSwap {
  /** One direction of a pair: the row written when `previous` was replaced by `next`. */
  static async getPair(previousDeviceId, deviceId) {
    return (await tdb('device_swaps')
      .where({ previous_device_id: previousDeviceId, device_id: deviceId })
      .first()) || null;
  }

  static async getById(id) {
    return (await tdb('device_swaps').where({ id }).first()) || null;
  }

  /**
   * Writes the pair, or folds the repeat into the row already describing it.
   *
   * Read-then-write rather than `onConflict().ignore()`, for the reason
   * `SgpEvent.insertIfNew` gives: the drivers disagree on what an ignored
   * insert reports, so the return value cannot be used to tell a fresh row from
   * a swallowed one. The unique index still decides a race, and the loser reads
   * back what the winner stored.
   */
  static async record(row) {
    const existing = await this.getPair(row.previous_device_id, row.device_id);
    if (existing) return this.repeat(existing, row);
    try {
      const id = await tinsertReturningId('device_swaps', row);
      return { created: true, swap: await this.getById(id) };
    } catch (error) {
      const stored = await this.getPair(row.previous_device_id, row.device_id);
      if (!stored) throw error;
      return { created: false, swap: await this.repeat(stored, row).then((r) => r.swap) };
    }
  }

  /**
   * The same replacement happening again.
   *
   * `acknowledged_at` is cleared: a swap the operator dismissed and that then
   * repeated is news again, and it is the repeat that says the pair is unstable
   * rather than a one-off install.
   */
  static async repeat(existing, row) {
    const now = new Date();
    await tdb('device_swaps').where({ id: existing.id }).update({
      matched_by: row.matched_by,
      link_action: row.link_action,
      flapping: row.flapping,
      contract: row.contract ?? existing.contract,
      customer_id: row.customer_id ?? existing.customer_id,
      account_id: row.account_id ?? existing.account_id,
      repeat_count: Number(existing.repeat_count ?? 1) + 1,
      occurred_at: row.occurred_at ?? now,
      acknowledged_at: null,
      acknowledged_by: null,
      updated_at: now
    });
    return { created: false, swap: await this.getById(existing.id) };
  }

  /** Marks a pair unstable without touching anything else about it. */
  static async markFlapping(id) {
    await tdb('device_swaps').where({ id }).update({ flapping: true, updated_at: new Date() });
  }

  static async listOpen(limit = 25) {
    return tdb('device_swaps')
      .whereNull('acknowledged_at')
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 25, 1), 200));
  }

  /** Every swap this device took part in, whichever end of it. */
  static async listForDevice(deviceId, limit = 10) {
    return tdb('device_swaps')
      .where({ device_id: deviceId })
      .orWhere({ previous_device_id: deviceId })
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 10, 1), 100));
  }

  static async countOpen() {
    const [row] = await tdb('device_swaps').whereNull('acknowledged_at').count({ total: '*' });
    return Number(row?.total ?? 0);
  }

  static async acknowledge(id, userId = null) {
    await tdb('device_swaps').where({ id }).update({
      acknowledged_at: new Date(),
      acknowledged_by: userId,
      updated_at: new Date()
    });
    return this.getById(id);
  }
}

export default DeviceSwap;
