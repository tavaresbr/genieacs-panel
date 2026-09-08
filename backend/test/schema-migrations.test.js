import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';
import { getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { ensureSchema, MIGRATIONS_TABLE } = await import('../src/config/schema.js');
const { migrations, SCHEMA_TABLES } = await import('../src/config/migrations.js');
const { buildKnexConfig } = await import('../src/config/dbConfig.js');

/** Every table the application expects once the runner is done. */
const APP_TABLES = [
  'users',
  'settings',
  'app_state',
  'vendors',
  'wifi_security_mappings',
  'wifi_security_config',
  'mapping_nodes',
  'mapping_edges',
  'map_settings',
  'customer_accounts',
  'device_profiles',
  'sgp_links',
  'customer_wifi_credentials',
  'provisioning_profiles',
  'provisioning_runs',
  'sgp_events',
  'whatsapp_accounts'
];

/** Every secret kept in its own columns records which key encrypted it. */
const SECRET_KEY_VERSION_COLUMNS = [
  ['customer_accounts', 'password_key_version'],
  ['customer_wifi_credentials', 'password_key_version'],
  ['provisioning_profiles', 'wifi_password_key_version'],
  ['provisioning_profiles', 'cpe_password_key_version'],
  ['whatsapp_accounts', 'token_key_version'],
  ['whatsapp_accounts', 'webhook_token_key_version']
];

const ALL_IDS = migrations.map((migration) => migration.id);
// Everything from here on is the tenancy work; the "before" state is the
// schema as it stood just ahead of it. Comparing by id rather than naming one
// migration means a new tenancy step does not need this test edited.
const FIRST_TENANCY_MIGRATION = '0010_customer_accounts_tenant';
const LEGACY_USERNAME = 'legacy-admin';
const LEGACY_APP_NAME = 'Legacy Panel';

// Scratch databases for the cases that need a second, independent file: the
// harness owns a single database and it is spoken for by the legacy fixture.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygenpanel-migrations-'));
const scratchPools = [];

function createDatabase(name) {
  const db = knexFactory(buildKnexConfig({
    client: 'sqlite3',
    filename: path.join(scratchDir, `${name}.sqlite`)
  }));
  scratchPools.push(db);
  return db;
}

async function appliedIds(db) {
  const rows = await db(MIGRATIONS_TABLE).select('id').orderBy('id');
  return rows.map((row) => row.id);
}

/**
 * The layout of an installation that predates the migration runner: the two
 * tables it always had, without the columns and tables added since.
 */
async function createLegacyInstallation(db) {
  await db.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('username', 64).notNullable().unique();
    t.string('password', 255).notNullable();
    t.string('role', 32).notNullable().defaultTo('user');
    t.timestamp('created_at').defaultTo(db.fn.now());
    t.timestamp('updated_at').defaultTo(db.fn.now());
  });
  await db.schema.createTable('settings', (t) => {
    t.string('key', 128).primary();
    t.text('value');
    t.timestamp('updated_at').defaultTo(db.fn.now());
  });
  await db('users').insert({
    username: LEGACY_USERNAME,
    password: 'legacy-hash',
    role: 'admin'
  });
  await db('settings').insert({ key: 'appName', value: LEGACY_APP_NAME });
}

before(async () => {
  await startTestServers({ beforeSchema: createLegacyInstallation });
});

after(async () => {
  await Promise.all(scratchPools.splice(0).map((db) => db.destroy()));
  fs.rmSync(scratchDir, { recursive: true, force: true });
  await stopTestServers();
});

