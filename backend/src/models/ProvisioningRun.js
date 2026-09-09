import { tdb, tinsertReturningId } from '../config/database.js';

/** Statuses a run can still move on from; a device with one is already busy. */
export const ACTIVE_STATUSES = Object.freeze(['pending', 'running', 'awaiting_verify']);

function parseRow(row) {
  if (!row) return null;
  let steps = [];
  if (row.steps) {
    try {
      const parsed = JSON.parse(row.steps);
      if (Array.isArray(parsed)) steps = parsed;
    } catch {
      steps = [];
    }
  }
  return { ...row, steps };
}

class ProvisioningRun {
  static async create(row) {
    const id = await tinsertReturningId('provisioning_runs', {
      ...row,
      steps: row.steps ? JSON.stringify(row.steps) : null
    });
    return this.getById(id);
  }

  static async update(id, patch) {
    const next = { ...patch, updated_at: new Date() };
    if (Object.hasOwn(next, 'steps')) {
      next.steps = next.steps ? JSON.stringify(next.steps) : null;
    }
    await tdb('provisioning_runs').where({ id }).update(next);
    return this.getById(id);
  }

  static async getById(id) {
    return parseRow(await tdb('provisioning_runs').where({ id }).first());
  }

  static async getLatestByDeviceId(deviceId) {
    return parseRow(
      await tdb('provisioning_runs')
        .where({ device_id: deviceId })
        .orderBy('id', 'desc')
        .first()
    );
  }

  static async listByDeviceId(deviceId, limit = 10) {
    const rows = await tdb('provisioning_runs')
      .where({ device_id: deviceId })
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 10, 1), 100));
    return rows.map(parseRow);
  }

  static async list({ deviceId = null, status = null, limit = 25 } = {}) {
    const query = tdb('provisioning_runs').orderBy('id', 'desc');
    if (deviceId) query.where({ device_id: deviceId });
    if (status) query.where({ status });
    const rows = await query.limit(Math.min(Math.max(Number(limit) || 25, 1), 200));
    return rows.map(parseRow);
  }

  static async getActiveByDeviceId(deviceId) {
    return parseRow(
      await tdb('provisioning_runs')
        .where({ device_id: deviceId })
        .whereIn('status', ACTIVE_STATUSES)
        .orderBy('id', 'desc')
        .first()
    );
  }

  /**
   * Runs whose next attempt (a first execution or a verification pass) is due.
   * The due time lives in the row rather than in a timer, so a restart resumes
   * exactly where the previous process stopped.
   */
  static async getDue(now, limit = 5) {
    const rows = await tdb('provisioning_runs')
      .whereIn('status', ['pending', 'awaiting_verify'])
      .where((builder) => builder.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))
      .orderBy('id', 'asc')
      .limit(Math.min(Math.max(Number(limit) || 5, 1), 50));
    return rows.map(parseRow);
  }

  static async hasSuccess(deviceId) {
    const row = await tdb('provisioning_runs')
      .where({ device_id: deviceId, status: 'success' })
      .first();
    return Boolean(row);
  }

  /** Device ids that are already provisioned or are not eligible for a retry yet. */
  static async settledDeviceIds(deviceIds, now) {
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return new Set();
    const rows = await tdb('provisioning_runs')
      .select('device_id', 'status', 'next_attempt_at')
      .whereIn('device_id', deviceIds)
      .whereIn('status', ['success', 'failed_permanent', 'failed', ...ACTIVE_STATUSES]);
    const settled = new Set();
    for (const row of rows) {
      if (['success', 'failed_permanent', ...ACTIVE_STATUSES].includes(row.status)) {
        settled.add(row.device_id);
        continue;
      }
      // A failed run only frees the device once its backoff window has passed.
      if (row.next_attempt_at && new Date(row.next_attempt_at) > now) settled.add(row.device_id);
    }
    return settled;
  }

  /**
   * A process that dies mid-run leaves a `running` row nothing would ever
   * finish. Failing it puts the device back into the normal backoff instead.
   */
  static async reapInterrupted(before) {
    return tdb('provisioning_runs')
      .where({ status: 'running' })
      .where('updated_at', '<', before)
      .update({
        status: 'failed',
        error: 'provisioning.error.interrupted',
        updated_at: new Date()
      });
  }

  static async pruneOlderThan(date) {
    return tdb('provisioning_runs')
      .whereIn('status', ['success', 'failed_permanent', 'skipped'])
      .where('updated_at', '<', date)
      .del();
  }
}

export default ProvisioningRun;
