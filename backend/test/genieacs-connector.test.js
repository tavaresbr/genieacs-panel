import http from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The connection's credential is the point of this file, so the edition is
// stated rather than inherited from a developer's `.env`: the hosted edition is
// the one where the ACS is reached across the internet and an unauthenticated
// NBI is somebody else's fleet. `edition.js` reads it once at load, so
// everything under test is imported dynamically below.
process.env.EDITION = 'saas';

/**
 * Two stand-in ACS servers, one per provider, each recording exactly what
 * arrived. Two rather than one because the question this file exists to answer
 * is not "was a header sent" but "was THIS provider's header sent to THIS
 * provider's ACS" — a single server cannot tell those apart.
 */
function acs() {
  const host = { url: null, server: null, requests: [], status: 200, body: '[]' };
  host.reset = () => { host.requests.length = 0; host.status = 200; host.body = '[]'; };
  return host;
}

const alfaAcs = acs();
const betaAcs = acs();

function serve(host) {
  return new Promise((resolve, reject) => {
    host.server = http.createServer((req, res) => {
      host.requests.push({
        url: req.url,
        authorization: req.headers.authorization ?? null,
        host: req.headers.host
      });
      res.writeHead(host.status, { 'Content-Type': 'application/json' });
      res.end(host.body);
    });
    // Loud rather than hung: an unhandled listen error would surface as a
    // `before` that never settles and a wall of tests cancelled by their parent.
    host.server.once('error', reject);
    // Loopback is a blocked address class in this edition, so every connection
    // below is allowed through `allow_private_ranges` — which is itself one of
    // the things being tested, and is why a test that forgets to set it fails
    // loudly with a refusal rather than quietly reaching the wrong place.
    host.server.listen(0, '127.0.0.1', () => {
      host.url = `http://127.0.0.1:${host.server.address().port}`;
      resolve();
    });
  });
}

// The servers come up BEFORE anything is imported, because the egress guard
// reads its port allowlist once at load and only four ports are on it by
// default. Widening it for the two ports the OS just handed out is what lets
// this file use ephemeral ones — and ephemeral is what keeps it from colliding
// with `genieacs-egress.test.js`, which holds 7557. `node --test` runs files in
// parallel, and that collision does not report itself as a collision: it
// reports as a hung `before` and a wall of cancelled tests in the other file.
await Promise.all([serve(alfaAcs), serve(betaAcs)]);
process.env.GENIEACS_ALLOWED_PORTS = [alfaAcs, betaAcs]
  .map((host) => new URL(host.url).port)
  .join(',');

const {
  asTenant, authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: GenieAcsConnection } = await import('../src/models/GenieAcsConnection.js');
const { default: GenieAcsConnector, CONNECTOR_UNCONFIGURED, authorizationHeader } =
  await import('../src/services/genieacs/connector.js');
const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
const { default: Setting } = await import('../src/models/Setting.js');
const {
  inFlightForTenant, resetAcsConcurrency, withAcsSlot
} = await import('../src/services/genieacs/concurrency.js');

let panelUrl;
let token;
let alfa;
let beta;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1' }
  });
  token = setup.body.data.token;

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
});

after(async () => {
  await stopTestServers();
  await Promise.all([alfaAcs, betaAcs].map(
    (host) => new Promise((done) => host.server.close(done))
  ));
});

beforeEach(() => {
  alfaAcs.reset();
  betaAcs.reset();
});

afterEach(async () => {
  resetAcsConcurrency();
  await getDb()('tenant_genieacs_connections').del();
});

/** Gives a provider a connection row, reachable, with whatever else is asked. */
async function connect(tenantId, host, patch = {}) {
  return runInTenant(tenantId, () => GenieAcsConnection.save({
    base_url: host.url,
    allow_private_ranges: true,
    ...patch
  }));
}

