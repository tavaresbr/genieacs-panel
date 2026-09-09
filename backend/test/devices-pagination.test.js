import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: Setting } = await import('../src/models/Setting.js');

const FLEET_SIZE = 30;
const ONLINE_COUNT = 12;
const ONLINE_WINDOW_MS = 10 * 60 * 1000;

/**
 * GenieACS documents as the NBI returns them. The first ONLINE_COUNT devices
 * informed a minute ago, the rest a day ago, so the 10-minute online window
 * splits the fleet deterministically.
 */
function buildFleet() {
  const now = Date.now();
  return Array.from({ length: FLEET_SIZE }, (_, index) => ({
    _id: `ONT-${String(index).padStart(3, '0')}`,
    _deviceId: {
      _SerialNumber: `SN${String(index).padStart(4, '0')}`,
      _ProductClass: index % 2 === 0 ? 'HG8245Q2' : 'F670L',
      _Manufacturer: index % 2 === 0 ? 'Huawei' : 'ZTE'
    },
    _lastInform: new Date(
      now - (index < ONLINE_COUNT ? 60_000 : 24 * 60 * 60 * 1000)
    ).toISOString(),
    _registered: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  }));
}

const fleet = buildFleet();

/** Minimal evaluator for the `_lastInform` range queries the panel pushes down. */
function matchesQuery(device, query) {
  if (!query) return true;
  const condition = query._lastInform;
  if (!condition) return true;
  const value = new Date(device._lastInform).getTime();
  if (condition.$gte !== undefined && !(value >= new Date(condition.$gte).getTime())) {
    return false;
  }
  if (condition.$lt !== undefined && !(value < new Date(condition.$lt).getTime())) {
    return false;
  }
  return true;
}

const genieAcs = {
  server: null,
  requests: [],
  sendTotalHeader: true
};

function startGenieAcsStub() {
  return new Promise((resolve) => {
    genieAcs.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith('/devices')) {
        res.writeHead(404).end('[]');
        return;
      }
      genieAcs.requests.push({
        query: url.searchParams.get('query'),
        skip: url.searchParams.get('skip'),
        limit: url.searchParams.get('limit'),
        projection: url.searchParams.get('projection')
      });

      const rawQuery = url.searchParams.get('query');
      const query = rawQuery ? JSON.parse(rawQuery) : null;
      const matched = fleet.filter((device) => matchesQuery(device, query));

      const skip = Number.parseInt(url.searchParams.get('skip') ?? '', 10);
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
      let page = matched;
      if (Number.isFinite(skip)) page = page.slice(skip);
      if (Number.isFinite(limit)) page = page.slice(0, limit);

      const headers = { 'Content-Type': 'application/json' };
      if (genieAcs.sendTotalHeader) headers.total = String(matched.length);
      res.writeHead(200, headers).end(JSON.stringify(page));
    });
    genieAcs.server.listen(0, '127.0.0.1', () => resolve());
  });
}

let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  await startGenieAcsStub();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1' }
  });
  token = setup.body.data.token;

  await asTenant(() => Setting.upsert(
    'genieAcsUrl',
    `http://127.0.0.1:${genieAcs.server.address().port}`
  ));
});

after(async () => {
  await new Promise((resolve) => genieAcs.server.close(resolve));
  await stopTestServers();
});

async function listDevices(search = '') {
  return call(`${panelUrl}/api/devices${search}`, { headers: authHeaders(token) });
}

