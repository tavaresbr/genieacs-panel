import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: DeviceSwap } = await import('../src/models/DeviceSwap.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');

const PPPOE = 'subscriber-1@isp';

/** What GenieACS hands the sync for one ONT. */
function inform(deviceId, { softwareId = 'V1.0.0', pppoe = PPPOE } = {}) {
  return { _id: deviceId, softwareId, pppoe };
}

const ensure = (device) => asTenant(() => CustomerService.ensureAccount(device));
const swapsFor = (deviceId) => asTenant(() => DeviceSwap.listForDevice(deviceId));
const openSwaps = () => asTenant(() => DeviceSwap.listOpen());

/** A contract bound to an ONT, with the two things the ERP did not put there. */
async function linkDevice(deviceId, patch = {}) {
  await getDb()('sgp_links').insert({
    device_id: deviceId,
    contract: '4242',
    link_mode: 'manual',
    phone_manual: '+5511999990000',
    ...patch
  });
}

let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1' }
  });
  token = setup.body.data.token;
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('device_swaps').del();
  await getDb()('sgp_links').del();
  await getDb()('customer_accounts').del();
});

describe('detecting the swap', () => {
  it('records the replacement when the new ONT runs the same firmware', async () => {
    // The common case, and the one a hook on the PPPoE branch alone would miss:
    // same model, same firmware, so the identity hash is unchanged and the
    // account matches on it before the login is ever compared.
    await ensure(inform('ont-old'));
    const moved = await ensure(inform('ont-new'));

    assert.equal(moved.device_id, 'ont-new');
    const [swap] = await swapsFor('ont-new');
    assert.equal(swap.previous_device_id, 'ont-old');
    assert.equal(swap.matched_by, 'identity_hash');
    assert.equal(Number(swap.repeat_count), 1);
    assert.equal(Boolean(swap.flapping), false);
  });

  it('records the replacement when the new ONT runs different firmware', async () => {
    await ensure(inform('ont-old', { softwareId: 'V1.0.0' }));
    await ensure(inform('ont-new', { softwareId: 'V2.4.1' }));

    const [swap] = await swapsFor('ont-new');
    assert.equal(swap.matched_by, 'pppoe');
    assert.equal(swap.previous_device_id, 'ont-old');
  });

  it('records nothing when the same ONT informs again', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-old', { softwareId: 'V2.4.1' }));

    assert.equal((await getDb()('device_swaps')).length, 0);
  });

  it('records nothing when the ONT was re-provisioned for someone else', async () => {
    // A different login on the same equipment is a new subscriber, not a
    // replacement: the account is retired rather than moved, and filing that as
    // a swap would tell the operator to expect one customer on two ONTs.
    await ensure(inform('ont-old'));
    await ensure(inform('ont-old', { pppoe: 'subscriber-2@isp' }));

    assert.equal((await getDb()('device_swaps')).length, 0);
  });
});

describe('the SGP link', () => {
  it('carries the contract onto the new ONT with the manual corrections intact', async () => {
    await ensure(inform('ont-old'));
    await linkDevice('ont-old');

    await ensure(inform('ont-new'));

    assert.equal(await SgpLink.getByDeviceId('ont-old'), null);
    const link = await SgpLink.getByDeviceId('ont-new');
    assert.equal(link.contract, '4242');
    // A delete-and-relookup would leave both of these gone, with nothing said.
    assert.equal(link.phone_manual, '+5511999990000');
    assert.equal(link.link_mode, 'manual');

    const [swap] = await swapsFor('ont-new');
    assert.equal(swap.link_action, 'moved');
    assert.equal(swap.contract, '4242');
  });

  it('drops the old link when the new ONT already has one of its own', async () => {
    await ensure(inform('ont-old'));
    await linkDevice('ont-old');
    await linkDevice('ont-new', { contract: '4242', phone_manual: '+5511999990000' });

    await ensure(inform('ont-new'));

    assert.equal(await SgpLink.getByDeviceId('ont-old'), null);
    const link = await SgpLink.getByDeviceId('ont-new');
    assert.equal(link.phone_manual, '+5511999990000');
    const [swap] = await swapsFor('ont-new');
    assert.equal(swap.link_action, 'cleared');
  });

  it('says so rather than inventing a link that never existed', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));

    const [swap] = await swapsFor('ont-new');
    assert.equal(swap.link_action, 'none');
    assert.equal(swap.contract, null);
  });
});

