import { getDb, tdb } from '../config/database.js';
import { MIGRATIONS_TABLE } from '../config/schema.js';
import { SCHEMA_TABLES } from '../config/migrations.js';
import { isScoped, pendingTables } from '../config/tenantScope.js';
import { currentTenantId } from '../config/tenantContext.js';
import { LEGACY_KEY_VERSION } from '../utils/secretBox.js';

/**
 * One provider's data, on the way out.
 *
 * Two obligations meet here and they do not want the same file. LGPD asks for
 * a provider's data in a form somebody else can read; the support call that
 * starts "I deleted everything" asks for a form this panel can put back. What
 * follows is the second with enough description on it to serve as the first,
 * which is the only ordering that works — a restorable export can always be
 * read, while a readable one that cannot be restored is of no use at three in
 * the morning.
 *
 * The traversal is `SCHEMA_TABLES`, the same list and the same order
 * `dbManagementService` walks to copy a panel between databases. That order is
 * creation order, which is also foreign-key order, so a consumer replaying the
 * file inserts parents before children without having to work the graph out.
 * Deriving the table list rather than writing one down is what keeps a table
 * added next quarter from falling silently out of every provider's export; the
 * difference from that service is only WHICH rows of each table come out, and
 * that difference is the whole point of this file.
 */

export const EXPORT_FORMAT = 'skygenpanel-tenant-export';
export const EXPORT_FORMAT_VERSION = 1;

/**
 * Rows per query. A real provider has tens of thousands of them, and the
 * copy-between-databases path holds a whole table in memory at once — tolerable
 * in a maintenance window with the panel stopped, wrong for a route an operator
 * can call while it is serving. Nothing here ever holds more than one page.
 */
export const PAGE_SIZE = 500;

/** Where a secret's ciphertext, nonce, tag and key version are all named alike. */
const SECRET_PARTS = ['_ciphertext', '_iv', '_tag', '_key_version'];

/**
 * The columns of a table that hold secret material.
 *
 * Derived from the `_ciphertext` columns rather than from a list of suffixes,
 * because a suffix list gets this wrong in the direction that matters: it would
 * file `device_profiles.installation_tag` — an installer's label — as a GCM
 * authentication tag, and a reader told that a plain column is a secret learns
 * to disbelieve the whole statement.
 */
export function secretColumnsOf(columns) {
  const found = [];
  for (const column of columns) {
    if (!column.endsWith('_ciphertext')) continue;
    const prefix = column.slice(0, -'_ciphertext'.length);
    for (const part of SECRET_PARTS) {
      if (columns.includes(prefix + part)) found.push(prefix + part);
    }
  }
  // The subscriber's portal password verifier. Not a ciphertext and not
  // reversible, but it is a credential, and whoever decides how to store this
  // file needs it named alongside the rest.
  if (columns.includes('password_hash')) found.push('password_hash');
  return found;
}

/**
 * What the file says about secrets, and why it says that.
 *
 * The panel holds, per subscriber, a portal password, WiFi passwords an
 * operator can read back, an SGP token and an Evolution admin key — every one
 * of them AES-256-GCM under a key derived from the deployment's base secret.
 * An export that decrypted them would be a single file carrying every
 * subscriber's credentials in clear: strictly more dangerous than the database
 * it came from, and passed around as an attachment the way a database never is.
 *
 * So nothing here decrypts anything, and the reasoning is worth writing down
 * because "ship the ciphertext" reads like a dodge and is not one:
 *
 *  - The restore does not want plaintext. The panel putting this file back
 *    holds the same base secret, so ciphertext round-trips exactly. Handing it
 *    plaintext would mean re-encrypting on the way in, and would mean the
 *    plaintext sat in a file in between for no gain at all.
 *  - Portability does not need it. What is owed is the provider's records, and
 *    a stored authentication secret is not one of them. The one legitimate
 *    reading of a subscriber's WiFi password — an operator on a call — already
 *    exists in the panel, one account at a time, behind a session. A bulk dump
 *    adds nothing to that except the bulk.
 *  - A flag would be worse than either. `?decrypt=true` is an option that gets
 *    set, and set by exactly the person on the "I deleted everything" call, at
 *    the worst hour, under the most pressure. It would also make this the one
 *    module in the panel holding decryption keys for every secret context at
 *    once, which is a concentration nothing here needs.
 *
 * `key_version` is what turns that from a refusal into a working answer, and it
 * is the part that would be quietly lost. `secretBox.decrypt` reports a missing
 * key by returning null — indistinguishable from "no password stored" — so
 * ciphertext restored without the version that produced it is not an error, it
 * is a fleet of subscribers whose passwords evaporated. The version travels in
 * the same row as the ciphertext it describes, and a NULL there means version
 * 1, which is stated below rather than filled in, so the rows stay exactly as
 * the database holds them.
 */
