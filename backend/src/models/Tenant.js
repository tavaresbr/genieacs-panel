import { getDb } from '../config/database.js';

/**
 * The provider row itself.
 *
 * Read through `getDb()` rather than `tdb()` for the same reason `TenantUser`
 * is: `tenants` has no `tenant_id`, because it IS the provider. `tdb` would
 * hand back an unfiltered builder anyway — it only filters tables it knows are
 * scoped — so reaching for it here would look like a scoped read while being
 * nothing of the kind, which is worse than being plainly unscoped. Every method
 * here therefore names the provider it wants, explicitly, in its arguments.
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
}

export default Tenant;