describe('migrating a fresh database', () => {
  const db = createDatabase('fresh');

  before(async () => {
    await ensureSchema(db);
  });

  it('creates every application table', async () => {
    for (const table of APP_TABLES) {
      assert.ok(await db.schema.hasTable(table), `expected table ${table}`);
    }
  });

  it('records every migration id', async () => {
    assert.deepEqual(await appliedIds(db), [...ALL_IDS].sort());
  });

  it('keeps the columns the later steps would otherwise add', async () => {
    assert.ok(await db.schema.hasColumn('users', 'token_version'));
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
  });

  // Without these, rotating JWT_SECRET makes every stored secret unreadable
  // and says nothing about it, because decryption reports failure as "empty".
  it('records which key encrypted every secret held in its own columns', async () => {
    for (const [table, column] of SECRET_KEY_VERSION_COLUMNS) {
      assert.ok(
        await db.schema.hasColumn(table, column),
        `expected ${table}.${column}`
      );
    }
  });
});

describe('running the migrations again', () => {
  const db = createDatabase('repeat');

  before(async () => {
    await ensureSchema(db);
    await db('users').insert({ username: 'kept', password: 'hash', role: 'admin' });
  });

  it('is a no-op on the second run', async () => {
    await ensureSchema(db);
    assert.deepEqual(await appliedIds(db), [...ALL_IDS].sort());
  });

  it('does not duplicate the ledger rows or lose data', async () => {
    await ensureSchema(db);
    const [{ count }] = await db(MIGRATIONS_TABLE).count({ count: '*' });
    assert.equal(Number(count), ALL_IDS.length);
    const user = await db('users').where({ username: 'kept' }).first();
    assert.equal(user.password, 'hash');
  });
});

describe('baselining an installation created before the runner existed', () => {
  it('records every migration id for the legacy database', async () => {
    assert.deepEqual(await appliedIds(getDb()), [...ALL_IDS].sort());
  });

  it('keeps the rows the legacy tables already held', async () => {
    const db = getDb();
    const user = await db('users').where({ username: LEGACY_USERNAME }).first();
    assert.ok(user, 'expected the legacy user to survive');
    assert.equal(user.password, 'legacy-hash');
    assert.equal(user.role, 'admin');

    const setting = await db('settings').where({ key: 'appName' }).first();
    assert.equal(setting.value, LEGACY_APP_NAME);
  });

  it('fills in what the legacy layout was missing', async () => {
    const db = getDb();
    assert.ok(await db.schema.hasColumn('users', 'token_version'));
    const user = await db('users').where({ username: LEGACY_USERNAME }).first();
    assert.equal(Number(user.token_version), 0);
    for (const table of APP_TABLES) {
      assert.ok(await db.schema.hasTable(table), `expected table ${table}`);
    }
  });

  it('records rather than re-runs steps whose objects are all present', async () => {
    // A database that already has everything, but no ledger: the runner has to
    // adopt it as-is instead of trying to create what is already there.
    const db = createDatabase('baseline');
    await ensureSchema(db);
    await db('users').insert({ username: 'pre-existing', password: 'hash', role: 'admin' });
    await db.schema.dropTable(MIGRATIONS_TABLE);

    await ensureSchema(db);

    assert.deepEqual(await appliedIds(db), [...ALL_IDS].sort());
    const user = await db('users').where({ username: 'pre-existing' }).first();
    assert.equal(user.password, 'hash');
  });
});

describe('the schema table list', () => {
  const db = createDatabase('coverage');

  before(async () => {
    await ensureSchema(db);
  });

  // Copying a panel to another database walks this list. When it was written
  // out by hand it fell eight tables behind, and a switch would have carried
  // the panel across without any of the WhatsApp data.
  it('names every table the migrations create', async () => {
    const created = [];
    for (const table of SCHEMA_TABLES) {
      if (await db.schema.hasTable(table)) created.push(table);
    }
    assert.deepEqual(created.sort(), [...SCHEMA_TABLES].sort());
  });

  it('covers every application table the tests know about', () => {
    const missing = APP_TABLES.filter((table) => !SCHEMA_TABLES.includes(table));
    assert.deepEqual(missing, []);
  });

  // Order is what makes the list safe to insert along and delete against.
  it('lists parents before the tables that reference them', () => {
    const position = (table) => SCHEMA_TABLES.indexOf(table);
    for (const [child, parent] of [
      ['wifi_security_mappings', 'vendors'],
      ['mapping_edges', 'mapping_nodes'],
      ['sgp_links', 'customer_accounts'],
      ['customer_wifi_credentials', 'customer_accounts'],
      ['provisioning_runs', 'provisioning_profiles'],
      ['wa_conversations', 'whatsapp_accounts'],
      ['wa_messages', 'wa_conversations']
    ]) {
      assert.ok(
        position(parent) < position(child),
        `${parent} must come before ${child}`
      );
    }
  });
});