describe('GET /api/devices pagination', () => {
  it('requires authentication', async () => {
    const { status } = await call(`${panelUrl}/api/devices`);
    assert.equal(status, 401);
  });

  it('returns the first page with default paging metadata', async () => {
    const { status, body } = await listDevices();
    assert.equal(status, 200);
    assert.equal(body.data.page, 1);
    assert.equal(body.data.pageSize, 25);
    assert.equal(body.data.total, FLEET_SIZE);
    assert.equal(body.data.totalPages, 2);
    assert.equal(body.data.devices.length, 25);
    // The per-device shape stayed the same as the unpaged listing.
    assert.equal(body.data.devices[0].SerialNumber, 'SN0029');
    assert.ok('customerId' in body.data.devices[0]);
    assert.ok('rxpower' in body.data.devices[0]);
  });

  it('clamps pageSize to the hard cap and rejects junk values', async () => {
    const capped = await listDevices('?pageSize=500');
    assert.equal(capped.body.data.pageSize, 100);
    assert.equal(capped.body.data.devices.length, FLEET_SIZE);

    const junk = await listDevices('?pageSize=abc&page=-4');
    assert.equal(junk.body.data.pageSize, 25);
    assert.equal(junk.body.data.page, 1);

    const zero = await listDevices('?pageSize=0');
    assert.equal(zero.body.data.pageSize, 25);
  });

  it('reports totals that match the rows returned', async () => {
    const { body } = await listDevices('?pageSize=10&page=3');
    assert.equal(body.data.total, FLEET_SIZE);
    assert.equal(body.data.totalPages, 3);
    assert.equal(body.data.page, 3);
    assert.equal(body.data.devices.length, 10);
  });

  it('serves different rows on page 2 than on page 1', async () => {
    const first = await listDevices('?pageSize=10&page=1');
    const second = await listDevices('?pageSize=10&page=2');

    const firstIds = first.body.data.devices.map((device) => device._id);
    const secondIds = second.body.data.devices.map((device) => device._id);

    assert.equal(firstIds.length, 10);
    assert.equal(secondIds.length, 10);
    assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0);
    assert.equal(new Set([...firstIds, ...secondIds]).size, 20);
  });

  it('clamps a page beyond the end back onto the last page', async () => {
    const { body } = await listDevices('?pageSize=10&page=99');
    assert.equal(body.data.page, 3);
    assert.equal(body.data.devices.length, 10);
  });

  it('pushes the status filter to GenieACS and pages the result', async () => {
    const online = await listDevices('?status=online&pageSize=5');
    assert.equal(online.body.data.total, ONLINE_COUNT);
    assert.equal(online.body.data.totalPages, 3);
    assert.equal(online.body.data.devices.length, 5);

    const now = Date.now();
    for (const device of online.body.data.devices) {
      assert.ok(now - new Date(device._lastInform).getTime() < ONLINE_WINDOW_MS);
    }

    const offline = await listDevices('?status=offline&pageSize=100');
    assert.equal(offline.body.data.total, FLEET_SIZE - ONLINE_COUNT);
    assert.equal(offline.body.data.devices.length, FLEET_SIZE - ONLINE_COUNT);
    for (const device of offline.body.data.devices) {
      assert.ok(now - new Date(device._lastInform).getTime() >= ONLINE_WINDOW_MS);
    }

    const forwarded = genieAcs.requests.at(-1);
    assert.ok(forwarded.query, 'the status filter must reach GenieACS');
    assert.ok(JSON.parse(forwarded.query)._lastInform.$lt);
  });

  it('falls back to an unfiltered status for an unknown value', async () => {
    const { body } = await listDevices('?status=banana');
    assert.equal(body.data.total, FLEET_SIZE);
  });

  it('searches server-side across serial, model and vendor', async () => {
    const bySerial = await listDevices('?search=SN0007');
    assert.equal(bySerial.body.data.total, 1);
    assert.equal(bySerial.body.data.devices[0]._id, 'ONT-007');

    const byVendor = await listDevices('?search=zte&pageSize=10');
    assert.equal(byVendor.body.data.total, FLEET_SIZE / 2);
    assert.equal(byVendor.body.data.devices.length, 10);
    assert.equal(byVendor.body.data.totalPages, 2);

    const empty = await listDevices('?search=no-such-device');
    assert.equal(empty.body.data.total, 0);
    assert.equal(empty.body.data.totalPages, 0);
    assert.deepEqual(empty.body.data.devices, []);
  });

  it('combines a search with the pushed-down status filter', async () => {
    const { body } = await listDevices('?search=zte&status=online');
    // Odd indices are ZTE, and indices below 12 are online: 1, 3, 5, 7, 9, 11.
    assert.equal(body.data.total, 6);
    assert.equal(body.data.devices.length, 6);
  });

  it('counts without the total header when GenieACS omits it', async () => {
    genieAcs.sendTotalHeader = false;
    try {
      const { body } = await listDevices('?pageSize=10&page=2');
      assert.equal(body.data.total, FLEET_SIZE);
      assert.equal(body.data.totalPages, 3);
      assert.equal(body.data.devices.length, 10);
    } finally {
      genieAcs.sendTotalHeader = true;
    }
  });
});
