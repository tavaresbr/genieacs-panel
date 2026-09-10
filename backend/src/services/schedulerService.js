import AppState from '../models/AppState.js';
import ProvisioningService from './provisioningService.js';
import SgpEventService from './sgpEventService.js';
import SgpService from './sgpService.js';
import { forEachTenant } from '../config/tenantJobs.js';
import AuditLog from '../models/AuditLog.js';

const STATE_KEY = 'scheduler_state';
const BASE_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 24 * 3600_000;
const AUDIT_RETENTION_MS = 365 * 24 * 3600_000;

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
  static tickPromise = null;
  static lastPruneAt = 0;

  static async start() {
    if (this.timer) return this.timer;
    // A process that died mid-run leaves rows nothing would ever finish.
    //
    // Per provider, like the tick below. It reaches `provisioning_runs` and
    // nothing else, so the loop divides the work rather than repeating it.
    await forEachTenant(() => ProvisioningService.reapInterrupted(), {
      onError: (error, tenant) => {
        console.warn(`Could not reap interrupted provisioning runs for ${tenant.slug}: ${error.message}`);
      }
    }).catch((error) => {
      console.warn(`Could not reap interrupted provisioning runs: ${error.message}`);
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
   * One pass over every job. Overlapping ticks collapse onto the running one.
   *
   * The scope is opened here, per tick, and not once around `start()`. A scope
   * taken at boot would be captured by the interval and held for the life of
   * the process, so a provider added afterwards would never be visited at all.
   *
   * Per provider since `provisioning_runs` and `sgp_events` were scoped: every
   * driving query now filters by the provider in scope, so the loop divides
   * the work instead of repeating it. Each provider's own schedule comes from
   * its own `app_state` row, which is what makes that true of the CADENCE and
   * not only of the rows — a provider that reconciles hourly no longer drags
   * one that reconciles daily.
   *
   * One provider failing does not stop the others: a broken ERP integration at
   * one ISP must not be why every other ISP's queue stops draining.
   *
   * The daily prune is decided ONCE per tick, above the loop, and handed down.
   * `lastPruneAt` is a counter on this class rather than a row, so inside the
   * loop the first provider would set it and every provider after it would
   * skip its own prune — for that whole day, every day. The cadence is the
   * deployment's; the rows each pass deletes are the provider's.
   */
  static async tick() {
    if (this.tickPromise) return this.tickPromise;
    const prune = Date.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS;
    if (prune) this.lastPruneAt = Date.now();
    this.tickPromise = forEachTenant((tenant) => this.runJobs({ prune }), {
      onError: (error, tenant) => {
        console.warn(`Scheduler tick failed for provider ${tenant.slug}: ${error.message}`);
      }
    }).finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  static async runJobs({ prune = false } = {}) {
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

    if (prune) {
      // Both tables grow with every activation and every delivery, so a busy
      // install would otherwise fill its database. Whether today is a prune day
      // was decided by `tick`; what gets deleted is this provider's own, by its
      // own retention setting.
      await ProvisioningService.prune().catch((error) => {
        console.warn(`Could not prune provisioning runs: ${error.message}`);
      });
      await SgpEventService.prune().catch((error) => {
        console.warn(`Could not prune SGP events: ${error.message}`);
      });
      // A trilha de auditoria, um ano. Um ano e não "para sempre" porque a
      // trilha guarda dado pessoal — qual assinante, qual contrato, qual
      // operador — e guardar sem prazo é o que a LGPD chama de excesso; e não
      // menos porque a pergunta que uma trilha responde ("quem mexeu nisso?")
      // costuma chegar meses depois do fato, não dias.
      await AuditLog.prune(new Date(Date.now() - AUDIT_RETENTION_MS)).catch((error) => {
        console.warn(`Could not prune the audit log: ${error.message}`);
      });
    }

    return summary;
  }
}

export default SchedulerService;
