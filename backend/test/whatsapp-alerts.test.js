import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');

// A scan reached directly has no request behind it, so nothing has resolved a
// provider — the same position the timer is in, and why `tick` opens one. The
// routes that call `scan` are already inside a request.
const scan = (options) => asTenant(() => WaAlertService.scan(options));
const { default: WaAlertService, LAST_SCAN_KEY } = await import('../src/services/waAlertService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');

const ALERTS = 'painel-alertas';
const ON_CALL = '5593981110001';
const SECOND_ON_CALL = '5593981110002';

let panelUrl;
let token;
let alertsAccountId;

/**
 * The telemetry is stubbed rather than served by a GenieACS.
 *
 * What is under test is the rules and the noise control, and both are pure
 * functions of a fleet read. Standing up an ACS would test the reader in
 * `deviceService`, which has its own tests, and would make "an ONT that has
 * been offline for exactly thirty minutes" impossible to write down.
 */
let fleet = [];
let identities = [];
let realDashboardDevices;
let realIdentityDevices;

const MINUTE = 60_000;
const now = () => Date.now();
const informedMinutesAgo = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString();

function device(id, patch = {}) {
  return {
    _id: id,
    rxpower: -20,
    temperature: 45,
    _lastInform: informedMinutesAgo(1),
    ...patch
  };
}

async function outbox() {
  return getDb()('wa_messages').where({ direction: 'out' }).orderBy('id');
}

async function alertRows() {
  return getDb()('wa_alert_state').orderBy('id');
}

/** Each test starts from an empty outbox and no open condition. */
async function reset() {
  await getDb()('wa_messages').del();
  await getDb()('wa_alert_state').del();
  fleet = [];
  identities = [];
  WaAlertService.settingsCache.clear();
}

async function setRules(rules, extra = {}) {
  // Scoped for the same reason `scan` is: saving settings reads back the
  // alert number to report whether alerts are actually deliverable.
  await asTenant(() => WaAlertService.saveSettings({
    enabled: true,
    recipients: [ON_CALL],
    rules,
    ...extra
  }));
}

/** Only the rule under test is on, so no fixture can trip a second one. */
const onlyRule = (rule, patch = {}) => ({
  ont_offline: { enabled: false },
  rx_power_low: { enabled: false },
  temperature_high: { enabled: false },
  mass_outage: { enabled: false },
  [rule]: { enabled: true, ...patch }
});

before(async () => {
  ({ panelUrl } = await startTestServers());

  realDashboardDevices = DeviceService.getDashboardDevices;
  realIdentityDevices = DeviceService.getCustomerIdentityDevices;
  DeviceService.getDashboardDevices = async () => fleet;
  DeviceService.getCustomerIdentityDevices = async () => identities;

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook'
  }));

  const account = await asTenant(() => WhatsAppAccount.create({
    name: ALERTS,
    purpose: 'alerts',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-alertas'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-alertas')
  }));
  alertsAccountId = account.id;
});

after(async () => {
  DeviceService.getDashboardDevices = realDashboardDevices;
  DeviceService.getCustomerIdentityDevices = realIdentityDevices;
  WaAlertService.stop();
  await stopTestServers();
});

beforeEach(reset);

describe('the settings routes', () => {
  it('hands back the four rules with their thresholds', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.deepEqual(
      Object.keys(body.data.rules).sort(),
      ['mass_outage', 'ont_offline', 'rx_power_low', 'temperature_high']
    );
    for (const rule of Object.values(body.data.rules)) {
      assert.equal(typeof rule.enabled, 'boolean');
      assert.equal(typeof rule.cooldownMinutes, 'number');
    }
    assert.ok(Array.isArray(body.data.recipients));
  });

  it('saves what it is given and refuses a number it cannot dial', async () => {
    const saved = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: {
        enabled: true,
        intervalSeconds: 120,
        recipients: [ON_CALL, SECOND_ON_CALL],
        rules: { ont_offline: { enabled: true, threshold: 45, cooldownMinutes: 90 } }
      }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.intervalSeconds, 120);
    assert.deepEqual(saved.body.data.recipients, [ON_CALL, SECOND_ON_CALL]);
    assert.equal(saved.body.data.rules.ont_offline.threshold, 45);
    // The three rules the request did not mention keep their stored values.
    assert.equal(saved.body.data.rules.rx_power_low.threshold, -27);

    const refused = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { recipients: ['nao-e-um-telefone'] }
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'invalid_phone');
  });

  it('refuses to be enabled with nobody on duty, under its own code', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { enabled: true, recipients: [] }
    });
    assert.equal(status, 400);
    // Not the campaign's `no_recipients`, which means "the filters left nobody
    // to charge". A form that translates the code would put that sentence on
    // this screen.
    assert.equal(body.code, 'no_alert_recipients');

    // And the refusal is not a silent no-op: the stored list is untouched.
    const after = await call(`${panelUrl}/api/whatsapp/alerts/settings`, { headers: authHeaders(token) });
    assert.deepEqual(after.body.data.recipients, [ON_CALL, SECOND_ON_CALL]);
  });

  it('an emptied threshold goes back to the default, never to zero', async () => {
    // `Number(null)` and `Number('')` are both 0, and 0 is finite. Read after
    // the conversion, a box the operator cleared would be stored as a threshold
    // of zero — and `temperature_high` at 0 °C alerts on the whole fleet,
    // forever, which is the loudest possible way to be wrong.
    for (const empty of [null, '']) {
      const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: { rules: { temperature_high: { enabled: true, threshold: empty } } }
      });
      assert.equal(status, 200);
      assert.equal(body.data.rules.temperature_high.threshold, 70, `for ${JSON.stringify(empty)}`);
    }

    // And a real zero, typed on purpose, is still a zero.
    const zero = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { rules: { rx_power_low: { enabled: true, threshold: 0 } } }
    });
    assert.equal(zero.body.data.rules.rx_power_low.threshold, 0);
  });
});

