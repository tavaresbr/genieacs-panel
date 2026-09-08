import WaMessage from '../models/WaMessage.js';
import WaSendService from './waSendService.js';
import WhatsAppConfigService from './whatsappConfigService.js';

/** How often a pass runs. Short, because a reply typed by a human is waiting. */
const TICK_INTERVAL_MS = 5_000;

/** Most messages one pass will look at, whatever the rate limit allows. */
const BATCH_LIMIT = 20;

/** The rolling window the per-minute ceiling is measured over. */
const WINDOW_MS = 60_000;

/**
 * Attempts a message gets before the outbox gives up on it.
 *
 * `WaMessage.claim()` increments the counter, so the value read after a claim
 * is the number of the attempt now under way.
 */
export const MAX_ATTEMPTS = 3;

/** `wa_messages.delivery_error` is 500 characters wide. */
const ERROR_LIMIT = 500;

/**
 * The outbox worker.
 *
 * `wa_messages` IS the queue — there is no side table — so a pass is: ask for
 * the sendable ids, take one with the conditional UPDATE in `WaMessage.claim()`,
 * send it, and write the outcome back. The claim is what makes the loop safe to
 * run twice at once, which is why nothing here serialises the ticks: a second
 * pass overlapping the first is a normal event (a slow Evolution server is all
 * it takes), and the loser of a claim must simply do nothing.
 *
 * It is started from `server.js` only, never as an import side effect, so the
 * test suite never has a timer running behind it. The enabled flag is read
 * inside the tick rather than used to start and stop the timer — the same
 * choice `schedulerService.js` makes, so a Settings toggle takes effect within
 * one tick without a lifecycle to keep in sync.
 */
class WaOutboxWorker {
  static timer = null;

  /** Timestamps of the sends attempted in the last minute, for the ceiling. */
  static window = [];

  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` swallows its own failures; this catch exists only so a bug in
      // that promise chain cannot become an unhandled rejection.
      void this.tick().catch((error) => {
        console.warn(`WhatsApp outbox tick failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // The window goes with it: the process is shutting down, and a worker
    // restarted inside one process should start from a clean minute rather
    // than inherit a budget spent by a previous life.
    this.window = [];
  }

  /**
   * One pass. It NEVER throws: a single unsendable message must not be able to
   * stop the loop for every other one.
   *
   * @returns {Promise<{ sent: number, failed: number, skipped: string|null }>}
   */
  static async tick() {
    const summary = { sent: 0, failed: 0, skipped: null };
    try {
      const config = await WhatsAppConfigService.getConfig();
      if (!WhatsAppConfigService.isReady(config)) {
        summary.skipped = 'disabled';
        return summary;
      }

      const budget = this.budget(config.rateLimitPerMin);
      if (budget <= 0) {
        summary.skipped = 'rate_limited';
        return summary;
      }

      const ids = await WaMessage.listSendable(Math.min(budget, BATCH_LIMIT));
      for (const id of ids) {
        // Reserved before the claim rather than after it. A slot burnt on a
        // message another pass had already taken is a rounding error; a slot
        // taken after the send would let two overlapping passes both decide
        // they were under the ceiling.
        if (!this.reserve(config.rateLimitPerMin)) {
          summary.skipped = 'rate_limited';
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- the ceiling is per minute; a burst is the thing being prevented
        const outcome = await this.deliver(id);
        if (outcome === 'sent') summary.sent += 1;
        else if (outcome !== 'claimed_elsewhere') summary.failed += 1;
      }
      // Reported whether the pass ran out of budget mid-loop or was cut to the
      // budget when it asked for work: either way the minute is spent, and the
      // rest of the queue is waiting on the clock rather than on a failure.
      if (this.budget(config.rateLimitPerMin) <= 0) summary.skipped = 'rate_limited';
      return summary;
    } catch (error) {
      console.warn(`WhatsApp outbox tick failed: ${error.message}`);
      summary.skipped = 'error';
      return summary;
    }
  }

  /**
   * Claims one message and sends it.
   *
   * @returns {Promise<'sent'|'failed'|'retry'|'claimed_elsewhere'>}
   */
  static async deliver(id) {
    const message = await WaMessage.claim(id);
    // A null claim means another pass already owns this row. That is the
    // conditional UPDATE working, not a failure: the loser does nothing and
    // says nothing.
    if (!message) return 'claimed_elsewhere';

    try {
      const { externalId } = await WaSendService.dispatch(message);
      await WaMessage.update(message.id, {
        external_id: externalId,
        delivery_status: 'sent',
        delivery_error: null
      });
      // 'sent' is as far as the sender can see. The webhook upgrades the row to
      // delivered and read when the receipts arrive.
      return 'sent';
    } catch (error) {
      return this.recordFailure(message, error);
    }
  }

  /**
   * Writes a failed attempt back, and decides whether there will be another.
   *
   * @returns {Promise<'failed'|'retry'>}
   */
  static async recordFailure(message, error) {
    const attempts = Number(message.attempts || 0);
    const terminal = attempts >= MAX_ATTEMPTS;
    await WaMessage.update(message.id, {
      // Under the cap the row goes back to 'queued'. `listSendable` — the
      // outbox's only query — looks for 'queued' and for a stale 'sending';
      // leaving a retryable row 'failed' would put it out of the worker's reach
      // and make "three attempts" mean one.
      delivery_status: terminal ? 'failed' : 'queued',
      delivery_error: failureText(error)
    });
    console.warn(
      `WhatsApp message ${message.id} attempt ${attempts}/${MAX_ATTEMPTS} failed: ${failureText(error)}`
    );
    return terminal ? 'failed' : 'retry';
  }

  // ── The per-minute ceiling ─────────────────────────────────────────
  //
  // One window for the whole worker, not one per account: what WhatsApp reacts
  // to is the provider's traffic, and a limit applied per number would multiply
  // by however many numbers happen to be connected.

  static prune() {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.window.length > 0 && this.window[0] <= cutoff) this.window.shift();
  }

  static budget(rateLimitPerMin) {
    this.prune();
    return Math.max(0, Number(rateLimitPerMin || 0) - this.window.length);
  }

  /** Takes one slot, or reports that the minute is spent. */
  static reserve(rateLimitPerMin) {
    if (this.budget(rateLimitPerMin) <= 0) return false;
    this.window.push(Date.now());
    return true;
  }
}

/**
 * What the operator will read in `delivery_error`.
 *
 * A `WaError`'s message is a translation key, so the machine code goes in front
 * of it and the variables after: 'http_error' plus the server's own words is
 * what tells someone whether to look at the number or at the server.
 */
function failureText(error) {
  const parts = [];
  if (error?.code) parts.push(String(error.code));
  if (error?.message) parts.push(String(error.message));
  const vars = error?.translationVars;
  if (vars && typeof vars === 'object') {
    parts.push(Object.entries(vars).map(([key, value]) => `${key}=${value}`).join(' '));
  }
  return parts.filter(Boolean).join(' | ').slice(0, ERROR_LIMIT);
}

export default WaOutboxWorker;
