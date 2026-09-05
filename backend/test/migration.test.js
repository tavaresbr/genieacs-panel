import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

// The account layout shipped before portal passwords existed.
async function createLegacyCustomerAccounts(db) {
  await db.schema.createTable('customer_accounts', (t) => {
    t.increments('id').primary();
    t.string('customer_id', 32).notNullable().unique();
    t.string('device_id', 255).notNullable().unique();
    t.string('identity_hash', 64).notNullable().unique();
    t.string('software_id', 255).notNullable();
    t.string('pppoe_username', 255).notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('last_seen_at').defaultTo(db.fn.now());
    t.timestamp('created_at').defaultTo(db.fn.now());
    t.timestamp('updated_at').defaultTo(db.fn.now());
  });
  await db('customer_accounts').insert({
    customer_id: LEGACY_CUSTOMER_ID,
    device_id: 'legacy-device-1',
    identity_hash: 'legacy'.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: 'legacy-customer',
    active: true
  });
}

const LEGACY_CUSTOMER_ID = 'CSG-LEGACY1-234567';
let portalUrl;

before(async () => {
  ({ portalUrl } = await startTestServers({ beforeSchema: createLegacyCustomerAccounts }));
});

after(async () => {
  await stopTestServers();
});

describe('upgrading an existing installation', () => {
  it('adds the portal password columns without losing accounts', async () => {
    const db = getDb();
    for (const column of [
      'password_hash',
      'password_ciphertext',
      'password_iv',
      'password_tag',
      'password_updated_at'
    ]) {
      assert.ok(
        await db.schema.hasColumn('customer_accounts', column),
        `expected column ${column}`
      );
    }
    const account = await db('customer_accounts').where({ customer_id: LEGACY_CUSTOMER_ID }).first();
    assert.equal(account.pppoe_username, 'legacy-customer');
    assert.equal(account.password_hash, null);
  });

  it('refuses to log a migrated account in until it has a password', async () => {
    const { status } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: LEGACY_CUSTOMER_ID, password: LEGACY_CUSTOMER_ID.slice(-6) }
    });
    assert.equal(status, 401);
  });

  it('backfills a real password that is not derived from the Customer ID', async () => {
    const generated = await CustomerPortalPasswordService.backfillMissing();
    assert.equal(generated, 1);

    const account = await getDb()('customer_accounts')
      .where({ customer_id: LEGACY_CUSTOMER_ID })
      .first();
    const password = CustomerPortalPasswordService.reveal(account);
    assert.ok(password);
    assert.notEqual(password, LEGACY_CUSTOMER_ID.slice(-6));

    const legacy = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: LEGACY_CUSTOMER_ID, password: LEGACY_CUSTOMER_ID.slice(-6) }
    });
    assert.equal(legacy.status, 401);

    const current = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: LEGACY_CUSTOMER_ID, password }
    });
    assert.equal(current.status, 200);
  });

  it('is a no-op on a second run', async () => {
    assert.equal(await CustomerPortalPasswordService.backfillMissing(), 0);
  });
});
