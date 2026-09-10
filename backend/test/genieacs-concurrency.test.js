import { afterEach, before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { getDb, runInTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const {
  GLOBAL_LIMIT, TENANT_LIMIT, inFlightForTenant, resetAcsConcurrency, withAcsSlot
} = await import('../src/services/genieacs/concurrency.js');

/**
 * The ceiling on ACS requests in flight — item 8 of the checklist.
 *
 * The dashboard read fetches a provider's whole device collection, and with
 * dozens of providers in one process the failure is not a slow dashboard: it is
 * every provider's request queued behind one provider's fleet. The per-provider
 * cap is what isolates; the global one keeps sockets and heap bounded.
 */
let alfa;
let beta;

before(async () => {
  await startTestServers();
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
});

after(async () => {
  await stopTestServers();
});

afterEach(() => {
  resetAcsConcurrency();
});

describe('the ceiling on ACS requests in flight', () => {
  it('has a per-provider cap below the global one', () => {
    assert.ok(TENANT_LIMIT > 0);
    assert.ok(GLOBAL_LIMIT >= TENANT_LIMIT);
  });

  it('holds one provider to its own cap', async () => {
    let peak = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });

    const started = [];
    const runs = Array.from({ length: TENANT_LIMIT + 3 }, () => runInTenant(alfa, () => withAcsSlot(async () => {
      peak = Math.max(peak, await runInTenant(alfa, () => inFlightForTenant()));
      started.push(1);
      await held;
    })));

    // Long enough for every runnable slot to be taken; the ones over the cap
    // cannot start at all, which is the assertion.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, TENANT_LIMIT);
    release();
    await Promise.all(runs);
    assert.equal(peak, TENANT_LIMIT);
  });

  it('does not let one provider\'s queue stall another', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });

    // A provider with a slow ACS fills its own cap and queues the rest. The
    // failure this guards against is the whole panel queueing behind it — which
    // is exactly what one shared ceiling, or none, produces.
    const busy = Array.from({ length: TENANT_LIMIT * 2 }, () =>
      runInTenant(alfa, () => withAcsSlot(() => held)));

    let served = false;
    await runInTenant(beta, () => withAcsSlot(async () => { served = true; }));

    assert.equal(served, true);
    release();
    await Promise.all(busy);
  });

  it('gives the slot back when the request throws', async () => {
    await assert.rejects(
      runInTenant(alfa, () => withAcsSlot(() => { throw new Error('upstream is down'); })),
      /upstream is down/
    );

    // A slot leaked on failure is worse than no ceiling: an ACS that is failing
    // is exactly the one whose provider retries, so the cap would fill with
    // nothing and the provider would be locked out of its own panel.
    assert.equal(await runInTenant(alfa, () => inFlightForTenant()), 0);
  });

  it('refuses to hand out a slot to nobody', async () => {
    // Outside a provider scope there is no bucket to charge, and charging the
    // global one alone would let a scope-less caller bypass every per-provider
    // cap. The tenant context already throws here; this pins that the ceiling
    // does not soften it.
    await assert.rejects(() => withAcsSlot(async () => 'ran'));
  });
});
