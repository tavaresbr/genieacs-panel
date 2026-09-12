import WaMessage from '../models/WaMessage.js';
import WaSendService from './waSendService.js';
import WhatsAppConfigService from './whatsappConfigService.js';
import { isPermanentFailure } from './waSendFailure.js';
import { forEachTenant } from '../config/tenantJobs.js';
import { isUniqueViolation } from '../config/database.js';

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
 *
 * Seven, not the three this started with. Three only made sense while the
 * attempts were instantaneous: a failed row went straight back to 'queued', the
 * loop woke five seconds later, and the whole allowance burned in fifteen
 * seconds — so an Evolution restart taking twenty failed every message in the
 * queue for good. What matters is not the count but the window the count buys
 * with the backoff below, and that window has to outlast a restart.
 */
export const MAX_ATTEMPTS = 7;

/**
 * The wait after the first failed attempt, doubling from there.
 *
 * Half a minute rather than five, because a queued message may be an operator's
 * reply with a human on the other end: the first retry has to cover a server
 * that blinked without making a conversation wait for it.
 */
const BACKOFF_BASE_MS = 30_000;

/**
 * The longest single wait. Doubling with nothing to stop it reaches a day by
 * the tenth attempt, which is not a retry any more — it is a message the panel
 * quietly held onto.
 */
const BACKOFF_CAP_MS = 30 * 60_000;

/** `wa_messages.delivery_error` is 500 characters wide. */
const ERROR_LIMIT = 500;

/**
 * How long to wait before the attempt after this one.
 *
 * Exponential with a ceiling, and no jitter: the thundering herd a campaign
 * would otherwise produce is already broken up by the per-minute ceiling below,
 * which lets a fixed number of messages leave per minute no matter how many
 * came due at once. Adding randomness on top would only make the schedule
 * harder to reason about in a `delivery_error` read three days later.
 *
 * @param {number} attempts the attempt that just failed, counting from one
 */
export function retryDelayMs(attempts) {
  const step = Math.max(1, Number(attempts) || 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** (step - 1), BACKOFF_CAP_MS);
}

/**
 * Every wait a message will sit through before the outbox gives up, in order.
 *
 * Exported because the window is the decision — 30 s, 1, 2, 4, 8 and 16 minutes
 * is a little over half an hour of Evolution being down, survived — and a
 * decision measured in minutes cannot be tested by waiting for it.
 */
export function retryScheduleMs(maxAttempts = MAX_ATTEMPTS) {
  const waits = [];
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) waits.push(retryDelayMs(attempt));
  return waits;
}

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
   * One pass per active provider, each draining only its own queue.
   *
   * This was a single pass under `forSoleTenant` while `listSendable()` read
   * the whole deployment — a loop then would have sent each message once per
   * provider rather than splitting them. Now that the queue carries a provider,
   * the loop divides the work, which is what it was always meant to do.
   *
   * The per-minute send budget is still one window for the process, so a busy
   * provider can still spend another's minute. That is a fairness problem, not
   * a correctness one, and it belongs with the per-provider scheduling in a
   * later phase.
   *
   * @returns {Promise<{ sent: number, failed: number, skipped: string|null }>}
   */
  static async tick() {
    const summaries = await forEachTenant(() => this.tickForTenant());
    return summaries.reduce(
      (total, one) => ({
        sent: total.sent + one.sent,
        failed: total.failed + one.failed,
        // The first reason given, so a caller still learns why a pass did
        // nothing rather than seeing a bare pair of zeros.
        skipped: total.skipped ?? one.skipped
      }),
      { sent: 0, failed: 0, skipped: null }
    );
  }

  /**
   * One pass for the provider in scope. It NEVER throws: a single unsendable
   * message must not be able to stop the loop for every other one — nor, now,
   * for every other provider.
   */
  static async tickForTenant() {
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

      // ── Ponto de não-retorno ────────────────────────────────────────────
      // A linha acima já entregou ao Evolution: o destinatário VAI receber.
      // Daqui em diante nenhuma falha pode voltar para `recordFailure`, que
      // devolve a linha para 'queued' e faz o próximo laço mandar de novo.
      //
      // E há uma falha real esperando aqui. O painel assina `MESSAGES_UPSERT`,
      // e o Evolution ecoa a mensagem que ACABOU de sair como evento de
      // entrada; `gravarMensagem` a grava como linha 'out' com este mesmo
      // `external_id`. Entre o `dispatch` retornar e a escrita abaixo commitar
      // existe uma janela em que o eco chega primeiro e insere. Aí esta escrita
      // viola o índice único `(tenant_id, external_id)` — e, antes desta
      // guarda, o `catch` de fora lia isso como "não enviou" e reenviava.
      //
      // Violação de unicidade aqui significa exatamente o contrário de falha:
      // significa que a outra ponta já registrou o que nós mandamos.
      try {
        await WaMessage.update(message.id, {
          external_id: externalId,
          delivery_status: 'sent',
          delivery_error: null
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // O `external_id` fica com o eco, que é quem o registrou primeiro, e
        // esta linha sai da fila pelo estado. O que NÃO pode acontecer é ela
        // continuar 'queued': `listSendable` a pegaria e o cliente receberia
        // duas vezes.
        await WaMessage.update(message.id, {
          delivery_status: 'sent',
          delivery_error: null
        });
        console.warn(
          `[wa] mensagem ${message.id}: o eco de entrada gravou ${externalId} antes `
          + 'da confirmação de saída; a linha sai da fila sem reenvio'
        );
      }
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
    // A number that is not on WhatsApp fails the same way on the seventh
    // attempt as on the first, and spending half an hour of queue on it hides
    // the verdict from the operator for half an hour. Everything the classifier
    // cannot name stays a retry — see `waSendFailure.js` for which way the
    // doubt falls, and why.
    const permanent = isPermanentFailure(error);
    const terminal = permanent || attempts >= MAX_ATTEMPTS;
    await WaMessage.update(message.id, {
      // Under the cap the row goes back to 'queued'. `listSendable` — the
      // outbox's only query — looks for 'queued' and for a stale 'sending';
      // leaving a retryable row 'failed' would put it out of the worker's reach
      // and make the whole allowance mean one attempt.
      delivery_status: terminal ? 'failed' : 'queued',
      delivery_error: failureText(error),
      // The due time is what keeps the row out of the next pass five seconds
      // from now; without it 'queued' means "immediately" and the backoff is
      // not a backoff. A terminal row goes back to NULL so that `requeue`, which
      // means "the reason is over", finds nothing left to wait for.
      next_attempt_at: terminal ? null : new Date(Date.now() + retryDelayMs(attempts))
    });
    console.warn(
      `WhatsApp message ${message.id} attempt ${attempts}/${MAX_ATTEMPTS} `
      + `failed${permanent ? ' permanently' : ''}: ${failureText(error)}`
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
