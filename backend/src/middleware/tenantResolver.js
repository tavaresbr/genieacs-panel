import { getDb } from '../config/database.js';
import { runInTenant } from '../config/tenantContext.js';

/**
 * Puts a provider into scope before anything under `/api` runs.
 *
 * Since wave 12 this is the scope for work done WITHOUT a session — login,
 * setup, refresh, the customer portal — and nothing more. It is provisional:
 * an authenticated request is re-scoped by `authenticateToken` to the provider
 * its token names, once that membership has been read back from
 * `tenant_users`, and that scope covers the whole route chain underneath.
 *
 * The order matters and reads backwards at first glance. This is `app.use`'d
 * ahead of the routes while `authenticateToken` runs inside each of them, so
 * the installation's own provider is what a request has until its token has
 * been verified — which is exactly right, because until then the only thing
 * naming a provider is the caller. Deciding the scope here, from the token,
 * would mean opening a provider on a claim nobody has checked against the
 * table yet.
 *
 * The default is the installation's own provider: the first row, which on every
 * install that has ever existed is the only one. When providers are reached by
 * subdomain, only this lookup changes — the host names the provider, and
 * everything downstream already reads it from the context rather than being
 * handed it.
 *
 * The id is cached because it cannot change under a running process — a second
 * provider arrives by migration or by the platform console, both of which mean
 * a restart or an explicit invalidation.
 */
let cachedId = null;

export function forgetResolvedTenant() {
  cachedId = null;
}

export async function resolveDefaultTenantId() {
  if (cachedId !== null) return cachedId;
  const row = await getDb()('tenants').orderBy('id', 'asc').first();
  if (!row) return null;
  cachedId = row.id;
  return cachedId;
}

/**
 * Express middleware. A request that cannot be attributed to a provider is
 * refused rather than served unscoped: an unattributed read is the failure this
 * whole mechanism exists to prevent.
 */
export function resolveTenant(req, res, next) {
  resolveDefaultTenantId()
    .then((tenantId) => {
      if (!tenantId) {
        return res.status(503).json({
          success: false,
          message: req.t ? req.t('common.internalError') : 'No provider configured'
        });
      }
      req.tenantId = tenantId;
      return runInTenant(tenantId, () => next());
    })
    .catch(next);
}
