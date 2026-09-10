import { getDb, insertReturningId } from '../config/database.js';

/**
 * The providers themselves, read from the control plane.
 *
 * Like `TenantUser`, and for the same reason, this is deliberately NOT read
 * through `tdb`: every other model asks "what does the provider in scope hold?"
 * while this one is asked ABOVE any single provider — it is the table the scope
 * is chosen FROM, so filtering it by the scope would make listing providers
 * return the one you are already in.
 *
 * That is safe here only because nothing reaches these methods without
 * `requirePlatformAdmin` in front of it. A provider's own administrator has no
 * route into this file, which is the whole point of the control plane being a
 * plane above.
 */
class Tenant {
  /** Every provider, oldest first — the order the console lists them in. */
  static async list() {
    return getDb()('tenants').orderBy('id', 'asc');
  }

  static async findById(id) {
    return (await getDb()('tenants').where({ id }).first()) || null;
  }

  /**
   * The slug is the subdomain, and DNS does not distinguish case, so the lookup
   * must not either — otherwise "Alfa" and "alfa" would both be accepted as
   * free and then resolve to the same host. The insert path rejects anything
   * that is not already lowercase, so this only ever matches on equal terms;
   * comparing on the lowered value keeps that true even for rows written by
   * hand before the rule existed.
   */
  static async findBySlug(slug) {
    return (await getDb()('tenants')
      .whereRaw('LOWER(slug) = ?', [String(slug).toLowerCase()])
      .first()) || null;
  }

  /**
   * How many people hold a membership at each provider, keyed by provider id.
   *
   * Grouped in one query rather than counted per provider, so listing stays two
   * queries however many providers the deployment grows to — the same shape
   * `seedDefaults` uses for catalogue sizes.
   */
  static async operatorCounts() {
    const rows = await getDb()('tenant_users')
      .select('tenant_id')
      .count({ n: '*' })
      .groupBy('tenant_id');
    return new Map(rows.map((row) => [Number(row.tenant_id), Number(row.n)]));
  }

  /**
   * Writes the row and returns its id. Seeding is NOT done here: it belongs to
   * the caller, which owns the transaction that has to cover both.
   */
  static async create({ slug, name, status = 'active' }, trx = null) {
    return insertReturningId('tenants', { slug, name, status }, trx);
  }

  static async setStatus(id, status) {
    const changed = await getDb()('tenants')
      .where({ id })
      .update({ status, updated_at: new Date() });
    return changed > 0;
  }
}

export default Tenant;
