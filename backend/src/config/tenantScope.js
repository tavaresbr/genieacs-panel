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
  // The three whose models delete or update without a where clause. Scoped
  // first because a half-converted destructive write does not leak data, it
  // destroys someone else's.
  'mapping_nodes',
  'mapping_edges',
  'whatsapp_accounts',
  // The identity table. `identity_hash` is sha256(softwareId, pppoe_username):
  // within one provider, matching on it is how an ONT swap keeps the
  // subscriber's portal login. Across two it is account takeover, because the
  // same firmware and a same-named subscriber produce the same hash.
  'customer_accounts',
  // The WhatsApp inbox and its send queue. Scoping these is what lets the
  // outbox worker drain one provider at a time instead of the deployment.
  'wa_conversations',
  'wa_messages',
  'wa_opt_outs',
  // Campaigns and the alert cooldown. Scoping these lets the campaign flush
  // run per provider, and stops one provider's ONT outage from suppressing
  // another provider's alert for the same rule.
  'wa_templates',
  'wa_broadcasts',
  'wa_broadcast_recipients',
  'wa_alert_state',
  // The configuration pair. `settings` is what an operator sets on screen;
  // `app_state` holds the integration blobs — and `dashboard_snapshot`, which
  // is not configuration at all but a provider's own device and fault counts.
  'settings',
  'app_state',
  // The SGP and provisioning group. Four of its uniques were on values the
  // panel does not generate — GenieACS device ids, an SGP dedupe key, a
  // profile name the operator chose — and were global. Scoping them is what
  // let the last two background jobs move to a per-provider loop.
  'device_profiles',
  'sgp_links',
  'sgp_events',
  'provisioning_profiles',
  'provisioning_runs'
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
