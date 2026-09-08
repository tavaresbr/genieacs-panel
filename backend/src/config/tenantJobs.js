import { getDb } from './database.js';
import { runInTenant, TenantScopeError } from './tenantContext.js';

/**
 * Runs background work once, as the installation's only provider.
 *
 * Work driven by a timer has no request and therefore no provider, but every
 * query underneath it now demands one. This opens that scope.
 *
 * It runs the job ONCE, not once per provider, and the difference is the whole
 * point. These jobs are driven by a query that is not yet scoped —
 * `WaMessage.listSendable()` reads every sendable message on the deployment,
 * `WaBroadcast.listByStatus()` every running campaign. Running that once per
 * provider would not divide the work between them, it would repeat it: the
 * same message sent as many times as there are providers, to a real
 * subscriber's phone.
 *
 * So it refuses the moment a second provider exists. That is deliberate and it
 * is the safer of the two failures: a queue that stops is noticed and fixed,
 * a queue that sends everything twice is noticed by the customer. The refusal
 * names the job, and the fix is always the same — scope the driving query and
 * move the job to a per-provider loop.
 *
 * @param {string} reason What the job is, for the error a second provider triggers.
 */
export async function forSoleTenant(reason, fn) {
  const tenants = await getDb()('tenants')
    .where({ status: 'active' })
    .orderBy('id', 'asc')
    .limit(2);

  if (tenants.length === 0) return null;
  if (tenants.length > 1) {
    throw new TenantScopeError(
      `${reason} still reads across every provider, so running it once per provider `
      + 'would repeat the work rather than divide it. Scope its driving query before '
      + 'a second provider goes live.'
    );
  }

  return runInTenant(tenants[0].id, fn);
}

/**
 * Runs background work once per active provider, each inside its own scope.
 *
 * The counterpart to `forSoleTenant`, and the one to reach for whenever the
 * job's own query is already scoped — then a per-provider loop genuinely
 * divides the work instead of repeating it. The portal-password backfill is
 * the first: it reads only the accounts of the provider in scope, so running
 * it per provider backfills each provider's own and nobody else's.
 *
 * One provider failing does not stop the others: a broken integration at one
 * ISP must not silently halt the job for every other ISP on the deployment.
 */
export async function forEachTenant(job, { onError } = {}) {
  const tenants = await getDb()('tenants').where({ status: 'active' }).orderBy('id', 'asc');
  const results = [];
  for (const tenant of tenants) {
    try {
      results.push(await runInTenant(tenant.id, () => job(tenant)));
    } catch (error) {
      if (onError) onError(error, tenant);
      else console.warn(`Background job failed for provider ${tenant.slug}: ${error.message}`);
    }
  }
  return results;
}