describe('the Authorization header the panel never used to send', () => {
  it('sends Basic when the connection says basic', async () => {
    await connect(alfa, alfaAcs, {
      auth_type: 'basic',
      username: 'nbi-user',
      secret: 'nbi-password'
    });

    await runInTenant(alfa, () => DeviceService.fetchGenieAcsCollection('devices', { limit: 1 }));

    assert.equal(alfaAcs.requests.length, 1);
    assert.equal(
      alfaAcs.requests[0].authorization,
      `Basic ${Buffer.from('nbi-user:nbi-password').toString('base64')}`
    );
  });

  it('sends Bearer when the connection says bearer', async () => {
    await connect(alfa, alfaAcs, { auth_type: 'bearer', secret: 'nbi-token' });

    await runInTenant(alfa, () => DeviceService.fetchGenieAcsCollection('devices', { limit: 1 }));

    assert.equal(alfaAcs.requests[0].authorization, 'Bearer nbi-token');
  });

  it('sends nothing when the connection says none', async () => {
    await connect(alfa, alfaAcs, { auth_type: 'none', secret: 'left-over-from-before' });

    // Not merely absent from the header: `auth_type: 'none'` must not even
    // decrypt the stored secret, or a connection switched to unauthenticated
    // would still be reading the credential out of the database on every call
    // — and every one of those reads is a chance to log or return it.
    const realSecret = GenieAcsConnection.secret;
    let decrypted = 0;
    GenieAcsConnection.secret = function spy(...args) {
      decrypted += 1;
      return realSecret.apply(this, args);
    };
    try {
      await runInTenant(alfa, () => DeviceService.fetchGenieAcsCollection('devices', { limit: 1 }));
    } finally {
      GenieAcsConnection.secret = realSecret;
    }

    assert.equal(alfaAcs.requests[0].authorization, null);
    assert.equal(decrypted, 0);
  });

  it('reaches every device call site, not just the one that was checked', async () => {
    await connect(alfa, alfaAcs, { auth_type: 'bearer', secret: 'nbi-token' });

    // The seven sites used to call the egress guard directly, each building its
    // own URL. One of them keeping that shape would be a request made without a
    // credential and outside the concurrency ceiling, and nothing about the
    // response would say so.
    await runInTenant(alfa, async () => {
      await DeviceService.fetchFromGenieAcs('', { limit: 1 });
      await DeviceService.fetchGenieAcsWithHeaders({ limit: 1 });
      await DeviceService.deleteDevice('ONT-1');
      await DeviceService.deleteFault('fault-1');
      await DeviceService.mutateDeviceTag('ONT-1', 'Installed_20260101', 'POST');
      await DeviceService.postProvisioningTask('ONT-1', { name: 'refreshObject' });
    });

    assert.equal(alfaAcs.requests.length, 6);
    for (const request of alfaAcs.requests) {
      assert.equal(request.authorization, 'Bearer nbi-token', `unauthenticated: ${request.url}`);
    }
  });
});

describe('one provider\'s credential and another provider\'s ACS', () => {
  it('never sends a credential to the other provider\'s server', async () => {
    await connect(alfa, alfaAcs, { auth_type: 'bearer', secret: 'alfa-token' });
    await connect(beta, betaAcs, { auth_type: 'bearer', secret: 'beta-token' });

    await runInTenant(alfa, () => DeviceService.fetchGenieAcsCollection('devices'));
    await runInTenant(beta, () => DeviceService.fetchGenieAcsCollection('devices'));

    assert.equal(alfaAcs.requests.length, 1);
    assert.equal(betaAcs.requests.length, 1);
    assert.equal(alfaAcs.requests[0].authorization, 'Bearer alfa-token');
    assert.equal(betaAcs.requests[0].authorization, 'Bearer beta-token');
  });

  it('keeps the secret out of what a caller is handed', async () => {
    await connect(alfa, alfaAcs, { auth_type: 'bearer', secret: 'alfa-token' });

    const connection = await runInTenant(alfa, () => GenieAcsConnection.current());

    // The object that reaches a controller, a log line or an API response must
    // not be carrying the credential: a caller that needs it asks for it by
    // name, so that leaking it takes a deliberate act rather than an oversight.
    assert.equal(JSON.stringify(connection).includes('alfa-token'), false);
    for (const key of ['secret', 'secret_ciphertext', 'secret_iv', 'secret_tag']) {
      assert.equal(key in connection, false, `current() exposes ${key}`);
    }
  });
});