const SECRET_POLICY = Object.freeze({
  decrypted: false,
  statement:
    'Nothing in this file is decrypted. Secret columns are carried exactly as the '
    + 'database holds them: base64 AES-256-GCM ciphertext with its nonce, its '
    + 'authentication tag and the version of the key that produced it. Every table '
    + 'header below names that table\'s own secret columns.',
  nullKeyVersionMeans: LEGACY_KEY_VERSION,
  readableWith:
    'SECRET_BOX_KEY for key version 2, JWT_SECRET for key version 1, from the '
    + 'deployment this export was taken from. Each secret also derives an '
    + 'independent key from its own context string, so one context\'s ciphertext '
    + 'cannot be read as another\'s.',
  alsoInsideJsonValues:
    'The `value` column of `settings` and `app_state` is JSON, and some of those '
    + 'documents embed a secret as a nested object with `password_ciphertext`, '
    + '`password_iv`, `password_tag` and `password_key_version` fields — the SGP '
    + 'integration token, its webhook secret, and the Evolution admin key. Those '
    + 'are carried unchanged too, for the same reason.'
});

const CONTAINS = Object.freeze([
  'Every row of every provider-owned table that carries this provider\'s id, in '
  + 'the order the schema creates the tables, which is also the order their '
  + 'foreign keys require.',
  'This provider\'s own row in `tenants`.',
  'The memberships at this provider, and — for the people those memberships name '
  + '— their id, username and timestamps.'
]);

const EXCLUDES = Object.freeze([
  'Any row belonging to any other provider on this deployment. The '
  + 'provider-owned tables are read through the scoped query builder, so that '
  + 'filter is not something this export applies; it is something it cannot omit.',
  'The `users.password` hash and the `users.role` column. A person can work for '
  + 'two ISPs on one login: that hash opens the panel at both, and that column is '
  + 'deployment-wide. Neither is this provider\'s to hand over. The role that '
  + 'decides anything is on the membership, and the membership is here.',
  'Memberships those same people hold at other providers, for the same reason.',
  'A `users` row for somebody who no longer works here. Historical rows may name '
  + 'a user id with no matching person in this file — who acknowledged an ONT '
  + 'swap, who sent a message — and that is deliberate: a person who left is not '
  + 'this provider\'s record.',
  'Deployment bookkeeping: the `schema_migrations` ledger is named in '
  + '`schemaVersion` below rather than exported, since it describes the '
  + 'installation and not the provider.'
]);

/**
 * The provider-owned slice of a table that is NOT provider-owned.
 *
 * These three are the only place in this file where a filter is written by hand
 * instead of being applied by `tdb`, so each says in its own words what it
 * narrows to and why that is the right slice. None of them may return a row
 * naming another provider — not even indirectly, which is what the `users`
 * projection is about.
 */
const SHARED_READERS = Object.freeze({
  // The provider itself. Its slug, name and status are what it is, and an
  // equality on the id in scope cannot reach another provider's row.
  tenants: (tenantId) => getDb()('tenants').where({ id: tenantId }),

  /**
   * The people who work here, as people and nothing more.
   *
   * The projection is the decision. `password` would hand this provider a
   * credential that also opens the panel of every other ISP the person consults
   * for, and `role` is the deployment-wide column the panel itself has stopped
   * believing — the membership below carries the role that authorises anything.
   * What is left is identity: enough to say who the memberships and the history
   * refer to, and not enough to become them.
   */
  users: (tenantId) => getDb()('users')
    .whereIn('id', getDb()('tenant_users').select('user_id').where({ tenant_id: tenantId }))
    .select('id', 'username', 'created_at', 'updated_at'),

  // Who works here and with what role. Filtered to this provider, which is also
  // what keeps a consultant's membership at another ISP out: that is a
  // different row with a different `tenant_id`, not a column on this one.
  tenant_users: (tenantId) => getDb()('tenant_users').where({ tenant_id: tenantId })
});

