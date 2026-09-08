import WaBroadcast, { MAX_ATTEMPTS } from '../models/WaBroadcast.js';
import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { forEachTenant } from '../config/tenantJobs.js';
import WaSendService from './waSendService.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

/**
 * One pass a minute, because the campaign's budget is written per minute.
 *
 * The outbox worker ticks every five seconds — an operator's reply is waiting
 * on it. Nobody is waiting on a campaign, and pacing it by the clock is the
 * point rather than a compromise.
 */
const TICK_INTERVAL_MS = 60_000;

/** `wa_broadcast_recipients.error_msg` is 500 characters wide. */
const ERROR_LIMIT = 500;

/**
 * The states an operator may ask for, and what each one may be asked from.
 *
 * `draft` cannot jump to `paused`: pausing something that never started is not
 * a state, and allowing it would leave a campaign that looks arrested when it
 * was only ever a draft. The three terminal states accept nothing — a finished
 * or cancelled campaign is history, and restarting one would re-send to the
 * people it already reached.
 */
const TRANSITIONS = Object.freeze({
  draft: ['running', 'canceled'],
  queued: ['running', 'paused', 'canceled'],
  paused: ['running', 'canceled'],
  running: ['paused', 'canceled'],
  done: [],
  canceled: [],
  failed: []
});

/**
 * Running a campaign: the state machine an operator drives, and the loop that
 * feeds the outbox.
 *
 * The loop deliberately does NOT talk to the Evolution server. It renders
 * nothing and sends nothing — it hands each recipient to `WaSendService.enqueue`
 * as an ordinary outbound message, and the outbox worker despatches it under
 * the same per-minute ceiling and the same three-attempt rule as everything
 * else the panel sends. A campaign with its own transport would be a second
 * place for a message to get stuck.
 */
class WaBroadcastService {
  static timer = null;

  static async list() {
    const rows = await WaBroadcast.list();
    return rows.map((row) => this.publicBroadcast(row));
  }

