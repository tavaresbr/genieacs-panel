import { SCHEMA_TABLES } from './migrations.js';

/**
 * The tables whose rows belong to one provider and are filtered by it.
 *
 * This list is the migration's progress, not a description of the goal. A table
 * enters it only once three things are true: it has a `tenant_id` column, every
 * model method that touches it goes through `tdb`/`tinsert`, and a leak test
 * covers it. Until then the table is read unfiltered, exactly as before — which
 * is correct while there is one provider, and is why the conversion can be done
 * a few tables at a time instead of in one unreviewable change.
 *
 * Everything not listed here is either still pending or genuinely shared. The
 * difference matters, so the shared ones are named rather than left implicit.
 */
export const SCOPED_TABLES = new Set([
  // Nothing yet. `customer_accounts` has the column and the constraints; it
  // enters here when its model and its leak test land.
]);

/** Tables that belong to the deployment rather than to any one provider. */
export const SHARED_TABLES = new Set([
  // The provider registry itself.
  'tenants'
]);

/** Tables still to be converted. Shrinks to empty as the phase progresses. */
export function pendingTables() {
  return SCHEMA_TABLES.filter(
    (table) => !SCOPED_TABLES.has(table) && !SHARED_TABLES.has(table)
  );
}

export function isScoped(table) {
  return SCOPED_TABLES.has(table);
}

/**
 * Guards the list against drifting from the schema. Called by the tests rather
 * than at import time, so a typo is a named failure instead of a boot crash.
 */
export function unknownScopedTables() {
  const known = new Set(SCHEMA_TABLES);
  return [...SCOPED_TABLES, ...SHARED_TABLES].filter((table) => !known.has(table));
}