/** The tables this export walks, in the order it walks them. */
export function exportTables() {
  return SCHEMA_TABLES.filter((table) => isScoped(table) || table in SHARED_READERS);
}

/**
 * The column a table is paged by.
 *
 * Keyset pagination needs a total order that a row cannot move along mid-walk.
 * Every table has `id` except the two key-value ones, whose primary key is
 * `(tenant_id, key)`. A table with neither is one this export does not know how
 * to walk safely, and saying so beats quietly emitting a single page of it —
 * which is what an `OFFSET` walk would do here, on top of skipping and
 * re-reading rows as the panel writes underneath it.
 */
export function cursorColumnOf(table, columns) {
  if (columns.includes('id')) return 'id';
  if (columns.includes('key')) return 'key';
  throw new Error(
    `Cannot export "${table}": it has neither an "id" nor a "key" column to page by. `
    + 'Give it one, or teach cursorColumnOf() how this table is ordered.'
  );
}

/**
 * Rows of one table, a page at a time, lowest key first.
 *
 * `buildQuery` is a factory rather than a builder because a knex builder is
 * single-use, and because the generator then holds only the page it is
 * yielding: a hundred thousand rows walk through here without the process
 * growing.
 */
async function* pagedRows(buildQuery, column, pageSize) {
  let cursor = null;
  for (;;) {
    let query = buildQuery();
    if (cursor !== null) query = query.where(column, '>', cursor);
    const page = await query.orderBy(column, 'asc').limit(pageSize);

    for (const row of page) yield row;

    // A short page is the last page; asking again would spend a round trip to
    // learn what the row count already said.
    if (page.length < pageSize) return;
    cursor = page[page.length - 1][column];
  }
}

/** The migration this database has reached, so a restore knows what shape it is. */
async function schemaVersion() {
  const row = await getDb()(MIGRATIONS_TABLE).orderBy('id', 'desc').first();
  return row?.id ?? null;
}

/**
 * The provider in scope, as a stream of records.
 *
 * An async generator rather than a function returning an array, and that is not
 * a stylistic choice: the array is the failure this is written to avoid. It
 * also keeps the service ignorant of HTTP — the route turns records into bytes,
 * the tests iterate the same records with no server at all.
 *
 * The records, in order: one `manifest`, then per table a `table` header, its
 * `row`s, and a `table_end` carrying the count, then one `end`. A file whose
 * last record is not `end` was truncated, which is a thing a consumer can check
 * and a single JSON document would not have let it check at all.
 */
export async function* exportTenant({ pageSize = PAGE_SIZE } = {}) {
  // Throws when there is no provider in scope. An export with no provider is
  // not an empty export, it is every provider's data, so refusing is the only
  // safe answer.
  const tenantId = currentTenantId();
  const tenant = await getDb()('tenants').where({ id: tenantId }).first();
  if (!tenant) {
    throw new Error(`Cannot export provider ${tenantId}: no such provider`);
  }

  const tables = exportTables();

  yield {
    type: 'manifest',
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    schemaVersion: await schemaVersion(),
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status },
    tables,
    // Empty today. A table that has a `tenant_id` but is not yet read through
    // the scoped builder cannot be attributed to anybody, so it is named here
    // rather than dropped without a word.
    omittedTables: pendingTables().map((table) => ({
      table,
      reason: 'not yet converted to per-provider scoping; its rows cannot be attributed'
    })),
    contains: CONTAINS,
    excludes: EXCLUDES,
    secrets: SECRET_POLICY,
    truncationCheck: 'A complete file ends with a record of type "end".'
  };

  let totalRows = 0;

  for (const table of tables) {
    // `columnInfo` reads the catalogue, not rows. It is what tells this walk
    // which column to page by and which columns hold secrets, without either
    // being written down a second time here.
    const columns = Object.keys(await getDb()(table).columnInfo());
    const scoped = isScoped(table);
    const buildQuery = scoped
      ? () => tdb(table)
      : () => SHARED_READERS[table](tenantId);

    yield {
      type: 'table',
      table,
      ownership: scoped ? 'provider' : 'shared',
      secretColumns: secretColumnsOf(columns)
    };

    let rows = 0;
    for await (const row of pagedRows(buildQuery, cursorColumnOf(table, columns), pageSize)) {
      yield { type: 'row', table, row };
      rows += 1;
    }
    totalRows += rows;

    yield { type: 'table_end', table, rows };
  }

  yield { type: 'end', tables: tables.length, rows: totalRows };
}