  /**
   * Start, pause or cancel.
   *
   * Starting is the only moment a connected number is required: a draft is a
   * plan, and refusing to build one because nobody had paired a phone yet would
   * throw away the operator's work for a condition they can fix in a minute.
   */
  static async setStatus(id, status) {
    const broadcast = await this.require(id);
    const target = String(status ?? '').trim();
    if (!['running', 'paused', 'canceled'].includes(target)
      || !(TRANSITIONS[broadcast.status] || []).includes(target)) {
      throw new WaError('whatsapp.error.invalidStatus', { code: 'invalid_status', status: 409 });
    }
    if (target === 'running') {
      const config = await WhatsAppConfigService.getConfig();
      if (!WhatsAppConfigService.isReady(config)) {
        throw new WaError('whatsapp.error.notConfigured', { code: 'not_configured', status: 409 });
      }
      if (!await WhatsAppAccount.getForPurpose('billing')) {
        throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 409 });
      }
    }
    return this.publicBroadcast(await WaBroadcast.update(broadcast.id, {
      status: target,
      // Stamped once, on the first start: a pause and a resume are the same
      // campaign, and moving this would lose when it actually began.
      ...(target === 'running' && !broadcast.start_at ? { start_at: new Date() } : {})
    }));
  }

  static async require(id) {
    const numeric = Number(id);
    const row = Number.isInteger(numeric) ? await WaBroadcast.getById(numeric) : null;
    if (!row) {
      throw new WaError('whatsapp.broadcast.notFound', { code: 'broadcast_not_found', status: 404 });
    }
    return row;
  }

  // ── The flush loop ─────────────────────────────────────────────────

  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` swallows its own failures; this catch exists only so a bug in
      // that promise chain cannot become an unhandled rejection.
      void this.tick().catch((error) => {
        console.warn(`WhatsApp broadcast tick failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every running campaign. It NEVER throws.
   *
   * A single unsendable recipient — or a single broken campaign — must not be
   * able to stop the loop for all the others.
   *
   * @returns {Promise<{ enqueued: number, skipped: number, failed: number }>}
   */
  static async tick() {
    // A pass per provider, now that `listByStatus` only returns that
    // provider's campaigns. Under `forSoleTenant` this had to be a single
    // pass: looping over a deployment-wide campaign list would have flushed
    // each campaign once per provider.
    const summaries = await forEachTenant(() => this.tickForTenant());
    return summaries.reduce(
      (total, one) => ({
        enqueued: total.enqueued + one.enqueued,
        skipped: total.skipped + one.skipped,
        failed: total.failed + one.failed
      }),
      { enqueued: 0, skipped: 0, failed: 0 }
    );
  }

  /** One pass for the provider in scope. It NEVER throws, for the same reason. */
  static async tickForTenant() {
    const summary = { enqueued: 0, skipped: 0, failed: 0 };
    try {
      const config = await WhatsAppConfigService.getConfig();
      // Read inside the tick rather than used to start and stop the timer, the
      // same choice the outbox worker makes: a Settings toggle then takes
      // effect within one pass, with no lifecycle to keep in sync.
      if (!WhatsAppConfigService.isReady(config)) return summary;

      const running = await WaBroadcast.listByStatus('running');
      for (const broadcast of running) {
        // eslint-disable-next-line no-await-in-loop -- campaigns share the outbox's minute; running them at once would burst it
        await this.flushOne(broadcast, config, summary);
      }
      return summary;
    } catch (error) {
      console.warn(`WhatsApp broadcast tick failed: ${error.message}`);
      return summary;
    }
  }

  /** One campaign's share of this minute. Never throws. */
  static async flushOne(broadcast, config, summary) {
    try {
      const account = await WhatsAppAccount.getForPurpose('billing');
      // No connected number: leave the campaign in `running` and try again next
      // minute. Failing the recipients instead would burn a campaign's three
      // attempts over a number that was merely re-pairing.
      if (!account) return;

      const budget = Math.min(
        Math.max(Number(broadcast.rate_limit_per_min) || Number(config.rateLimitPerMin) || 1, 1),
        120
      );
      const ids = await WaBroadcast.listPendingIds(broadcast.id, budget);
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop -- one at a time is what a rate limit means
        const outcome = await this.deliver(id, account);
        if (outcome === 'sent') summary.enqueued += 1;
        else if (outcome === 'skipped') summary.skipped += 1;
        else if (outcome === 'failed') summary.failed += 1;
      }

      const tally = await WaBroadcast.tally(broadcast.id);
      const remaining = await WaBroadcast.countUnfinished(broadcast.id);
      await WaBroadcast.update(broadcast.id, {
        sent_count: tally.sent,
        failed_count: tally.failed,
        // Every recipient reached a terminal state, so the campaign is over.
        // This is why the opt-out check lives inside `deliver` and not in the
        // pending query: a recipient filtered out of that query would never
        // leave 'pending', `remaining` would never reach zero, and the campaign
        // would sit in 'running' forever with nothing left to do.
        ...(remaining === 0 ? { status: 'done' } : {})
      });
    } catch (error) {
      console.warn(`WhatsApp broadcast ${broadcast.id} flush failed: ${error.message}`);
    }
  }

  /**
   * Claims one recipient and hands it to the outbox.
   *
   * The guards run in this order and no other: opt-out first, because a person
   * who asked not to be contacted must not have their number examined for
   * anything else; then whether the number is addressable at all; then the
   * send.
   *
   * @returns {Promise<'sent'|'skipped'|'failed'|'retry'|'claimed_elsewhere'>}
   */
  static async deliver(id, account) {
    const recipient = await WaBroadcast.claimRecipient(id);
    // A null claim means another tick already owns this row. That is the
    // conditional UPDATE working, not a failure.
    if (!recipient) return 'claimed_elsewhere';

    // 1. Opt-out. Campaigns are INITIATED contact, so unlike the reply box this
    // path does enforce the list.
    if (await WaOptOut.isActive({ waPhone: recipient.phone_e164 })) {
      await WaBroadcast.updateRecipient(recipient.id, {
        status: 'skipped',
        error_msg: 'opt_out'
      });
      return 'skipped';
    }

    // 2. An address. A number that will not normalise can never be sent to, so
    // it is terminal on the first attempt rather than after three.
    const number = normalizarTelefoneBr(recipient.phone_e164);
    if (!number) {
      await WaBroadcast.updateRecipient(recipient.id, {
        status: 'failed',
        error_msg: 'no_destination'
      });
      return 'failed';
    }

    // 3. The send — which is an enqueue. The outbox owns the transport.
    try {
      const conversation = await WaConversation.ensure({
        accountId: account.id,
        // The same canonical form the inbound handler builds, so a campaign to
        // someone who has written in before lands in the thread that already
        // exists instead of opening a second one beside it.
        externalThreadId: `${number}@s.whatsapp.net`,
        waPhone: number,
        pushName: recipient.client_name || null
      });
      // Only filled when the thread does not know yet: a conversation already
      // tied to a contract by the inbound path must not be re-pointed by a
      // campaign that happens to carry a different one.
      if (recipient.contract && !conversation.contract) {
        await WaConversation.update(conversation.id, { contract: recipient.contract });
      }
      const message = await WaSendService.enqueue({
        conversationId: conversation.id,
        body: recipient.rendered_body
      });
      await WaBroadcast.updateRecipient(recipient.id, {
        status: 'sent',
        message_id: message.id,
        error_msg: null,
        sent_at: new Date()
      });
      return 'sent';
    } catch (error) {
      // `claimRecipient` incremented the counter, so this is the number of the
      // attempt just made. Below the cap the row goes back to 'pending', which
      // is what `listPendingIds` looks for — leaving it 'failed' would put it
      // out of the loop's reach and make "three attempts" mean one.
      const terminal = Number(recipient.attempts || 0) >= MAX_ATTEMPTS;
      await WaBroadcast.updateRecipient(recipient.id, {
        status: terminal ? 'failed' : 'pending',
        error_msg: failureText(error)
      });
      return terminal ? 'failed' : 'retry';
    }
  }

  /**
   * The shape the browser may see.
   *
   * Built field by field like `publicAccount`, and for the same reason: a
   * column added later must not reach the browser by default.
   */
  /**
   * A timestamp the browser can read, whatever the driver handed back.
   *
   * The same column arrives three ways: a string from SQLite, a `Date` from
   * MySQL and Postgres, and — on the row a build has just written — whatever
   * the insert put there, which came out as epoch millis. All three are typed
   * `string | null` on the other side, so two of them are a lie the screen only
   * survives because its formatter is forgiving.
   */
  static asIso(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (typeof value === 'number') return new Date(value).toISOString();
    return String(value);
  }

  static publicBroadcast(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      status: row.status,
      totalCount: Number(row.total_count || 0),
      sentCount: Number(row.sent_count || 0),
      failedCount: Number(row.failed_count || 0),
      rateLimitPerMin: row.rate_limit_per_min ?? null,
      startAt: this.asIso(row.start_at),
      createdAt: this.asIso(row.created_at),
      updatedAt: this.asIso(row.updated_at)
    };
  }
}

/** What the operator will read in `error_msg`; a `WaError`'s message is a key. */
function failureText(error) {
  return [error?.code, error?.message]
    .filter(Boolean)
    .map(String)
    .join(' | ')
    .slice(0, ERROR_LIMIT);
}

export default WaBroadcastService;
