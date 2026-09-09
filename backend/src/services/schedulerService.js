import AppState from '../models/AppState.js';
import ProvisioningService from './provisioningService.js';
import SgpEventService from './sgpEventService.js';
import SgpService from './sgpService.js';
import { forEachTenant } from '../config/tenantJobs.js';
import { currentTenantId } from '../config/tenantContext.js';

const STATE_KEY = 'scheduler_state';
const BASE_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 24 * 3600_000;

/**
 * The panel's only background worker.
 *
 * One unref'd interval drives every periodic job, and each job decides for
 * itself whether it is due from a timestamp persisted in `app_state`. That is
 * deliberate: the enabled flags are read inside the tick rather than used to
 * start and stop timers, so a Settings toggle takes effect within a minute
 * without a lifecycle to keep in sync, and a restart resumes from the stored
 * timestamps instead of from a blank slate.
 *
 * It is started from `server.js` only, never as an import side effect of
 * `app.js`, so the test suite never has a timer running behind it.
 */
class SchedulerService {
  static timer = null;
  // Both keyed by provider. A single promise would hand the second provider's
  // tick the first provider's result, and a single `lastPruneAt` would let the
  // first provider's prune suppress everyone else's for a day.
  static tickPromises = new Map();
  static lastPruneAt = new Map();

  static async start() {
    if (this.timer) return this.timer;
    // A process that died mid-run leaves rows nothing would ever finish.
    await forEachTenant(() => ProvisioningService.reapInterrupted(), {
      onError: (error, tenant) => {
        console.warn(`Could not reap interrupted provisioning runs for ${tenant.slug}: ${error.message}`);
      }
    });
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.warn(`Scheduler tick failed: ${error.message}`);
      });
    }, BASE_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  static async readState() {
    const raw = await AppState.get(STATE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }

  static async writeState(patch) {
    const state = await this.readState();
    await AppState.upsert(STATE_KEY, JSON.stringify({ ...state, ...patch }));
  }

  static due(lastRunAt, intervalMs) {
    if (!lastRunAt) return true;
    const last = Date.parse(lastRunAt);
    return !Number.isFinite(last) || Date.now() - last >= intervalMs;
  }

  /**
   * One pass over every job, for every provider. Overlapping ticks collapse
   * onto the running one, per provider.
   *
   * The scope is opened here, per tick, and not once around `start()`. A scope
   * taken at boot would be captured by the interval and held for the life of
   * the process, so a provider added afterwards would never be seen.
   *
   * Each provider's pass reads its own runs, its own pending events and its own
   * SGP credentials, so the loop divides the work instead of repeating it. One
   * provider's broken SGP does not stop the others: `forEachTenant` logs and
   * moves on.
   */
  static async tick() {
    return forEachTenant(() => this.tickForTenant());
  }

  /** One provider's pass, collapsing onto its own running one. */
  static async tickForTenant() {
    const tenant = currentTenantId();
    const running = this.tickPromises.get(tenant);
    if (running) return running;

    const work = this.runJobs().finally(() => {
      if (this.tickPromises.get(tenant) === work) this.tickPromises.delete(tenant);
    });
    this.tickPromises.set(tenant, work);
    return work;
  }

  static async runJobs() {
    const summary = { provisioning: null, events: null, reconcile: null };
    const state = await this.readState();

    const provisioningConfig = await ProvisioningService.getConfig();
    if (
      provisioningConfig.enabled
      && this.due(state.lastProvisioningAt, provisioningConfig.intervalSeconds * 1000)
    ) {
      summary.provisioning = await ProvisioningService.processDue({});
      await this.writeState({ lastProvisioningAt: new Date().toISOString() });
    }

    const sgpConfig = await SgpService.getConfig();
    if (SgpService.isReady(sgpConfig)) {
      // Pending events are drained every tick regardless of the reconciliation
      // schedule: a webhook that arrived while the panel was busy should not
      // wait for the next reconciliation window.
      summary.events = await SgpEventService.processPending({ limit: 20 });

      if (
        sgpConfig.reconcileEnabled
        && this.due(state.lastReconcileAt, sgpConfig.reconcileIntervalMinutes * 60_000)
      ) {
        summary.reconcile = await SgpEventService.reconcile({});
        await this.writeState({ lastReconcileAt: new Date().toISOString() });
      }
    }

    if (Date.now() - (this.lastPruneAt.get(currentTenantId()) ?? 0) >= PRUNE_INTERVAL_MS) {
      this.lastPruneAt.set(currentTenantId(), Date.now());
      // Both tables grow with every activation and every delivery, so a busy
      // install would otherwise fill its database.
      await ProvisioningService.prune().catch((error) => {
        console.warn(`Could not prune provisioning runs: ${error.message}`);
      });
      await SgpEventService.prune().catch((error) => {
        console.warn(`Could not prune SGP events: ${error.message}`);
      });
    }

    return summary;
  }
}

export default SchedulerService;
