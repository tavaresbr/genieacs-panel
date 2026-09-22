import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: Setting } = await import('../src/models/Setting.js');

const resolve = (...args) => asTenant(() => SgpService.resolveDeviceContract(...args));
const identities = () => asTenant(() => DeviceService.getCustomerIdentityDevices());

/**
 * Two ONTs the SGP link used to miss while the subscriber was online:
 *
 * - a ZTE F-series with the Internet service on WAN connection 4, outside the
 *   indices the panel names in its projections;
 * - a Nokia whose login is configured in upper case, against a cadastre that
 *   holds it in lower case — the RADIUS accepts it, the SGP lookup did not.
 */
const ONT = {
  zte: { device: 'zte-f670l', login: 'st100.563', connection: 4 },
  nokia: { device: 'alcl-g0425g', login: 'TA100.034', connection: 1 }
};

/** What the SGP cadastre holds. Exact match, like the real lookup. */
const CADASTRE = new Map([
  ['st100.563', '593'],
  ['ta100.034', '34']
]);

let sgpServer;
let genieServer;
let lookups = [];

function document(ont) {
  return {
    _id: ont.device,
    _lastInform: new Date().toISOString(),
    InternetGatewayDevice: {
      DeviceInfo: { SoftwareVersion: { _value: 'V9.0.11P1N49B' } },
      WANDevice: {
        1: {
          WANConnectionDevice: {
            [ont.connection]: {
              WANPPPConnection: { 1: { Username: { _value: ont.login } } }
            }
          }
        }
      }
    }
  };
}

/** Copies the subtree at `path` from `source` into `target`, if it is there. */
function copyPath(source, target, path) {
  const keys = path.split('.');
  let from = source;
  for (const key of keys) {
    if (!from || typeof from !== 'object' || !(key in from)) return;
    from = from[key];
  }
  let to = target;
  keys.slice(0, -1).forEach((key) => {
    to[key] = to[key] && typeof to[key] === 'object' ? to[key] : {};
    to = to[key];
  });
  to[keys.at(-1)] = structuredClone(from);
}

/** A GenieACS that, like the real one, returns only what the projection names. */
function startGenieStub() {
  genieServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/devices')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('[]');
    }
    const raw = url.searchParams.get('query');
    const wanted = raw ? JSON.parse(raw)._id : null;
    const projection = (url.searchParams.get('projection') || '').split(',').filter(Boolean);
    const rows = Object.values(ONT)
      .filter((ont) => !wanted || ont.device === wanted)
      .map((ont) => {
        const full = document(ont);
        if (projection.length === 0) return full;
        const out = { _id: full._id };
        projection.forEach((path) => copyPath(full, out, path));
        return out;
      });
    res.writeHead(200, { 'Content-Type': 'application/json', total: String(rows.length) });
    res.end(JSON.stringify(rows));
  });
  return new Promise((done) => {
    genieServer.listen(0, '127.0.0.1', () => {
      done(`http://127.0.0.1:${genieServer.address().port}`);
    });
  });
}

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!req.url.startsWith('/api/ura/consultacliente')) {
        return res.end(JSON.stringify({ status: 1 }));
      }
      lookups.push(payload);
      const contract = CADASTRE.get(payload.login);
      return res.end(JSON.stringify({
        status: 1,
        contratos: contract
          ? [{ contrato: contract, contratoStatusDisplay: 'Ativo', login: payload.login, bloqueado: false }]
          : []
      }));
    });
  });
  return new Promise((done) => {
    sgpServer.listen(0, '127.0.0.1', () => {
      done(`http://127.0.0.1:${sgpServer.address().port}`);
    });
  });
}

before(async () => {
  await startTestServers();
  const [sgpUrl, genieUrl] = await Promise.all([startSgpStub(), startGenieStub()]);
  await asTenant(() => Setting.upsert('genieAcsUrl', genieUrl));
  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: 'painel', token: 'token-login', linkMode: 'pppoe'
  }));
});

after(async () => {
  await Promise.all([
    new Promise((done) => sgpServer.close(done)),
    new Promise((done) => genieServer.close(done))
  ]);
  await stopTestServers();
});

beforeEach(async () => {
  lookups = [];
  await asTenant(() => getDb()('sgp_links').del());
  await asTenant(() => getDb()('app_state').where({ key: DeviceService.PPPOE_PATH_KEY }).del());
});

describe('an ONT with its login past the catalogued WAN indices', () => {
  it('is linked by the login found in its full WAN tree', async () => {
    const { link } = await resolve(ONT.zte.device);

    assert.equal(lookups.at(-1).login, ONT.zte.login);
    assert.equal(link.contract, '593');
  });

  it('teaches the fleet reads where that login lives', async () => {
    const before = (await identities()).find((device) => device._id === ONT.zte.device);
    assert.equal(before.pppoe, null, 'not found at the catalogued paths');

    await resolve(ONT.zte.device);

    const after = (await identities()).find((device) => device._id === ONT.zte.device);
    assert.equal(after.pppoe, ONT.zte.login);
  });
});

describe('an ONT whose login case differs from the cadastre', () => {
  it('is linked once the lookup is retried in lower case', async () => {
    const { link } = await resolve(ONT.nokia.device);

    assert.deepEqual(lookups.map((payload) => payload.login), ['TA100.034', 'ta100.034']);
    assert.equal(link.contract, '34');
  });

  it('asks once when the login already matches', async () => {
    await resolve(ONT.zte.device);
    assert.equal(lookups.length, 1);
  });
});
