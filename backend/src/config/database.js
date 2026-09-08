import knexFactory from 'knex';
import { buildKnexConfig, isSqlite } from './dbConfig.js';
import { currentTenantId, TenantScopeError } from './tenantContext.js';
import { isScoped } from './tenantScope.js';

const TENANT_COLUMN = 'tenant_id';

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

/**
 * A query builder for a table that belongs to one provider, with the provider's
 * filter already applied.
 *
 * Models call this instead of `getDb()` and stop knowing that providers exist.
 * The filter cannot be forgotten because it is never written by hand, and a
 * call made with no provider in scope throws rather than reading everyone's
 * rows.
 *
 * A table not yet converted (see `tenantScope.js`) is returned unfiltered,
 * which is what makes the conversion possible a few tables at a time.
 */
export function tdb(table, trx = null) {
  const knex = trx || getDb();
  if (!isScoped(table)) return knex(table);

  const query = knex(table).where(`${table}.${TENANT_COLUMN}`, currentTenantId());

  // knex ignores `where` on an insert, so `tdb('x').insert(...)` would write an
  // unscoped row and look perfectly reasonable doing it. Closing that door here
  // is the difference between a mechanism and a convention.
  return new Proxy(query, {
    get(target, property, receiver) {
      if (property === 'insert') {
        return () => {
          throw new TenantScopeError(
            `insert into "${table}" must go through tinsert(), which sets the provider; `
            + 'a where clause does not apply to an insert.'
          );
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/** The provider column for a row about to be written, or nothing when the table is not scoped. */
function withTenant(table, row) {
  if (!isScoped(table)) return row;
  const tenantId = currentTenantId();
  return Array.isArray(row)
    ? row.map((one) => ({ ...one, [TENANT_COLUMN]: tenantId }))
    : { ...row, [TENANT_COLUMN]: tenantId };
}

/**
 * Insert into a provider-owned table. Returns the knex insert builder, so
 * `onConflict(...).merge(...)` still chains off it.
 */
export function tinsert(table, row, trx = null) {
  const knex = trx || getDb();
  return knex(table).insert(withTenant(table, row));
}

/** Insert and return the generated id, with the provider set. */
export function tinsertReturningId(table, row, trx = null) {
  return insertReturningId(table, withTenant(table, row), trx);
}

export { isSqlite };
