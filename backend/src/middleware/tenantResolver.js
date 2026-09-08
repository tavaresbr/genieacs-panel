import { getDb } from '../config/database.js';
import { runInTenant } from '../config/tenantContext.js';

/**
 * Puts the provider this request belongs to into scope, for everything under it.
 *
 * There is one provider today, so that is what every request resolves to. When
 * providers are reached by subdomain, only this lookup changes: the host names
 * the provider, and everything downstream already reads it from the context
 * rather than being handed it.
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