describe('two ONTs trading one login', () => {
  it('stops moving the link and flags the pair instead', async () => {
    await ensure(inform('ont-old'));
    await linkDevice('ont-old');

    // The replacement informs, and the link follows it.
    await ensure(inform('ont-new'));
    assert.ok(await SgpLink.getByDeviceId('ont-new'));

    // The old one is still powered on and informs a minute later. Following it
    // back would take the contract off the ONT that is actually in service.
    await ensure(inform('ont-old'));

    const back = await asTenant(() => DeviceSwap.getPair('ont-new', 'ont-old'));
    assert.equal(back.link_action, 'held');
    assert.equal(Boolean(back.flapping), true);
    assert.ok(await SgpLink.getByDeviceId('ont-new'), 'the link must stay where it was');
    assert.equal(await SgpLink.getByDeviceId('ont-old'), null);
  });

  it('flags both directions, so the pair reads as one story', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    await ensure(inform('ont-old'));

    const forward = await asTenant(() => DeviceSwap.getPair('ont-old', 'ont-new'));
    assert.equal(Boolean(forward.flapping), true);
  });

  it('folds a repeat into the row already describing it', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));

    const rows = await getDb()('device_swaps');
    assert.equal(rows.length, 2, 'one row per direction, however many times it happens');
    const forward = await asTenant(() => DeviceSwap.getPair('ont-old', 'ont-new'));
    assert.equal(Number(forward.repeat_count), 2);
  });

  it('reopens a repeat the operator had already dismissed', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    const forward = await asTenant(() => DeviceSwap.getPair('ont-old', 'ont-new'));
    await asTenant(() => DeviceSwap.acknowledge(forward.id));
    assert.equal((await openSwaps()).length, 0);

    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));

    const reopened = await asTenant(() => DeviceSwap.getById(forward.id));
    assert.equal(reopened.acknowledged_at, null);
  });
});

describe('the operator API', () => {
  beforeEach(async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
  });

  it('lists what has not been looked at yet', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/devices/swaps`,
      { headers: authHeaders(token) }
    );
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.open, 1);
    assert.equal(body.data.swaps[0].previousDeviceId, 'ont-old');
    assert.equal(body.data.swaps[0].deviceId, 'ont-new');
  });

  it('drops it off the list once acknowledged', async () => {
    const listed = await call(`${panelUrl}/api/devices/swaps`, { headers: authHeaders(token) });
    const { id } = listed.body.data.swaps[0];

    const acked = await call(`${panelUrl}/api/devices/swaps/${id}/acknowledge`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(acked.status, 200, JSON.stringify(acked.body));
    assert.ok(acked.body.data.acknowledgedAt);

    const again = await call(`${panelUrl}/api/devices/swaps`, { headers: authHeaders(token) });
    assert.equal(again.body.data.open, 0);
  });

  it('answers 404 for a swap that does not exist', async () => {
    const { status } = await call(`${panelUrl}/api/devices/swaps/999999/acknowledge`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(status, 404);
  });

  it('serves both ends of the swap on the device page', async () => {
    for (const deviceId of ['ont-old', 'ont-new']) {
      // eslint-disable-next-line no-await-in-loop -- two assertions, not a hot path
      const { body } = await call(
        `${panelUrl}/api/devices/${deviceId}/swaps`,
        { headers: authHeaders(token) }
      );
      assert.equal(body.data.swaps.length, 1, `${deviceId} should see the swap`);
    }
  });

  it('requires a session', async () => {
    const { status } = await call(`${panelUrl}/api/devices/swaps`);
    assert.equal(status, 401);
  });
});