describe('where the base URL comes from', () => {
  it('prefers the connection row over the setting', async () => {
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', betaAcs.url));
    await connect(alfa, alfaAcs);

    await runInTenant(alfa, () => DeviceService.fetchGenieAcsCollection('devices'));

    assert.equal(alfaAcs.requests.length, 1);
    assert.equal(betaAcs.requests.length, 0);
  });

  it('falls back to the setting while the row has no URL', async () => {
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', alfaAcs.url));
    await connect(alfa, alfaAcs, { base_url: null });

    await runInTenant(alfa, () => DeviceService.fetchGenieAcsCollection('devices'));

    assert.equal(alfaAcs.requests.length, 1);
  });

  it('follows the setting when the screen saves one', async () => {
    await connect(alfa, alfaAcs, { base_url: null });

    const saved = await call(`${panelUrl}/api/settings/genieAcsUrl`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { value: alfaAcs.url }
    });
    assert.equal(saved.status, 200);

    // Two writable places for one fact is how configuration drifts, and the
    // drift is invisible: the screen shows one ACS while the panel talks to
    // another. The write-through is what stops that until phase 6 moves the
    // field onto the connection screen.
    const connection = await runInTenant(alfa, () => GenieAcsConnection.current());
    assert.equal(connection.base_url, alfaAcs.url);
  });

  it('refuses a URL carrying credentials rather than sending them', async () => {
    await connect(alfa, alfaAcs, { base_url: 'http://user:secret@127.0.0.1:7557' });

    await assert.rejects(
      runInTenant(alfa, () => DeviceService.fetchGenieAcsCollection('devices')),
      (error) => error.code === CONNECTOR_UNCONFIGURED
    );
  });
});

describe('a mode that has no transport behind it', () => {
  it('refuses `agent` by name instead of silently going direct', async () => {
    await connect(alfa, alfaAcs, { mode: 'agent' });

    // The agent mode is the ISP dialling OUT to us; there is nothing listening
    // at the base URL at all. Treated as `direct` it would reach whatever else
    // answers there and report the difference as an outage — so it has to fail
    // saying which mode is missing.
    const error = await runInTenant(alfa, () => DeviceService
      .fetchGenieAcsCollection('devices')
      .then(() => null, (caught) => caught));

    assert.equal(error?.code, CONNECTOR_UNCONFIGURED);
    assert.match(error.message, /agent/);
    assert.equal(alfaAcs.requests.length, 0);
  });

  it('lets `tunnel` and `hosted` through as the same transport', async () => {
    for (const mode of ['tunnel', 'hosted']) {
      await connect(alfa, alfaAcs, { mode });
      await runInTenant(alfa, () => DeviceService.fetchGenieAcsCollection('devices'));
    }
    assert.equal(alfaAcs.requests.length, 2);
  });
});

describe('the egress decisions the connection carries', () => {
  it('refuses a private address when the provider is not allowed one', async () => {
    await connect(alfa, alfaAcs, { allow_private_ranges: false });

    // This is what every OTHER case in this file is turning off, so it is worth
    // proving it is actually on: without it, `allow_private_ranges: true` above
    // would be decorative and the tests would pass for the wrong reason.
    await assert.rejects(
      runInTenant(alfa, () => DeviceService.fetchGenieAcsCollection('devices')),
      /loopback/
    );
    assert.equal(alfaAcs.requests.length, 0);
  });

  it('passes verify_tls down to the transport', async () => {
    await connect(alfa, alfaAcs, { verify_tls: false });

    const seen = [];
    const realFetch = GenieAcsEgress.fetch;
    GenieAcsEgress.fetch = async (url, options) => {
      seen.push(options);
      return realFetch.call(GenieAcsEgress, url, options);
    };
    try {
      await runInTenant(alfa, () => DeviceService.fetchGenieAcsCollection('devices'));
    } finally {
      GenieAcsEgress.fetch = realFetch;
    }

    assert.equal(seen[0].rejectUnauthorized, false);
    assert.equal(seen[0].allowPrivateAddresses, true);
  });
});

