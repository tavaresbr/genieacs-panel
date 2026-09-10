import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: Setting } = await import('../src/models/Setting.js');
const {
  findPppoeUsername,
  normalizeRxPowerReading
} = await import('../src/services/deviceParameterFallbacks.js');

/** How GenieACS wraps a reported parameter. */
const param = (value) => ({ _value: value, _writable: false });

/**
 * A Nokia/Alcatel ONT on a GenieACS that never received the panel's
 * VirtualParameter scripts: the login and the optical reading are in the
 * device's own tree and `VirtualParameters` is not there at all.
 */
function bareOnt(index) {
  return {
    _id: `783EA1-G%2D1425G%2DB-ALCLFC52FE${index}`,
    _deviceId: {
      _SerialNumber: `ALCLFC52FE${index}`,
      _ProductClass: 'G-1425G-B',
      _Manufacturer: 'alcl'
    },
    InternetGatewayDevice: {
      DeviceInfo: { SoftwareVersion: param('3FE49362IJKJ21') },
      WANDevice: {
        1: {
          'X_ALU-COM_GponInterfaceConfig': { RXPower: param('-2153') },
          WANConnectionDevice: {
            1: { WANPPPConnection: { 1: { Username: param(`subscriber-${index}`) } } }
          }
        }
      }
    },
    _lastInform: new Date().toISOString(),
    _registered: new Date().toISOString()
  };
}

/** The same fleet, on a GenieACS whose VirtualParameters do answer. */
function scriptedOnt(index) {
  const device = bareOnt(index);
  return {
    ...device,
    VirtualParameters: {
      PPPUsername: param(`scripted-${index}`),
      OpticalRXPower: param('-19.87')
    }
  };
}

const genieAcs = {
  server: null,
  fleet: [],
  projections: []
};

function startGenieAcsStub() {
  return new Promise((resolve) => {
    genieAcs.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith('/devices')) {
        res.writeHead(404).end('[]');
        return;
      }
      genieAcs.projections.push(url.searchParams.get('projection') || '');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        total: String(genieAcs.fleet.length)
      }).end(JSON.stringify(genieAcs.fleet));
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

  await asTenant(async () => {
    await Setting.upsert('genieAcsUrl', `http://127.0.0.1:${genieAcs.server.address().port}`);
    await Setting.upsert('autoGenerateCustomerId', 'true');
  });
});

after(async () => {
  await new Promise((resolve) => genieAcs.server.close(resolve));
  await stopTestServers();
});

async function listDevices() {
  genieAcs.projections.length = 0;
  const { status, body } = await call(`${panelUrl}/api/devices`, { headers: authHeaders(token) });
  assert.equal(status, 200);
  return body.data.devices;
}

describe('optical RX readings in vendor units', () => {
  it('reads a value already expressed in dBm', () => {
    assert.equal(normalizeRxPowerReading('-21.53'), -21.53);
    assert.equal(normalizeRxPowerReading(-19), -19);
  });

  it('rescales tenths and hundredths of a dBm', () => {
    assert.equal(normalizeRxPowerReading('-215'), -21.5);
    assert.equal(normalizeRxPowerReading('-2153'), -21.53);
  });

  it('reads a value that carries its unit', () => {
    assert.equal(normalizeRxPowerReading('-21.53 dBm'), -21.53);
  });

  it('refuses a reading that is no optical power at any scale', () => {
    // Zero is what an ONT with nothing to report publishes; shown as 0 dBm it
    // would read as the strongest signal in the fleet.
    assert.equal(normalizeRxPowerReading(0), null);
    assert.equal(normalizeRxPowerReading('0'), null);
    assert.equal(normalizeRxPowerReading('-400000'), null);
    assert.equal(normalizeRxPowerReading('n/a'), null);
    assert.equal(normalizeRxPowerReading(null), null);
    assert.equal(normalizeRxPowerReading(undefined), null);
  });
});

describe('PPPoE login in the device tree', () => {
  const readValue = (node) => (node && typeof node === 'object' && '_value' in node ? node._value : node);

  it('finds a login whatever indices the ONT numbered its WAN objects with', () => {
    const item = {
      InternetGatewayDevice: {
        WANDevice: {
          1: { WANConnectionDevice: { 2: { WANIPConnection: { 1: {} } } } },
          2: { WANConnectionDevice: { 3: { WANPPPConnection: { 2: { Username: param('deep') } } } } }
        }
      }
    };
    assert.deepEqual(findPppoeUsername(item, readValue), {
      value: 'deep',
      path: 'InternetGatewayDevice.WANDevice.2.WANConnectionDevice.3.WANPPPConnection.2.Username'
    });
  });

  it('falls through to the TR-181 tree', () => {
    const item = { Device: { PPP: { Interface: { 1: { Username: param('tr181') } } } } };
    assert.deepEqual(findPppoeUsername(item, readValue), {
      value: 'tr181',
      path: 'Device.PPP.Interface.1.Username'
    });
  });

  it('treats a blank login as no login at all', () => {
    const item = {
      InternetGatewayDevice: {
        WANDevice: { 1: { WANConnectionDevice: { 1: { WANPPPConnection: { 1: { Username: param('  ') } } } } } }
      }
    };
    assert.equal(findPppoeUsername(item, readValue), null);
  });

  it('reports nothing for a bridged ONT', () => {
    assert.equal(findPppoeUsername({ InternetGatewayDevice: { WANDevice: {} } }, readValue), null);
  });
});

describe('GET /api/devices without VirtualParameters', () => {
  it('reads the subscriber and the optical RX out of the device tree', async () => {
    genieAcs.fleet = [bareOnt(1)];
    const [device] = await listDevices();

    assert.equal(device.pppoe, 'subscriber-1');
    assert.equal(device.rxpower, -21.53);
  });

  it('asks GenieACS for the fallback paths, which it would not return otherwise', async () => {
    genieAcs.fleet = [bareOnt(1)];
    await listDevices();

    const projection = genieAcs.projections.at(-1);
    assert.ok(projection.includes(
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username'
    ));
    assert.ok(projection.includes(
      'InternetGatewayDevice.WANDevice.1.X_ALU-COM_GponInterfaceConfig.RXPower'
    ));
  });

  it('generates the Customer ID the missing login used to block', async () => {
    genieAcs.fleet = [bareOnt(2)];
    const [device] = await listDevices();

    assert.equal(device.pppoe, 'subscriber-2');
    assert.ok(device.customerId, 'a device with a login on file gets a customer account');
  });

  it('leaves the configured VirtualParameters in charge where they do answer', async () => {
    genieAcs.fleet = [scriptedOnt(3)];
    const [device] = await listDevices();

    assert.equal(device.pppoe, 'scripted-3');
    assert.equal(device.rxpower, '-19.87');
  });
});