describe('making customer accounts per-provider', () => {
  const db = createDatabase('tenancy');
  let alfa;

  before(async () => {
    // The state just before tenancy, populated the way a running install is:
    // an account with children pointing at it, so the rebuild the unique swap
    // needs on SQLite has something to lose if it goes wrong.
    for (const migration of migrations.filter((m) => m.id < FIRST_TENANCY_MIGRATION)) {
      await migration.up(db);
    }
    await db('settings').insert({ key: 'appName', value: 'Provedor Alfa' });
    const accountId = await insertReturningId('customer_accounts', {
      customer_id: 'CSG-AAAAAAA-111111',
      device_id: 'dev-1',
      identity_hash: 'h'.repeat(64),
      software_id: 'V1',
      pppoe_username: 'cliente01',
      active: true
    }, db);
    await db('customer_wifi_credentials').insert({
      account_id: accountId, wifi_index: 1, ssid: 'CasaDoJoao'
    });
    await db('sgp_links').insert({ device_id: 'dev-1', account_id: accountId, contract: '4321' });

    await ensureSchema(db);
    alfa = await db('tenants').orderBy('id', 'asc').first();
  });

  it('turns the install into the first provider, under the name already on screen', async () => {
    assert.equal(alfa.slug, 'default');
    assert.equal(alfa.name, 'Provedor Alfa');
  });

  it('keeps the accounts and everything pointing at them', async () => {
    const account = await db('customer_accounts').where({ device_id: 'dev-1' }).first();
    assert.equal(account.customer_id, 'CSG-AAAAAAA-111111');
    assert.equal(Number(account.tenant_id), Number(alfa.id));

    // The unique swap rebuilds the table on SQLite, where a cascading delete
    // would take these with it.
    const [{ n }] = await db('customer_wifi_credentials').count({ n: '*' });
    assert.equal(Number(n), 1);
    const link = await db('sgp_links').where({ device_id: 'dev-1' }).first();
    assert.equal(Number(link.account_id), Number(account.id));
  });

  // The whole point: identity_hash is sha256(softwareId, pppoe_username), so
  // two providers running the same firmware with a subscriber of the same name
  // produce the same value. Globally unique, the second provider's sync would
  // find the first provider's account.
  it('lets a second provider reuse every identity value', async () => {
    const betaId = await insertReturningId('tenants', {
      slug: 'beta', name: 'Provedor Beta', status: 'active'
    }, db);
    await insertReturningId('customer_accounts', {
      tenant_id: betaId,
      customer_id: 'CSG-AAAAAAA-111111',
      device_id: 'dev-1',
      identity_hash: 'h'.repeat(64),
      software_id: 'V1',
      pppoe_username: 'cliente01',
      active: true
    }, db);

    const [{ n }] = await db('customer_accounts').where({ device_id: 'dev-1' }).count({ n: '*' });
    assert.equal(Number(n), 2, 'both providers should hold the same device id');
  });

  it('still rejects a duplicate inside one provider', async () => {
    const beta = await db('tenants').where({ slug: 'beta' }).first();
    await assert.rejects(() => insertReturningId('customer_accounts', {
      tenant_id: beta.id,
      customer_id: 'CSG-AAAAAAA-111111',
      device_id: 'dev-9',
      identity_hash: 'x'.repeat(64),
      software_id: 'V1',
      pppoe_username: 'outro',
      active: true
    }, db));
  });
});