describe('the credential and the "test connection" button', () => {
  it('does not send the stored credential to an address it does not belong to', async () => {
    await connect(alfa, alfaAcs, { auth_type: 'bearer', secret: 'alfa-token' });

    const result = await call(`${panelUrl}/api/settings/test-genieacs`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { url: betaAcs.url }
    });

    // The button posts the URL to try, which makes it the one call whose
    // destination the caller names. Sending the stored NBI password there would
    // be a way to read the credential back out in plaintext: point it at a
    // server you control and read the header off the wire.
    assert.equal(result.status, 200);
    assert.equal(betaAcs.requests.length, 1);
    assert.equal(betaAcs.requests[0].authorization, null);
  });

  it('does send it when the address under test is the one it belongs to', async () => {
    await connect(alfa, alfaAcs, { auth_type: 'bearer', secret: 'alfa-token' });

    const result = await call(`${panelUrl}/api/settings/test-genieacs`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { url: `${alfaAcs.url}/devices` }
    });

    assert.equal(result.status, 200);
    assert.equal(alfaAcs.requests[0].authorization, 'Bearer alfa-token');
  });

  it('does not file a candidate URL\'s failure against the configured one', async () => {
    await connect(alfa, alfaAcs, { auth_type: 'bearer', secret: 'alfa-token' });
    betaAcs.status = 500;

    const result = await call(`${panelUrl}/api/settings/test-genieacs`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { url: betaAcs.url }
    });

    // An operator trying a URL they are still typing must not end up looking at
    // a screen that says the ACS they are actually using has gone down.
    assert.equal(result.status, 502);
    const connection = await runInTenant(alfa, () => GenieAcsConnection.current());
    assert.equal(connection.status, 'unknown');
    assert.equal(connection.last_check_at, null);
  });

  it('records what the check concluded', async () => {
    await connect(alfa, alfaAcs, { auth_type: 'bearer', secret: 'alfa-token' });
    alfaAcs.status = 401;
    alfaAcs.body = '{"message":"unauthorized"}';

    const result = await call(`${panelUrl}/api/settings/test-genieacs`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { url: alfaAcs.url }
    });

    assert.equal(result.status, 502);
    const connection = await runInTenant(alfa, () => GenieAcsConnection.current());
    assert.equal(connection.status, 'error');
    assert.equal(connection.last_error, 'HTTP 401');
    assert.ok(connection.last_check_at);

    // The upstream body is written by whoever answers at a customer-named URL.
    // It must not come back through the API, and it must not be filed in the
    // database either — that would only move the read oracle, not close it.
    assert.equal(JSON.stringify(result.body).includes('unauthorized'), false);
    assert.equal(String(connection.last_error).includes('unauthorized'), false);
  });
});

describe('the ceiling on ACS requests in flight', () => {
  it('holds one provider to its own cap', async () => {
    const { TENANT_LIMIT } = await import('../src/services/genieacs/concurrency.js');
    let peak = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });

    const started = [];
    const runs = Array.from({ length: TENANT_LIMIT + 3 }, () => runInTenant(alfa, () => withAcsSlot(async () => {
      const now = runInTenant(alfa, () => inFlightForTenant());
      peak = Math.max(peak, await now);
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
    const { TENANT_LIMIT } = await import('../src/services/genieacs/concurrency.js');
    let release;
    const held = new Promise((resolve) => { release = resolve; });

    // A provider with a slow ACS fills its own cap and queues the rest. The
    // failure this guards against is the whole panel queueing behind it — which
    // is exactly what one shared ceiling, or none, produces.
    const busy = Array.from({ length: TENANT_LIMIT * 2 }, () =>
      runInTenant(alfa, () => withAcsSlot(() => held)));

    let served = false;
    const other = runInTenant(beta, () => withAcsSlot(async () => { served = true; }));
    await other;

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
});

describe('the header builder on its own', () => {
  it('omits the header rather than sending an empty credential', () => {
    assert.equal(authorizationHeader({ auth_type: 'bearer' }, ''), null);
    assert.equal(authorizationHeader({ auth_type: 'none', username: 'x' }, 'y'), null);
    assert.equal(authorizationHeader({ auth_type: 'basic', username: null }, ''), null);
  });

  it('allows a Basic pair with an empty password, which some NBIs use', () => {
    assert.equal(
      authorizationHeader({ auth_type: 'basic', username: 'nbi' }, ''),
      `Basic ${Buffer.from('nbi:').toString('base64')}`
    );
  });
});