describe('each rule fires at its threshold and not just inside it', () => {
  it('ont_offline fires at the threshold in minutes, not before', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 120 }));

    fleet = [device('dev-quase', { _lastInform: informedMinutesAgo(29) })];
    let summary = await scan({ now: now() });
    assert.equal(summary.fired, 0, 'twenty-nine minutes is inside the window');
    assert.equal((await outbox()).length, 0);

    fleet = [device('dev-fora', { _lastInform: informedMinutesAgo(30) })];
    summary = await scan({ now: now() });
    assert.equal(summary.fired, 1);
    const rows = await alertRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rule, 'ont_offline');
    assert.equal(rows[0].subject, 'dev-fora');
    const enviadas = await outbox();
    assert.equal(enviadas.length, 1);
    // The on-duty thread is a conversation like any other, so the bot reads it
    // too. Unnamed, a busy night would have counted against the bot's ceiling
    // for whoever is on call.
    assert.equal(enviadas[0].source, 'alert');
  });

  it('rx_power_low fires at the threshold in dBm, not just above it', async () => {
    await setRules(onlyRule('rx_power_low', { threshold: -27, cooldownMinutes: 360 }));

    fleet = [device('dev-ok', { rxpower: -26.9 })];
    let summary = await scan({ now: now() });
    assert.equal(summary.fired, 0);

    fleet = [device('dev-fraco', { rxpower: -27 })];
    summary = await scan({ now: now() });
    assert.equal(summary.fired, 1);
    assert.equal((await alertRows())[0].rule, 'rx_power_low');
  });

  it('temperature_high fires at the threshold in °C, not just below it', async () => {
    await setRules(onlyRule('temperature_high', { threshold: 70, cooldownMinutes: 360 }));

    fleet = [device('dev-morno', { temperature: 69.9 })];
    let summary = await scan({ now: now() });
    assert.equal(summary.fired, 0);

    fleet = [device('dev-quente', { temperature: 70 })];
    summary = await scan({ now: now() });
    assert.equal(summary.fired, 1);
    assert.equal((await alertRows())[0].rule, 'temperature_high');
  });
});

describe('a firing condition speaks once', () => {
  it('notifies once and then stays quiet until the cooldown passes', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 60 }));
    fleet = [device('dev-teimoso', { _lastInform: informedMinutesAgo(120) })];

    const first = await scan({ now: now() });
    assert.equal(first.fired, 1);
    assert.equal((await outbox()).length, 1);

    // Three more passes over the same unchanged fault.
    await scan({ now: now() });
    await scan({ now: now() });
    await scan({ now: now() });
    assert.equal((await outbox()).length, 1, 'a repeated alert is how a channel gets muted');
    let row = (await alertRows())[0];
    assert.equal(Number(row.notify_count), 1);
    assert.equal(row.state, 'firing');

    // The cooldown is measured from `last_notified_at`, so backdating it is the
    // same thing as an hour going by.
    await getDb()('wa_alert_state')
      .where({ id: row.id })
      .update({ last_notified_at: new Date(Date.now() - 61 * MINUTE) });

    const later = await scan({ now: now() });
    assert.equal(later.fired, 0, 'a repeat is not a new condition');
    assert.equal((await outbox()).length, 2);
    row = (await alertRows())[0];
    assert.equal(Number(row.notify_count), 2);
  });
});

