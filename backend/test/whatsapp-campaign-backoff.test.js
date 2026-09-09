import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaBroadcast, MAX_ATTEMPTS } = await import('../src/models/WaBroadcast.js');
const { default: WaBroadcastService } = await import('../src/services/waBroadcastService.js');
const { retryDelayMs, retryScheduleMs } = await import('../src/services/waOutboxWorker.js');

/**
 * How long a campaign waits before giving up on a recipient.
 *
 * Be exact about the failure this guards against, because it is easy to state
 * wrongly: `WaBroadcastService.deliver` only ENQUEUES. It writes a row to
 * `wa_messages` and the outbox owns the transport, so an Evolution server that
 * is down never reaches its catch — that is the outbox's problem, and 0018
 * already survives it.
 *
 * What reaches this catch is `no_account`: the campaign is running and no
 * number is connected. Before 0019 that burned three attempts across about two
 * minutes and ended the entire campaign in `failed`, which is far less time
 * than an operator needs to notice a disconnected number and reconnect it.
 */
const wholeSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let campaignId;

function seedRecipient(patch = {}) {
  return asTenant(() => insertReturningId('wa_broadcast_recipients', {
    broadcast_id: campaignId,
    phone_e164: '5593981110000',
    rendered_body: 'sua fatura venceu',
    status: 'pending',
    attempts: 0,
    created_at: wholeSecond(Date.now()),
    ...patch
  }));
}

const recipient = (id) => asTenant(() => WaBroadcast.getRecipient(id));
const pendingIds = () => asTenant(() => WaBroadcast.listPendingIds(campaignId, 50));

before(async () => {
  await startTestServers();
  campaignId = await asTenant(() => insertReturningId('wa_broadcasts', {
    title: 'Cobrança de teste',
    body: 'sua fatura venceu',
    status: 'running'
  }));
});

after(async () => {
  await stopTestServers();
});

describe('a recipient waiting out a retry', () => {
  it('is invisible to the flush loop until it is due', async () => {
    const id = await seedRecipient({ next_attempt_at: wholeSecond(Date.now() + 10 * 60_000) });
    assert.ok(!(await pendingIds()).includes(id), 'not due, so not picked up');
  });

  it('cannot be claimed while it is waiting', async () => {
    const id = await seedRecipient({ next_attempt_at: wholeSecond(Date.now() + 10 * 60_000) });
    // `listPendingIds` and `claimRecipient` repeat the same test on purpose, so
    // that two overlapping ticks cannot both take a row. A claim that ignored
    // the due time would make the first assertion cosmetic.
    assert.equal(await asTenant(() => WaBroadcast.claimRecipient(id)), null);
  });

  it('is due again once its time has passed', async () => {
    const id = await seedRecipient({ next_attempt_at: wholeSecond(Date.now() - 60_000) });
    assert.ok((await pendingIds()).includes(id));
  });

  /**
   * The upgrade case, and the common one: NULL means due now. Every row written
   * before the column existed carries it, so a campaign that was in flight
   * during the upgrade must not stall.
   */
  it('treats a null due time as due now', async () => {
    const id = await seedRecipient({ next_attempt_at: null });
    assert.ok((await pendingIds()).includes(id));
  });
});

describe('what a campaign does with a number that is not connected', () => {
  /**
   * No `whatsapp_accounts` row exists in this suite, so `WaSendService.enqueue`
   * throws `no_account` — which is the real condition, reached the real way.
   */
  it('schedules another attempt instead of giving up in two minutes', async () => {
    const id = await seedRecipient();
    const before = Date.now();

    const outcome = await asTenant(() => WaBroadcastService.deliver(id, { id: 1 }));
    assert.equal(outcome, 'retry');

    const row = await recipient(id);
    assert.equal(row.status, 'pending', 'still the loop’s to take');
    assert.equal(Number(row.attempts), 1);
    assert.ok(row.next_attempt_at, 'and it now carries a due time');
    const due = new Date(row.next_attempt_at).getTime();
    assert.ok(due > before, 'in the future');
    assert.ok(
      due <= before + retryDelayMs(1) + 5_000,
      'and on the outbox’s own curve, not a second one'
    );
  });

  it('gives the operator longer than a glance to reconnect the number', async () => {
    // The decision is the window, not the curve, and a window measured in tens
    // of minutes cannot be tested by waiting for it.
    const total = retryScheduleMs(MAX_ATTEMPTS).reduce((sum, wait) => sum + wait, 0);
    assert.ok(
      total > 10 * 60_000,
      `a campaign should survive longer than ten minutes of a disconnected number, got ${total} ms`
    );
  });

  it('still gives up eventually, and leaves no due time behind when it does', async () => {
    const id = await seedRecipient({ attempts: MAX_ATTEMPTS });

    const outcome = await asTenant(() => WaBroadcastService.deliver(id, { id: 1 }));
    assert.equal(outcome, 'failed');

    const row = await recipient(id);
    assert.equal(row.status, 'failed');
    assert.equal(
      row.next_attempt_at,
      null,
      'a terminal row has nothing left to wait for, and a leftover time would outlive its reason'
    );
  });
});
