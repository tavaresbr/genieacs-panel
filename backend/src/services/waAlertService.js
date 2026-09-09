import AppState from '../models/AppState.js';
import MappingEdge from '../models/MappingEdge.js';
import MappingNode from '../models/MappingNode.js';
import WaAlertState from '../models/WaAlertState.js';
import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { forEachTenant } from '../config/tenantJobs.js';
import DeviceService from './deviceService.js';
import WaSendService from './waSendService.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { timestampMs } from '../utils/helpers.js';
import { DEFAULT_LOCALE, translatorFor } from '../i18n/index.js';
import { TenantCache } from '../config/tenantCache.js';
import { currentTenantId } from '../config/tenantContext.js';

const SETTINGS_KEY = 'whatsapp_alert_settings';

/**
 * Where the last scan's stamp lives, beside the settings and read the same way.
 *
 * One key per provider, because `app_state` is scoped: the row this reads and
 * writes belongs to whoever is in scope, and the scan runs inside one. The
 * in-memory shortcut over it is keyed the same way.
 */
const LAST_SCAN_KEY = 'whatsapp_alert_last_scan';

/** Same 30 s window `whatsappConfigService` uses, and for the same reason. */
const SETTINGS_CACHE_TTL_MS = 30_000;

/** How often the driver wakes. Whether a scan is *due* is decided in the tick. */
const TICK_INTERVAL_MS = 60_000;

/** Nobody's on-call roster is longer than this, and a typo should not fan out. */
const MAX_RECIPIENTS = 20;

export const ALERT_RULES = Object.freeze([
  'ont_offline',
  'rx_power_low',
  'temperature_high',
  'mass_outage'
]);

/**
 * The translation key each rule's message is built from.
 *
 * The `*Cleared` half is not decoration. A recovery has to be as unambiguous
 * as the alarm was: someone glancing at a phone at 3 a.m. reads the first line
 * and nothing else, and "ONT offline ✔" reads as a second alarm, not as an
 * all-clear. So recovery gets its own sentence rather than the firing sentence
 * with a tick bolted on.
 */
const RULE_KEYS = Object.freeze({
  ont_offline: { firing: 'whatsapp.alerts.ontOffline', cleared: 'whatsapp.alerts.ontOfflineCleared' },
  rx_power_low: { firing: 'whatsapp.alerts.rxPowerLow', cleared: 'whatsapp.alerts.rxPowerLowCleared' },
  temperature_high: { firing: 'whatsapp.alerts.temperatureHigh', cleared: 'whatsapp.alerts.temperatureHighCleared' },
  mass_outage: { firing: 'whatsapp.alerts.massOutage', cleared: 'whatsapp.alerts.massOutageCleared' }
});

/**
 * The defaults, and why each number is what it is.
 *
 * `ont_offline` at 30 minutes: GenieACS calls a device offline after 10 minutes
 * without an inform, but a customer power-cycling a router crosses that line
 * every day and is not an incident. Thirty minutes is long enough that a
 * reboot, a brief drop and a scheduled inform that ran late have all resolved
 * themselves, and short enough to still be news.
 *
 * `rx_power_low` at -27 dBm: the dashboard already calls anything below -27
 * critical (`buildDashboardSummary`), so the alert fires where the panel
 * already turns the row red rather than at a second, private opinion.
 *
 * `temperature_high` at 70 °C: same source — the dashboard's "Hot" bucket.
 *
 * `mass_outage` at 5 ONTs: an ODP typically serves 8 or 16 subscribers. Two or
 * three down together is a normal evening on any network; five on the SAME
 * node at the same moment is not a coincidence, it is the drop or the ODP.
 * Below five the grouping would fire on ordinary churn and start swallowing
 * individual alerts that people actually need.
 *
 * Cooldowns are asymmetric on purpose: an outage repeats every two hours
 * because someone is expected to be acting on it, while an ONT running hot or
 * dim is a maintenance item and repeating it more than every six hours only
 * teaches people to ignore the thread.
 */
const DEFAULT_RULES = Object.freeze({
  ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 120 },
  rx_power_low: { enabled: true, threshold: -27, cooldownMinutes: 360 },
  temperature_high: { enabled: true, threshold: 70, cooldownMinutes: 360 },
  mass_outage: { enabled: true, threshold: 5, cooldownMinutes: 120 }
});

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  // Five minutes. The rules are all measured in tens of minutes, so scanning
  // faster would only spend GenieACS reads to discover the same answer.
  intervalSeconds: 300,
  recipients: [],
  rules: DEFAULT_RULES
});

