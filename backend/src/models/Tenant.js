import { getDb, insertReturningId } from '../config/database.js';

/**
 * The provider rows themselves — read both from the control plane and, for the
 * two public columns, by anybody who reached a provider's own address.
 *
 * Deliberately NOT read through `tdb`, and for a reason worth stating twice
 * because it is the same one from two directions. `tenants` has no `tenant_id`:
 * it IS the provider. `tdb` would hand back an unfiltered builder anyway, since
 * it only filters tables it knows are scoped — so reaching for it here would
 * LOOK like a scoped read while being nothing of the kind, which is worse than
 * being plainly unscoped. And the registry half is asked ABOVE any one
 * provider: filtering it by the scope would make listing providers return the
 * one you are already in.
 *
 * That is safe only because of what stands in front of each half. The registry
 * methods are unreachable without `requirePlatformAdmin`; the public read
 * carries its own column allowlist, below. Every method names the provider it
 * wants, explicitly, in its arguments.
 */
class Tenant {
  /**
   * The columns a stranger may see.
   *
   * Written out rather than taken as `select *` because this list is a
   * security decision, not a convenience. Somebody will eventually add a column
   * to `tenants` — a plan, a billing status, a contact address, a trial expiry
   * — and with `select *` that column would be on the public internet the
   * moment the migration ran, with no diff anywhere near this file to review.
   * Enumerating them means a new column is private by default and becomes
   * public only when a human writes its name here.
   */
  static PUBLIC_COLUMNS = ['name', 'slug'];

  /**
   * One provider's public identity, or null when no such row exists.
   *
   * Deliberately does NOT filter on `status`. It is tempting to make this
   * refuse a suspended provider — but callers of this reach it only after the
   * resolver has already accepted the request, and being stricter here than the
   * rest of the API is itself the leak: a prober who gets 404 from this route
   * and 401 from `/api/auth/login` on the same host has just learned that the
   * provider exists and is switched off. Whatever policy governs a suspended
   * provider has to be the resolver's, applied once, to every route at the same
   * time.
   */
  static async findPublicById(id) {
    if (!id) return null;
    const row = await getDb()('tenants')
      .where({ id })
      .first(...Tenant.PUBLIC_COLUMNS);
    return row || null;
  }

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
