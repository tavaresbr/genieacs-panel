import AppState from '../models/AppState.js';
import DeviceService from './deviceService.js';
import ProvisioningService from './provisioningService.js';
import SgpEventService from './sgpEventService.js';
import SgpService from './sgpService.js';
import { forEachTenant } from '../config/tenantJobs.js';
import { currentTenantId } from '../config/tenantContext.js';
import AuditLog from '../models/AuditLog.js';
import AuthTicket from '../models/AuthTicket.js';
import ImpersonationTicket from '../models/ImpersonationTicket.js';
import { refreshDeploymentSharing } from './genieacsEgress.js';
import {
  dueForRefresh, isDormant, lastPanelActivityAt, refreshTtlMs, tenantOffsetMs
} from './dashboardSchedule.js';

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
   * O painel deste provedor, se for a hora dele.
   *
   * Era buscado do caminho da requisição: quem abrisse a tela com o cache
   * vencido pagava a busca da frota inteira do GenieACS. Aqui ela acontece
   * antes de alguém pedir — e, o que importa mais, **só para quem tem alguém
   * pedindo**. A regra de quem, quando e com que folga está inteira em
   * `dashboardSchedule.js`; o que este método acrescenta é que uma falha do
   * ACS de um provedor não derruba os outros jobs do tick dele.
   */
  static async refreshDashboard(state) {
    const atividade = await lastPanelActivityAt();
    // Ninguém entrou há um dia: não há tela aberta para manter quente, e o ACS
    // que seria consultado é o do provedor, não o nosso.
    if (isDormant(atividade)) return null;

    const ttlMs = refreshTtlMs(atividade);
    const due = dueForRefresh({
      lastRunAt: Date.parse(state.lastDashboardAt ?? ''),
      ttlMs,
      offsetMs: tenantOffsetMs(currentTenantId(), ttlMs)
    });
    if (!due) return null;

    try {
      await DeviceService.refreshDashboardData({ ttlMs });
    } catch (error) {
      // Marca a tentativa mesmo assim: sem isso um ACS fora do ar vira uma
      // tentativa por tick, que é o oposto do que este job existe para fazer.
      await this.writeState({ lastDashboardAt: new Date().toISOString() });
      console.warn(`Dashboard refresh failed: ${error.message}`);
      return { refreshed: false, ttlMs };
    }
    await this.writeState({ lastDashboardAt: new Date().toISOString() });
    return { refreshed: true, ttlMs };
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
    // Antes do laço, e a cada passada: a guarda de egresso pergunta "este
    // deployment serve mais de um provedor?" a uma variável de memória, e é
    // aqui que essa variável aprende. Uma passada por minuto é o atraso máximo
    // entre o provedor número dois nascer e a guarda apertar — contra o estado
    // anterior, em que ela dependia de alguém ter posto `EDITION=saas` no
    // `.env` e ficava larga para sempre quando ninguém pôs.
    this.tickPromise = refreshDeploymentSharing()
      .catch(() => {})
      .then(() => forEachTenant((tenant) => this.runJobs({ prune }), {
        onError: (error, tenant) => {
          console.warn(`Scheduler tick failed for provider ${tenant.slug}: ${error.message}`);
        }
      }))
      .then(() => (prune ? this.pruneTickets() : undefined))
      .finally(() => {
        this.tickPromise = null;
      });
    return this.tickPromise;
  }

  /**
   * As duas tabelas de bilhete, podadas FORA do laço por provedor.
   *
   * Fora, e não dentro, porque nenhuma das duas é escopada: um `forEachTenant`
   * as apagaria inteiras uma vez por provedor, e num deploy com trinta ISPs
   * isso é trinta varreduras idênticas por dia. Além disso o laço só visita
   * provedor `active` (`forEachTenant` filtra por `tenants.status`), então um
   * provedor suspenso nunca teria os bilhetes dele podados.
   *
   * Os dois `prune` existiam, testados, sem UM chamador — e o comentário de
   * `AuthTicket.create` já dizia "a poda os leva embora depois, pela idade",
   * o que era falso. Com o cadastro passando a cunhar um bilhete de
   * verificação, a falta deixou de ser teórica: a rota é pública, e toda
   * pessoa que apertar "cadastrar" deixa uma linha que nada apagaria.
   */
  static async pruneTickets() {
    await AuthTicket.prune().catch((error) => {
      console.warn(`Could not prune auth tickets: ${error.message}`);
    });
    await ImpersonationTicket.prune().catch((error) => {
      console.warn(`Could not prune impersonation tickets: ${error.message}`);
    });
  }

  static async runJobs({ prune = false } = {}) {
    const summary = { provisioning: null, events: null, reconcile: null, dashboard: null };
    const state = await this.readState();

    summary.dashboard = await this.refreshDashboard(state);

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
