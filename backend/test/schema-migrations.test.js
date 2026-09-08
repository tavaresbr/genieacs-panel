import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';
import { getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { ensureSchema, MIGRATIONS_TABLE } = await import('../src/config/schema.js');
const { migrations } = await import('../src/config/migrations.js');
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
  'customer_wifi_credentials'
];

const ALL_IDS = migrations.map((migration) => migration.id);
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
