import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { ipKey } from '../src/middleware/rateLimit.js';

const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

let portalUrl;
const first = { customerId: 'CSG-AAAAAAA-222222', password: null };
const second = { customerId: 'CSG-BBBBBBB-333333', password: null };

async function createAccount(account, index) {
  const { password, record } = await CustomerPortalPasswordService.createRecord();
  await getDb()('customer_accounts').insert({
    customer_id: account.customerId,
    device_id: `ratelimit-device-${index}`,
    identity_hash: `ratelimit-${index}`.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: `ratelimit-${index}`,
    active: true,
    ...record
  });
  account.password = password;
}

before(async () => {
  ({ portalUrl } = await startTestServers());
  await createAccount(first, 1);
  await createAccount(second, 2);
});

after(async () => {
  await stopTestServers();
});

describe('ipKey', () => {
  it('passes IPv4 through unchanged', () => {
    assert.equal(ipKey({ ip: '203.0.113.7' }), '203.0.113.7');
  });

  it('unwraps IPv4-mapped IPv6 addresses', () => {
    assert.equal(ipKey({ ip: '::ffff:203.0.113.7' }), '203.0.113.7');
  });

  it('collapses a full IPv6 address to its /64 prefix', () => {
    assert.equal(
      ipKey({ ip: '2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd' }),
      '2001:0db8:0000:0001'
    );
  });
});

describe('portal login rate limit', () => {
  // Every customer reaches the portal through the same reverse proxy, so a
  // limiter keyed only by source address would let one visitor lock out the
  // whole customer base.
  it('isolates one customer from another customer failed attempts', async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { status } = await call(`${portalUrl}/api/customer/login`, {
        method: 'POST',
        body: { customerId: first.customerId, password: 'WRONGPASS1' }
      });
      assert.ok([401, 429].includes(status));
    }

    const exhausted = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: first.customerId, password: first.password }
    });
    assert.equal(exhausted.status, 429, 'the abused customer ID should be throttled');

    const unaffected = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: second.customerId, password: second.password }
    });
    assert.equal(unaffected.status, 200, 'other customers must stay able to log in');
  });
});