describe('a recovery is a message too', () => {
  it('says so once and clears the row', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 60 }));
    fleet = [device('dev-volta', { _lastInform: informedMinutesAgo(120) })];
    await scan({ now: now() });
    const alerted = await outbox();
    assert.equal(alerted.length, 1);

    fleet = [device('dev-volta', { _lastInform: informedMinutesAgo(1) })];
    const summary = await scan({ now: now() });
    assert.equal(summary.cleared, 1);
    assert.equal((await alertRows()).length, 0, 'the row goes with the fault');

    const messages = await outbox();
    assert.equal(messages.length, 2);
    assert.notEqual(
      messages[1].body,
      messages[0].body,
      'a recovery that reads like the alarm is read as a second alarm'
    );

    // And only once: a cleared condition has nothing left to say.
    await scan({ now: now() });
    assert.equal((await outbox()).length, 2);
  });
});

describe('a mass outage is one message, not forty', () => {
  before(async () => {
    // One ODP with six ONTs hanging off it, plus one ONT on a second ODP that
    // never goes down — so the grouping has something to NOT include.
    await insertReturningId('mapping_nodes', {
      node_id: 'ODP-1', type: 'odp', name: 'ODP Centro', latitude: -3.1, longitude: -60.0
    });
    await insertReturningId('mapping_nodes', {
      node_id: 'ODP-2', type: 'odp', name: 'ODP Bairro', latitude: -3.2, longitude: -60.1
    });
    for (let index = 1; index <= 6; index += 1) {
      await insertReturningId('mapping_nodes', {
        node_id: `ONT-${index}`,
        type: 'ont',
        name: `Assinante ${index}`,
        latitude: -3.1,
        longitude: -60.0,
        pppoe: `cliente${index}`
      });
      await getDb()('mapping_edges').insert({
        edge_id: `E-${index}`,
        source: `ONT-${index}`,
        target: index === 6 ? 'ODP-2' : 'ODP-1',
        fiber_type: 'drop'
      });
    }
  });

  it('names the node, counts the ONTs, and holds back the individual alerts', async () => {
    await setRules({
      ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 60 },
      mass_outage: { enabled: true, threshold: 5, cooldownMinutes: 60 },
      rx_power_low: { enabled: false },
      temperature_high: { enabled: false }
    });

    identities = Array.from({ length: 6 }, (unused, index) => ({
      _id: `dev-${index + 1}`,
      pppoe: `cliente${index + 1}`
    }));
    // The five on ODP-1 drop together; the one on ODP-2 stays up.
    fleet = identities.map((item, index) => device(item._id, {
      _lastInform: index < 5 ? informedMinutesAgo(45) : informedMinutesAgo(1)
    }));

    const summary = await scan({ now: now() });
    assert.equal(summary.fired, 1, 'one fibre cut is one alert');

    const rows = await alertRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rule, 'mass_outage');
    assert.equal(rows[0].subject, 'ODP-1');

    const messages = await outbox();
    assert.equal(messages.length, 1, 'forty messages at 3 a.m. is how alerting gets muted');
  });

  it('leaves an ONT on an unaffected node to its own alert', async () => {
    await setRules({
      ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 60 },
      mass_outage: { enabled: true, threshold: 5, cooldownMinutes: 60 },
      rx_power_low: { enabled: false },
      temperature_high: { enabled: false }
    });

    identities = Array.from({ length: 6 }, (unused, index) => ({
      _id: `dev-${index + 1}`,
      pppoe: `cliente${index + 1}`
    }));
    // Four on ODP-1: under the threshold, so nothing is grouped and each one
    // is announced on its own.
    fleet = identities.map((item, index) => device(item._id, {
      _lastInform: index < 4 ? informedMinutesAgo(45) : informedMinutesAgo(1)
    }));

    const summary = await scan({ now: now() });
    assert.equal(summary.fired, 4);
    const rules = new Set((await alertRows()).map((row) => row.rule));
    assert.deepEqual([...rules], ['ont_offline']);
  });
});

describe('a scan that cannot say anything says why', () => {
  it('does nothing at all when no number carries the alerts purpose', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30 }));
    fleet = [device('dev-mudo', { _lastInform: informedMinutesAgo(120) })];

    await asTenant(() => WhatsAppAccount.update(alertsAccountId, { status: 'disconnected' }));
    try {
      const summary = await scan({ now: now() });
      // Its own reason, not `no_recipients`: this one is fixed on the
      // connection screen, that one on the alerts screen, and a single message
      // for both sends the admin to the wrong place.
      assert.equal(summary.skipped, 'no_alert_number');
      assert.equal(summary.fired, 0);
      assert.equal((await alertRows()).length, 0, 'nothing may be recorded as announced');
      assert.equal((await outbox()).length, 0);

      const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/scan`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {}
      });
      assert.equal(status, 409);
      assert.equal(body.code, 'no_alert_number');
    } finally {
      await asTenant(() => WhatsAppAccount.update(alertsAccountId, { status: 'connected' }));
    }
  });

  it('runs a pass from the route and reports what it did', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 60 }));
    fleet = [device('dev-rota', { _lastInform: informedMinutesAgo(90) })];

    const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/scan`, {
      method: 'POST',
      headers: authHeaders(token),
      body: {}
    });
    assert.equal(status, 200);
    assert.equal(body.data.fired, 1);
    assert.equal(body.data.cleared, 0);
  });
});

