import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  asTenant,
  authHeaders,
  call,
  getDb,
  runInTenant,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

const { default: CustomerAccount } = await import('../src/models/CustomerAccount.js');
const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

/**
 * The phase's actual proof.
 *
 * Two providers holding the SAME `customer_id`, `device_id` and
 * `identity_hash` — the three values that collide in the real world, because
 * `identity_hash` is sha256(softwareId, pppoe_username) and two ISPs deploying
 * the same ONT firmware to a subscriber of the same name produce the same
 * digest. Nothing may return or alter the other provider's row.
 *
 * Where a route is involved the answer must be 404, never 403: a 403 confirms
 * the record exists, which is itself the leak.
 */
let panelUrl;
let portalUrl;
let token;
let alfa;
let beta;

// The same subscriber identity on both sides. Identical on purpose.
const SOFTWARE_ID = 'V3.2.1-BUILD9';
const PPPOE = 'joao.silva';
const DEVICE_ID = 'ONT-COLLIDE-0001';
const CUSTOMER_ID = 'CSG-2026-000042';

const identityHash = () => CustomerService.identityHash(SOFTWARE_ID, PPPOE);

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
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
});

async function reset() {
  await getDb()('customer_accounts').del();
}

/** The row as the database holds it, provider and all — never through a model. */
const raw = (where) => getDb()('customer_accounts').where(where);

describe('two providers holding the same subscriber identity', () => {
  it('lets both keep a row with the same customer, device and identity', async () => {
    await reset();
    const row = {
      customer_id: CUSTOMER_ID,
      device_id: DEVICE_ID,
      identity_hash: identityHash(),
      software_id: SOFTWARE_ID,
      pppoe_username: PPPOE,
      active: true
    };
    await runInTenant(alfa, () => CustomerAccount.create(row));
    await runInTenant(beta, () => CustomerAccount.create(row));

    assert.equal((await raw({ customer_id: CUSTOMER_ID })).length, 2);
  });

  it('shows each provider only its own', async () => {
    const mine = await runInTenant(alfa, () => CustomerAccount.getByDeviceId(DEVICE_ID));
    const theirs = await runInTenant(beta, () => CustomerAccount.getByDeviceId(DEVICE_ID));

    assert.equal(Number(mine.tenant_id), Number(alfa));
    assert.equal(Number(theirs.tenant_id), Number(beta));
    assert.notEqual(mine.id, theirs.id);

    for (const [tenant, expected] of [[alfa, alfa], [beta, beta]]) {
      const byCustomer = await runInTenant(tenant, () => CustomerAccount.getByCustomerId(CUSTOMER_ID));
      const byIdentity = await runInTenant(tenant, () => CustomerAccount.getByIdentityHash(identityHash()));
      const byPppoe = await runInTenant(tenant, () => CustomerAccount.getActiveByPppoe(PPPOE));
      for (const found of [byCustomer, byIdentity, byPppoe]) {
        assert.equal(Number(found.tenant_id), Number(expected));
      }
    }
  });

  it('counts and lists only its own', async () => {
    const mine = await runInTenant(alfa, () => CustomerAccount.getAll());
    assert.equal(mine.length, 1);
    assert.equal(Number(mine[0].tenant_id), Number(alfa));

    const targets = await runInTenant(beta, () => CustomerAccount.getSyncTargets());
    assert.equal(targets.length, 1);

    const found = await runInTenant(beta, () => CustomerAccount.getIdsByDeviceIds([DEVICE_ID]));
    assert.equal(found.length, 1);
  });
});

describe('the account takeover this table exists to prevent', () => {
  // `identity_hash` is how an ONT swap keeps a subscriber's portal login:
  // within one provider, matching on it and re-pointing the account at the new
  // device is exactly right. Across providers it hands the account over —
  // the second provider's sync adopts the first's subscriber, portal password
  // and saved WiFi credentials included.
  it('does not let one provider adopt the other provider\'s account', async () => {
    await reset();

    const theirs = await runInTenant(alfa, () => CustomerService.ensureAccount({
      _id: 'ONT-DO-PRIMEIRO', softwareId: SOFTWARE_ID, pppoe: PPPOE
    }, { enabled: true }));
    assert.ok(theirs, 'the first provider has an account for this subscriber');

    // Same firmware, same subscriber name, different ONT: the exact collision.
    const mine = await runInTenant(beta, () => CustomerService.ensureAccount({
      _id: 'ONT-DO-SEGUNDO', softwareId: SOFTWARE_ID, pppoe: PPPOE
    }, { enabled: true }));

    assert.ok(mine, 'the second provider gets an account of its own');
    assert.notEqual(mine.id, theirs.id, 'it must be a new row, not the other provider\'s');
    assert.equal(Number(mine.tenant_id), Number(beta));

    // The giveaway, had it gone wrong: the first provider's account would now
    // be pointing at the second provider's ONT.
    const after = await raw({ id: theirs.id }).first();
    assert.equal(after.device_id, 'ONT-DO-PRIMEIRO', 'the other provider\'s ONT is untouched');
    assert.equal(Boolean(after.active), true, 'and it was not retired out from under them');
  });

  it('does not retire the other provider\'s account', async () => {
    const theirs = await runInTenant(alfa, () => CustomerAccount.getByDeviceId('ONT-DO-PRIMEIRO'));
    const changed = await runInTenant(beta, () => CustomerAccount.retire(theirs.id));
    assert.equal(changed, null, 'nothing to retire under this provider');

    const after = await raw({ id: theirs.id }).first();
    assert.equal(Boolean(after.active), true);
    assert.equal(after.device_id, 'ONT-DO-PRIMEIRO');
  });

  it('does not reset the other provider\'s portal password', async () => {
    const theirs = await runInTenant(alfa, () => CustomerAccount.getByDeviceId('ONT-DO-PRIMEIRO'));
    const before = (await raw({ id: theirs.id }).first()).password_hash;

    // It does not throw — the update simply matches no row under this
    // provider. Silence is fine here; changing nothing is the guarantee.
    await runInTenant(beta, () => CustomerPortalPasswordService.reset(theirs.id));

    assert.equal((await raw({ id: theirs.id }).first()).password_hash, before,
      'the other provider\'s stored password is untouched');
  });
});

describe('a route asked for another provider\'s record', () => {
  // Every request resolves the installation's provider today; the second
  // provider is reachable only once providers get their own subdomain. What
  // has to hold already is that asking for a record that belongs to somebody
  // else answers as though it does not exist.
  it('answers 404, not 403 — a 403 would confirm the record is there', async () => {
    await reset();
    await runInTenant(beta, () => CustomerAccount.create({
      customer_id: CUSTOMER_ID,
      device_id: DEVICE_ID,
      identity_hash: identityHash(),
      software_id: SOFTWARE_ID,
      pppoe_username: PPPOE,
      active: true
    }));

    const { status } = await call(`${panelUrl}/api/devices/${DEVICE_ID}/portal-password`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 404);
    assert.notEqual(status, 403);
  });

  it('refuses a portal login for a Customer ID that belongs to another provider', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: CUSTOMER_ID, password: 'ABC123' }
    });
    assert.equal(status, 401);
    assert.equal(body.code, 'invalid_credentials');
  });
});
