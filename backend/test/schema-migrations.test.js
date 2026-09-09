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
  'whatsapp_accounts',
  'device_samples',
  'device_sample_hours',
  'device_swaps'
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
const LEGACY_STATE_KEY = 'sgp_integration_config';
const LEGACY_STATE_VALUE = '{"enabled":true,"app":"painel"}';

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
  // Same shape as `settings`: `key` alone is the primary key. 0015 has to move
  // both, with rows already in them.
  await db.schema.createTable('app_state', (t) => {
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
  // An integration blob, because that is what this table really holds and
  // losing one in a backfill would cost an operator their SGP credentials.
  await db('app_state').insert({ key: LEGACY_STATE_KEY, value: LEGACY_STATE_VALUE });
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

    // The blob survives the primary-key move intact. A backfill that mangled
    // this would cost an operator their stored SGP credentials.
    const state = await db('app_state').where({ key: LEGACY_STATE_KEY }).first();
    assert.equal(state.value, LEGACY_STATE_VALUE);
  });

  // 0015 moves `key` from being the primary key on its own to being half of
  // `(tenant_id, key)`. This is the only step in the phase that touches a
  // primary key, and the three dialects spell it differently, so it is checked
  // here — in the block that runs against whichever dialect is under test —
  // rather than in the SQLite-only scratch databases below.
  describe('moving the key/value tables to a per-provider primary key', () => {
    const rowsFor = (db, table, key) => db(table).where({ key });

    it('carries the legacy rows over to the install\'s own provider', async () => {
      const db = getDb();
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      for (const [table, key] of [['settings', 'appName'], ['app_state', LEGACY_STATE_KEY]]) {
        const [row] = await rowsFor(db, table, key);
        assert.equal(Number(row.tenant_id), Number(tenant.id), `${table}.tenant_id`);
      }
    });

    it('lets a second provider hold the same key with its own value', async () => {
      const db = getDb();
      await db('tenants').insert({ slug: 'pk-beta', name: 'Provedor Beta', status: 'active' });
      const beta = await db('tenants').where({ slug: 'pk-beta' }).first();
      try {
        await db('settings').insert({ tenant_id: beta.id, key: 'appName', value: 'Outro Painel' });
        const rows = await rowsFor(db, 'settings', 'appName');
        assert.equal(rows.length, 2);
        assert.deepEqual(
          rows.map((r) => r.value).sort(),
          [LEGACY_APP_NAME, 'Outro Painel'].sort()
        );

        // Same provider, same key, twice — still refused.
        await assert.rejects(
          () => db('settings').insert({ tenant_id: beta.id, key: 'appName', value: 'Terceiro' })
        );

        // The conflict target has to be the composite key. Getting this wrong
        // is invisible on MySQL, which ignores the target entirely, and throws
        // on SQLite and Postgres — so it is asserted behaviourally.
        await db('settings')
          .insert({ tenant_id: beta.id, key: 'appName', value: 'Renomeado' })
          .onConflict(['tenant_id', 'key'])
          .merge({ value: 'Renomeado' });
        const merged = await rowsFor(db, 'settings', 'appName');
        assert.equal(merged.length, 2, 'the upsert must update, not append');
        assert.equal(
          merged.find((r) => Number(r.tenant_id) === Number(beta.id)).value,
          'Renomeado'
        );
      } finally {
        await db('settings').where({ tenant_id: beta.id }).del();
        await db('tenants').where({ id: beta.id }).del();
      }
    });

    it('refuses a row for a provider that does not exist', async () => {
      await assert.rejects(
        () => getDb()('settings').insert({ tenant_id: 999999, key: 'appName', value: 'x' })
      );
    });
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

describe('making the contract cadastre per-provider', () => {
  const db = createDatabase('sgp-links-tenancy');
  let alfa;

  /**
   * The upgrade path, which is the one that runs on every install already
   * standing — and the one the tenancy tests cannot reach, because they start
   * from a database the runner has already finished with.
   *
   * `sgp_links.device_id` was unique across the deployment. Step 0017 drops
   * that unique and puts `['tenant_id', 'device_id']` in its place, which on
   * SQLite means rebuilding the table with rows in it. A row that is here
   * afterwards is a row the rebuild carried.
   */
  before(async () => {
    for (const migration of migrations.filter((m) => m.id < FIRST_TENANCY_MIGRATION)) {
      await migration.up(db);
    }
    await db('settings').insert({ key: 'appName', value: 'Provedor Alfa' });
    const accountId = await insertReturningId('customer_accounts', {
      customer_id: 'CSG-BBBBBBB-222222',
      device_id: 'ont-legada',
      identity_hash: 'k'.repeat(64),
      software_id: 'V2',
      pppoe_username: 'cliente-legado',
      active: true
    }, db);
    await db('sgp_links').insert({
      device_id: 'ont-legada',
      account_id: accountId,
      contract: '9001',
      client_name: 'Maria Souza',
      document: '98765432100',
      phone_manual: '5511999990000'
    });

    await ensureSchema(db);
    alfa = await db('tenants').orderBy('id', 'asc').first();
  });

  it('gives the cadastre it already had to the install\'s own provider', async () => {
    const link = await db('sgp_links').where({ device_id: 'ont-legada' }).first();
    assert.equal(Number(link.tenant_id), Number(alfa.id));
    // The rebuild has to carry every column, not just the key ones: this is the
    // row an operator sees on screen, and losing the phone number would break
    // the WhatsApp side silently.
    assert.equal(link.contract, '9001');
    assert.equal(link.client_name, 'Maria Souza');
    assert.equal(link.document, '98765432100');
    assert.equal(link.phone_manual, '5511999990000');
  });

  it('lets a second provider hold the same device id', async () => {
    const betaId = await insertReturningId('tenants', {
      slug: 'beta', name: 'Provedor Beta', status: 'active'
    }, db);
    await db('sgp_links').insert({
      tenant_id: betaId, device_id: 'ont-legada', contract: '7002'
    });

    const rows = await db('sgp_links').where({ device_id: 'ont-legada' });
    assert.equal(rows.length, 2, 'the old global unique would have refused the second');
  });

  it('still refuses a duplicate device id inside one provider', async () => {
    await assert.rejects(() => db('sgp_links').insert({
      tenant_id: alfa.id, device_id: 'ont-legada', contract: '9002'
    }));
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
      ['wa_messages', 'wa_conversations'],
      // Not tidiness: `copyData` deletes in reverse order and inserts forward,
      // so the foreign key added by 0015 is only satisfiable because `tenants`
      // precedes both of these.
      ['settings', 'tenants'],
      ['app_state', 'tenants']
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