describe('one bad reading is not the fleet', () => {
  it('does not throw, and still alerts on the device it could read', async () => {
    await setRules({
      ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 60 },
      rx_power_low: { enabled: true, threshold: -27, cooldownMinutes: 60 },
      temperature_high: { enabled: true, threshold: 70, cooldownMinutes: 60 },
      mass_outage: { enabled: false }
    });

    fleet = [
      null,
      {},
      device('dev-sem-inform', { _lastInform: 'ontem de manhã' }),
      device('dev-sem-id', { _id: '' }),
      device('dev-lixo', { rxpower: 'n/a', temperature: '--' }),
      device('dev-real', { _lastInform: informedMinutesAgo(90) })
    ];

    const summary = await scan({ now: now() });
    assert.equal(summary.error, null, 'a scan must never throw out of a tick');
    const rows = await alertRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject, 'dev-real');
  });

  it('reports rather than throws when the fleet read itself fails', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30 }));
    DeviceService.getDashboardDevices = async () => {
      throw new Error('GenieACS API responded with status: 502');
    };
    try {
      const summary = await scan({ now: now() });
      assert.equal(summary.skipped, 'error');
      assert.match(summary.error, /502/);
    } finally {
      DeviceService.getDashboardDevices = async () => fleet;
    }
  });

  it('refuses to call an empty fleet a fleet-wide recovery', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 60 }));
    fleet = [device('dev-vivo', { _lastInform: informedMinutesAgo(90) })];
    await scan({ now: now() });
    assert.equal((await alertRows()).length, 1);

    // An empty read is a broken ACS far more often than a provider with no
    // ONTs, and treating it as "all clear" would blast one recovery per row.
    fleet = [];
    const summary = await scan({ now: now() });
    assert.equal(summary.skipped, 'no_devices');
    assert.equal(summary.cleared, 0);
    assert.equal((await alertRows()).length, 1);
  });
});

describe('the recipients are staff, and the do-not-disturb list still holds', () => {
  it('writes one message per recipient and skips a number that opted out', async () => {
    await asTenant(() => WaAlertService.saveSettings({
      enabled: true,
      recipients: [ON_CALL, SECOND_ON_CALL],
      rules: onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 60 })
    }));
    fleet = [device('dev-dois', { _lastInform: informedMinutesAgo(90) })];

    await scan({ now: now() });
    assert.equal((await outbox()).length, 2);

    await getDb()('wa_alert_state').del();
    await getDb()('wa_messages').del();
    await getDb()('wa_opt_outs').insert({
      wa_phone_e164: SECOND_ON_CALL,
      origin: 'admin',
      created_at: new Date()
    });

    await scan({ now: now() });
    assert.equal((await outbox()).length, 1, 'an alert is the provider initiating contact');
    await getDb()('wa_opt_outs').del();
  });
});

describe('the scan interval survives a restart', () => {
  it('does not sweep the fleet again on the first tick after the process forgets', async () => {
    // An hour between passes, which is what the operator asking for an hour
    // means. Held only in memory, every restart reset it to "never scanned" and
    // the first tick swept the whole fleet regardless — and a panel restarts
    // for a deploy, a crash loop or a container rescheduled, none of which is
    // the operator changing their mind.
    await setRules(onlyRule('ont_offline', { threshold: 30 }), { intervalSeconds: 3600 });
    fleet = [device('dev-reinicio', { _lastInform: informedMinutesAgo(90) })];

    try {
      const primeiro = await asTenant(() => WaAlertService.tickForTenant());
      assert.equal(primeiro.fired, 1, 'the first tick is due and scans');
      const stamp = await getDb()('app_state').where({ key: LAST_SCAN_KEY }).first();
      assert.ok(stamp, 'and it records when, where a restart cannot reach');

      // What a restart looks like from in here: the class is new, the table is not.
      WaAlertService.lastScanAt.clear();
      const segundo = await asTenant(() => WaAlertService.tickForTenant());
      assert.equal(segundo.skipped, 'not_due', 'the hour is still the hour');
    } finally {
      await getDb()('app_state').where({ key: LAST_SCAN_KEY }).del();
      WaAlertService.lastScanAt.clear();
    }
  });
});
