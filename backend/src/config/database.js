import knexFactory from 'knex';
import { buildKnexConfig, isSqlite } from './dbConfig.js';

let db;

export function getDb() {
  if (!db) {
    db = knexFactory(buildKnexConfig());
  }
  return db;
}

export async function testConnection() {
  try {
    await getDb().raw('SELECT 1');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error.message);
    return false;
  }
}

export async function closePool() {
  if (db) {
    await db.destroy();
    db = null;
  }
}

export async function testExternalConnection(config) {
  let probe;
  try {
    probe = knexFactory(buildKnexConfig(config));
    await probe.raw('SELECT 1');
    return true;
  } catch (error) {
    throw new Error(error.message);
  } finally {
    if (probe) await probe.destroy();
  }
}

/**
 * Inserts a row and returns its generated id.
 *
 * SQLite and MySQL hand the id back from `insert()` itself; Postgres needs an
 * explicit RETURNING clause and gives back a row object. Asking every dialect
 * for RETURNING would work but makes knex log a warning on MySQL, so the
 * branch is explicit and the non-Postgres path stays what it always was.
 *
 * The dialect is read off the connection rather than re-read from the config
 * file, which would mean a synchronous disk read on every insert — and would
 * describe the wrong connection for a transaction opened on another instance.
 */
export async function insertReturningId(table, row, trx = null) {
  const knex = trx || getDb();

  if (knex.client.config.client === 'pg') {
    const [inserted] = await knex(table).insert(row).returning('id');
    return typeof inserted === 'object' && inserted !== null ? inserted.id : inserted;
  }

  const [id] = await knex(table).insert(row);
  return id;
}

export { isSqlite };