/** The node types an ONT is grouped under for a mass outage. */
const AGGREGATION_TYPES = Object.freeze(['odp', 'odc', 'olt']);

/**
 * A timestamp column, in milliseconds, whatever the driver handed back.
 *
 * SQLite stores an integer, Postgres returns a `Date`, MySQL returns a `Date`
 * or a string depending on the driver's settings. The cooldown is the one
 * comparison in this file that must be right on all three.
 */
/** A telemetry reading is only a reading when it is a finite number. */
function reading(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

// The separator is escaped, not typed. A literal NUL in the source makes git
// treat this file as BINARY: it then refuses to merge it and silently keeps
// one side, which is how a merge quietly drops the other side's changes.
const conditionKey = (rule, subject) => `${rule}\u0000${subject}`;

/**
 * Technical alerts: telling the provider's own team, over WhatsApp, when the
 * network breaks.
 *
 * Three things shape every decision in here, and all three are about the same
 * failure mode — an alerting channel people mute.
 *
 * 1. A firing condition notifies ONCE and then respects its cooldown. The
 *    memory is `wa_alert_state`, not this process, so a restart does not
 *    re-announce a fleet that has been down since yesterday.
 * 2. A recovery is a message too. An operator who got "ONT offline" and never
 *    hears again cannot tell a fixed fibre from a broken alerter.
 * 3. A mass outage suppresses the individual alerts underneath it. Forty
 *    messages at 3 a.m. for one fibre cut is how an alerting system gets muted
 *    forever, and a muted system is worse than none because it looks fine.
 *
 * The recipients are the provider's own staff — a list of numbers in the
 * settings, not a lookup against the subscriber base. Nothing here knows who
 * owns the ONT that failed, and it should not: an alert names equipment.
 */
class WaAlertService {
  static settingsCache = new TenantCache(SETTINGS_CACHE_TTL_MS);

  static timer = null;

  /**
   * The pass in flight, per provider.
   *
   * Collapsing was right and stays right — a manual scan while the loop is
   * mid-pass must not read the same rows and send twice. What was wrong was
   * collapsing ACROSS providers: the second provider's scan awaited the
   * first's and was handed its summary, so it never looked at its own fleet.
   */
  static scanPromises = new Map();

  /**
   * When the last pass ran. In `app_state`, with a memo in memory.
   *
   * In memory alone it was zero again after every restart, so the first tick
   * always scanned — and a panel restarts more often than an operator thinks:
   * a deploy, a crash loop, a container rescheduled. `intervalSeconds` is the
   * operator saying how hard the fleet may be swept, and a value the process
   * forgets is not a setting.
   *
   * What is given up is the catch-up scan after downtime, and it is worth
   * little: the delay it saves is bounded by `intervalSeconds`, which is
   * clamped to an hour, and the alert that would have gone out is still going
   * out — one interval later, from a panel that is up.
   */
  /** The last scan's stamp, per provider — see `readLastScanAt`. */
  static lastScanAt = new Map();

  // ── Settings ───────────────────────────────────────────────────────

  /**
   * Forget the provider in scope — its own configuration changed.
   * To forget every provider's, reach for `settingsCache.clear()`; that is a
   * reset, not a save, and the two must not share a name.
   */
  static invalidateSettingsCache() {
    this.settingsCache.invalidate();
  }

  static async readStoredSettings() {
    const raw = await AppState.get(SETTINGS_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) || {};
    } catch {
      // A hand-edited blob must not take the alerts down with it.
      return {};
    }
  }

  static normalizeRules(stored) {
    const rules = {};
    for (const rule of ALERT_RULES) {
      const fallback = DEFAULT_RULES[rule];
      const value = (stored && typeof stored[rule] === 'object' && stored[rule]) || {};
      // `null` and `''` both have to be ruled out BEFORE the conversion, not
      // after: `Number(null)` and `Number('')` are 0, and 0 is finite. Left to
      // `Number.isFinite` alone, a rule whose box the operator emptied would be
      // stored as a threshold of zero rather than restored to the default —
      // and `temperature_high` at 0 °C alerts on the whole fleet, forever.
      const empty = value.threshold === null
        || value.threshold === undefined
        || String(value.threshold).trim() === '';
      const threshold = empty ? Number.NaN : Number(value.threshold);
      rules[rule] = {
        enabled: value.enabled === undefined ? fallback.enabled : value.enabled === true,
        // An absent threshold means "use the default", which is what the browser
        // sends for a rule whose box the operator emptied.
        threshold: Number.isFinite(threshold) ? threshold : fallback.threshold,
        cooldownMinutes: clamp(value.cooldownMinutes, 1, 7 * 24 * 60, fallback.cooldownMinutes)
      };
    }
    return rules;
  }

  /**
   * Accepts a list or a pasted comma/newline-separated string, and refuses
   * anything that is not a usable number.
   *
   * Refusing beats storing: a number that cannot be dialled would fail once per
   * alert, forever, in a log nobody reads — while the operator who typed it is
   * still looking at the form.
   */
  static normalizeRecipients(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,;\n]/);
    const numbers = [];
    for (const entry of list) {
      const text = String(entry ?? '').trim();
      if (!text) continue;
      const number = normalizarTelefoneBr(text);
      if (!number) {
        throw new WaError('whatsapp.error.invalidPhone', {
          code: 'invalid_phone',
          status: 400,
          vars: { phone: text }
        });
      }
      if (!numbers.includes(number)) numbers.push(number);
    }
    if (numbers.length > MAX_RECIPIENTS) {
      throw new WaError('whatsapp.error.tooManyRecipients', {
        code: 'too_many_recipients',
        status: 400,
        vars: { max: MAX_RECIPIENTS }
      });
    }
    return numbers;
  }

  static async getSettings() {
    const cached = this.settingsCache.get();
    if (cached) return cached;
    const stored = await this.readStoredSettings();
    const settings = {
      enabled: stored.enabled === true,
      intervalSeconds: clamp(stored.intervalSeconds, 60, 3600, DEFAULT_SETTINGS.intervalSeconds),
      // Already validated on the way in; re-normalised on the way out so a blob
      // written by an older version still yields dialable numbers.
      recipients: Array.isArray(stored.recipients)
        ? stored.recipients.map((entry) => normalizarTelefoneBr(entry)).filter(Boolean)
        : [],
      rules: this.normalizeRules(stored.rules),
      updatedAt: stored.updatedAt || null
    };
    this.settingsCache.set(settings);
    return settings;
  }

  /**
   * The shape the browser sees. There is no secret here, so it is the settings
   * themselves plus what the scan would refuse on — the operator has to be able
   * to see WHY alerts are silent without running one.
   */
  static async getPublicSettings() {
    const settings = await this.getSettings();
    const account = await WhatsAppAccount.getForPurpose('alerts');
    return {
      ...settings,
      hasAlertsNumber: Boolean(account),
      ready: Boolean(settings.enabled && account && settings.recipients.length > 0)
    };
  }

  /**
   * The stored stamp, read once and remembered — a tick a minute has no reason
   * to go back to the table it just wrote.
   */
  static async readLastScanAt() {
    const tenant = currentTenantId();
    const remembered = this.lastScanAt.get(tenant);
    if (remembered) return remembered;
    const stored = Number(await AppState.get(LAST_SCAN_KEY));
    // Anything unusable, and a stamp from the FUTURE — a clock that jumped, a
    // hand-edited row — reads as "never scanned". Trusted, a stamp a year ahead
    // would hold the scan off until then, and the scan is the one thing here
    // that must not be capable of stopping.
    if (!Number.isFinite(stored) || stored <= 0 || stored > Date.now()) return 0;
    this.lastScanAt.set(tenant, stored);
    return stored;
  }

  static async markScanned(at) {
    this.lastScanAt.set(currentTenantId(), at);
    await AppState.upsert(LAST_SCAN_KEY, String(at));
  }

  static async saveSettings(patch = {}) {
    const current = await this.getSettings();
    const next = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      intervalSeconds: patch.intervalSeconds === undefined
        ? current.intervalSeconds
        : clamp(patch.intervalSeconds, 60, 3600, DEFAULT_SETTINGS.intervalSeconds),
      recipients: patch.recipients === undefined
        ? current.recipients
        : this.normalizeRecipients(patch.recipients),
      rules: patch.rules === undefined
        ? current.rules
        // Merged onto the stored rules, so a screen that sends one rule cannot
        // silently reset the other three to their defaults.
        : this.normalizeRules({ ...current.rules, ...patch.rules }),
      updatedAt: new Date().toISOString()
    };

    if (next.enabled && next.recipients.length === 0) {
      // `no_alert_recipients`, the same code the scan raises for the same
      // reason. The campaign's `no_recipients` means "the filters left nobody
      // to charge", and a form that translated the code would put that sentence
      // on this screen.
      throw new WaError('whatsapp.alerts.noRecipients', {
        code: 'no_alert_recipients',
        status: 400
      });
    }

    await AppState.upsert(SETTINGS_KEY, JSON.stringify(next));
    this.invalidateSettingsCache();
    return this.getPublicSettings();
  }

  // ── The loop ───────────────────────────────────────────────────────

  /**
   * Started from `server.js` only, never as an import side effect, so the test
   * suite never has a timer running behind it. The enabled flag is read inside
   * the tick rather than used to start and stop the timer — the same choice
   * `schedulerService` and `waOutboxWorker` make, so a Settings toggle takes
   * effect within a minute with no lifecycle to keep in sync.
   */
  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` swallows its own failures; this catch exists only so a bug in
      // that promise chain cannot become an unhandled rejection.
      void this.tick().catch((error) => {
        console.warn(`WhatsApp alert tick failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One wake-up, one pass per active provider. */
  static async tick() {
    // A pass per provider. Everything the scan reads is now per provider —
    // its settings and stamp in `app_state`, the alert state, the fiber plant,
    // the opt-out list, the WhatsApp number, and the GenieACS the fleet comes
    // from, which follows `settings.genieAcsUrl`. So the loop divides the work
    // rather than repeating it, which is what `forSoleTenant` was holding it
    // back from.
    const summaries = await forEachTenant(() => this.tickForTenant());
    return summaries.reduce(
      (total, one) => ({
        fired: (total.fired || 0) + (one.fired || 0),
        cleared: (total.cleared || 0) + (one.cleared || 0),
        notified: (total.notified || 0) + (one.notified || 0),
        skipped: total.skipped ?? one.skipped ?? null
      }),
      { fired: 0, cleared: 0, notified: 0, skipped: null }
    );
  }

  /** One wake-up for the provider in scope. Scans only when `intervalSeconds` has elapsed. */
  static async tickForTenant() {
    const settings = await this.getSettings().catch(() => null);
    if (!settings || !settings.enabled) return { skipped: 'disabled' };
    const lastScanAt = await this.readLastScanAt();
    if (Date.now() - lastScanAt < settings.intervalSeconds * 1000) {
      return { skipped: 'not_due' };
    }
    // Stamped BEFORE the pass, as it always was: a scan that takes longer than
    // the interval must not have a second one start behind it.
    await this.markScanned(Date.now());
    return this.scan();
  }

  // ── The scan ───────────────────────────────────────────────────────

  /**
   * One pass over the fleet.
   *
   * It NEVER throws. A GenieACS that is down, a malformed reading, an Evolution
   * server that refuses one message — none of those may stop the loop, and a
   * scan that threw out of a tick would take every other rule down with it. The
   * reason a pass did nothing comes back in `skipped` instead, because the
   * caller (the loop, or an admin who just pressed the button) has to be able
   * to tell "nothing is wrong" from "nothing was checked".
   *
   * @returns {Promise<{fired: number, cleared: number, notified: number,
   *   skipped: string|null, error: string|null}>}
   */
  static async scan({ now = Date.now() } = {}) {
    // Overlapping passes collapse onto the running one: a manual scan while the
    // loop is mid-pass would otherwise read the same rows and send twice.
    const tenant = currentTenantId();
    const running = this.scanPromises.get(tenant);
    if (running) return running;
    const work = this.runScan({ now }).finally(() => {
      if (this.scanPromises.get(tenant) === work) this.scanPromises.delete(tenant);
    });
    this.scanPromises.set(tenant, work);
    return work;
  }

  static async runScan({ now = Date.now() } = {}) {
    const summary = { fired: 0, cleared: 0, notified: 0, skipped: null, error: null };
    try {
      const settings = await this.getSettings();
      if (!settings.enabled) {
        summary.skipped = 'disabled';
        return summary;
      }

      const config = await WhatsAppConfigService.getConfig();
      if (!WhatsAppConfigService.isReady(config)) {
        // Distinct from `disabled`: the rules are on and the integration is
        // not. An admin who pressed the button is owed the difference between
        // "you turned this off" and "WhatsApp was never set up".
        summary.skipped = 'not_configured';
        return summary;
      }

      // The number that carries the alerts, with the usual fallbacks. No
      // connected number at all, or nobody to send to, and the pass stops
      // BEFORE it reads the fleet: raising conditions nobody will hear about
      // would leave `wa_alert_state` claiming everyone was told.
      const account = await WhatsAppAccount.getForPurpose('alerts');
      if (!account) {
        // Also its own reason. "No number is on duty" is fixed on this screen;
        // "no connected number can carry alerts" is fixed on the connection
        // screen, and one message for both sends the admin to the wrong one.
        summary.skipped = 'no_alert_number';
        return summary;
      }
      if (settings.recipients.length === 0) {
        summary.skipped = 'no_recipients';
        return summary;
      }

      const devices = await DeviceService.getDashboardDevices();
      if (!Array.isArray(devices) || devices.length === 0) {
        // An empty fleet read is far more likely to be a broken GenieACS than a
        // provider with no ONTs, and treating it as "nothing is firing" would
        // blast a recovery message for every open condition at once.
        summary.skipped = 'no_devices';
        return summary;
      }

      const { firing, unknown } = await this.evaluate(devices, settings, now);
      const recipients = await this.dialableRecipients(settings.recipients);
      if (recipients.length === 0) {
        summary.skipped = 'no_recipients';
        return summary;
      }

      await this.reconcile({ firing, unknown, settings, account, recipients, now, summary });
    } catch (error) {
      // Reported, not thrown — see the method comment.
      summary.error = error.message;
      summary.skipped = summary.skipped || 'error';
      console.warn(`WhatsApp alert scan failed: ${error.message}`);
    }
    return summary;
  }

  /**
   * Turns one fleet read into the set of conditions firing right now.
   *
   * The second return value matters as much as the first. `unknown` holds the
   * conditions this pass could NOT judge — an offline ONT's optical reading is
   * yesterday's, a device suppressed by a mass outage is deliberately not being
   * asked about — and a condition in there is left exactly as it was. Treating
   * "cannot tell" as "not firing" is how an alerter sends "optical power
   * recovered" about a device that has been dark for an hour.
   */
  static async evaluate(devices, settings, now) {
    const firing = new Map();
    const unknown = new Set();
    const rules = settings.rules;

    const offline = [];
    for (const device of devices) {
      // Per device, so one unreadable row cannot end the pass. A fleet always
      // contains at least one device mid-provisioning with half a datamodel.
      try {
        const deviceId = String(device?._id ?? '').trim();
        if (!deviceId) continue;

        const lastInformMs = timestampMs(device._lastInform);
        const ageMs = now - lastInformMs;
        if (!Number.isFinite(ageMs) || ageMs < 0) {
          // Never informed, or a clock that disagrees with ours. Nothing about
          // this device can be judged, including its optical reading.
          unknown.add(conditionKey('ont_offline', deviceId));
          unknown.add(conditionKey('rx_power_low', deviceId));
          unknown.add(conditionKey('temperature_high', deviceId));
          continue;
        }

        const ageMinutes = ageMs / 60_000;
        const isOnline = DeviceService.isDeviceOnline(device, now);

        if (rules.ont_offline.enabled) {
          // At the threshold, not past it. An operator who types 30 means "30
          // minutes is already too long"; a strict comparison would make the
          // one number they typed the only one that never alerts.
          if (ageMinutes >= rules.ont_offline.threshold) {
            offline.push(deviceId);
            firing.set(conditionKey('ont_offline', deviceId), {
              rule: 'ont_offline',
              subject: deviceId,
              vars: { device: deviceId, minutes: Math.round(ageMinutes) }
            });
          }
        } else if (!isOnline) {
          // The grouping still needs to know who is down even when the
          // individual rule is off — a fibre cut is worth one message whether
          // or not the operator wants forty.
          offline.push(deviceId);
        }

        // Optical and thermal readings are only judged on a device that is
        // currently informing. A dark ONT reports whatever it last managed to
        // send, and "rx power low" stacked on top of "ONT offline" is the same
        // incident said twice.
        for (const [rule, raw] of [
          ['rx_power_low', device.rxpower],
          ['temperature_high', device.temperature]
        ]) {
          if (!rules[rule].enabled) continue;
          const key = conditionKey(rule, deviceId);
          const value = isOnline ? reading(raw) : null;
          if (value === null) {
            unknown.add(key);
            continue;
          }
          const over = rule === 'rx_power_low'
            ? value <= rules[rule].threshold
            : value >= rules[rule].threshold;
          if (over) {
            firing.set(key, {
              rule,
              subject: deviceId,
              vars: { device: deviceId, value, threshold: rules[rule].threshold }
            });
          }
        }
      } catch {
        // One device's telemetry, not the fleet's. Nothing to say about it, and
        // nothing to clear either.
        continue;
      }
    }

    if (rules.mass_outage.enabled) {
      await this.applyMassOutage({ offline, rules, firing, unknown });
    }

    return { firing, unknown };
  }

  /**
   * Groups the offline ONTs by the node they hang off, raises one alert per
   * node that is over the threshold, and takes the individual `ont_offline`
   * entries for those devices back out.
   *
   * Grouping is at the NEAREST aggregation point — the ODP an ONT is wired to,
   * not the OLT at the end of the chain. A whole-OLT alert would be one message
   * for what is usually one drop cable, and would tell a technician to drive to
   * the wrong end of the network. A cut further upstream simply produces one
   * message per affected ODP, which is still a handful instead of hundreds.
   */
  static async applyMassOutage({ offline, rules, firing, unknown }) {
    const minimum = Math.max(2, Math.round(rules.mass_outage.threshold));
    // Below the threshold no group can possibly reach it, so the topology and
    // the second fleet read are never touched on a healthy network.
    if (offline.length < minimum) return;

    const nodes = await MappingNode.getAll();
    const ontNodes = nodes.filter((node) => node.type === 'ont' && node.pppoe);
    if (ontNodes.length === 0) return;

    // The dashboard projection has no PPPoE username — the only link between a
    // GenieACS device and a node on the map — so it is read here, from the
    // panel's own reader, and only for a fleet that already looks broken.
    const identities = await DeviceService.getCustomerIdentityDevices();
    const pppoeByDevice = new Map();
    for (const item of identities) {
      const id = String(item?._id ?? '').trim();
      const pppoe = String(item?.pppoe ?? '').trim().toLowerCase();
      if (id && pppoe) pppoeByDevice.set(id, pppoe);
    }

    const nodeByPppoe = new Map();
    for (const node of ontNodes) {
      nodeByPppoe.set(String(node.pppoe).trim().toLowerCase(), node);
    }

    const edges = await MappingEdge.getAll();
    const nodeById = new Map(nodes.map((node) => [node.node_id, node]));
    const parentOf = new Map();
    for (const edge of edges) {
      for (const [from, to] of [[edge.source, edge.target], [edge.target, edge.source]]) {
        const child = nodeById.get(from);
        const parent = nodeById.get(to);
        if (!child || !parent || child.type !== 'ont') continue;
        if (!AGGREGATION_TYPES.includes(parent.type)) continue;
        const current = parentOf.get(child.node_id);
        // Nearest wins: odp before odc before olt, whatever order the edges
        // happened to be written in.
        if (
          !current
          || AGGREGATION_TYPES.indexOf(parent.type) < AGGREGATION_TYPES.indexOf(current.type)
        ) {
          parentOf.set(child.node_id, parent);
        }
      }
    }

    const groups = new Map();
    for (const deviceId of offline) {
      const pppoe = pppoeByDevice.get(deviceId);
      if (!pppoe) continue;
      const ontNode = nodeByPppoe.get(pppoe);
      if (!ontNode) continue;
      const parent = parentOf.get(ontNode.node_id);
      if (!parent) continue;
      const bucket = groups.get(parent.node_id) || { node: parent, devices: [] };
      bucket.devices.push(deviceId);
      groups.set(parent.node_id, bucket);
    }

    for (const [nodeId, { node, devices }] of groups) {
      if (devices.length < minimum) continue;
      firing.set(conditionKey('mass_outage', nodeId), {
        rule: 'mass_outage',
        subject: nodeId,
        vars: { node: node.name || nodeId, count: devices.length }
      });
      for (const deviceId of devices) {
        // Held back, not cleared. An `ont_offline` that was already firing for
        // one of these devices keeps its row and stays quiet: clearing it would
        // send "ONT recovered" in the middle of a fibre cut.
        const key = conditionKey('ont_offline', deviceId);
        firing.delete(key);
        unknown.add(key);
      }
    }
  }

  /**
   * Walks the open rows against what is firing now, and sends what is owed.
   *
   * Four cases, and the whole noise policy lives in them: new condition →
   * notify once; still firing → nothing until the cooldown passes; recovered →
   * one message and the row goes; can't tell → leave it exactly as it was.
   */
  static async reconcile({ firing, unknown, settings, account, recipients, now, summary }) {
    const open = await WaAlertState.listOpen();
    const openByKey = new Map(open.map((row) => [conditionKey(row.rule, row.subject), row]));
    const stamp = new Date(now);

    for (const [key, condition] of firing) {
      const row = openByKey.get(key);
      const rule = settings.rules[condition.rule];
      if (!row) {
        const opened = await WaAlertState.open({ rule: condition.rule, subject: condition.subject, now: stamp });
        summary.fired += 1;
        const sent = await this.notify({ account, recipients, condition, cleared: false });
        if (sent > 0) {
          summary.notified += sent;
            await WaAlertState.markNotified(opened.id, stamp);
        }
        continue;
      }

      const lastNotified = timestampMs(row.last_notified_at);
      const cooledDown = !Number.isFinite(lastNotified)
        || now - lastNotified >= rule.cooldownMinutes * 60_000;
      if (!cooledDown) continue;

      const sent = await this.notify({ account, recipients, condition, cleared: false });
      if (sent > 0) {
        summary.notified += sent;
        await WaAlertState.markNotified(row.id, stamp);
      }
    }

    for (const [key, row] of openByKey) {
      if (firing.has(key) || unknown.has(key)) continue;
      // A rule the operator has since switched off: the row goes without a
      // message, because "recovered" would be a lie about equipment nobody is
      // watching any more.
      const rule = settings.rules[row.rule];
      if (rule?.enabled && row.notify_count > 0) {
        summary.notified += await this.notify({
          account,
          recipients,
          condition: { rule: row.rule, subject: row.subject, vars: { device: row.subject, node: row.subject } },
          cleared: true
        });
      }
      await WaAlertState.removeById(row.id);
      summary.cleared += 1;
    }
  }

  // ── Sending ────────────────────────────────────────────────────────

  /**
   * The staff numbers that may actually be written to.
   *
   * The do-not-disturb list is honoured even here. An alert is the provider
   * initiating contact, which is exactly what an opt-out refuses, and a number
   * ends up on that list by asking — including a technician who left the
   * company and kept the phone.
   */
  static async dialableRecipients(recipients) {
    const optedOut = await WaOptOut.activePhones(recipients);
    return recipients.filter((number) => !optedOut.has(number));
  }

  /**
   * Composes the message and drops one copy per recipient into the outbox.
   *
   * Never throws: one recipient whose number the server refuses must not stop
   * the other five from being told, and must not stop the condition being
   * recorded as raised.
   *
   * @returns {Promise<number>} how many copies were enqueued
   */
  static async notify({ account, recipients, condition, cleared }) {
    const body = this.compose(condition, cleared);
    if (!body) return 0;

    let sent = 0;
    for (const number of recipients) {
      try {
        // Sequential on purpose, the same reason the inbound handler gives:
        // `WaConversation.ensure` is a get-or-create without a transaction, and
        // two passes for the same number in parallel would open two threads.
        const conversation = await WaConversation.ensure({
          accountId: account.id,
          externalThreadId: `${number}@s.whatsapp.net`,
          waPhone: number,
          waLid: null,
          pushName: null
        });
        // The on-duty staff thread is a conversation like any other, so the bot
        // reads it too: an unlabelled alert counted against the ceiling for
        // whoever is on call.
        await WaSendService.enqueue({ conversationId: conversation.id, body, source: 'alert' });
        sent += 1;
      } catch (error) {
        console.warn(`WhatsApp alert to ${number} not enqueued: ${error.message}`);
      }
    }
    return sent;
  }

  /**
   * The message text.
   *
   * A background job has no request locale, so it resolves through the panel's
   * default rather than guessing at one — the same default `attachLocale` falls
   * back to when a browser sends no `Accept-Language`.
   */
  static compose(condition, cleared) {
    const keys = RULE_KEYS[condition.rule];
    if (!keys) return null;
    const t = translatorFor(DEFAULT_LOCALE);
    return t(cleared ? keys.cleared : keys.firing, condition.vars || {});
  }
}

export { DEFAULT_RULES, DEFAULT_SETTINGS, LAST_SCAN_KEY, RULE_KEYS, SETTINGS_KEY };
export default WaAlertService;
