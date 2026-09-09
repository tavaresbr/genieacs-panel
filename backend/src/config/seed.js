import { getDb, insertReturningId } from './database.js';

export const DEFAULT_SETTINGS = {
  appName: 'SkyGenPanel',
  genieAcsUrl: '',
  autoGenerateCustomerId: 'false',
  customerIdPrefixMode: 'default',
  customerIdCompanyPrefix: 'CSG',
  customerIdSuffixMode: 'random',
  vpPppoeUsername: 'VirtualParameters.PPPUsername',
  vpWanBridge: 'VirtualParameters.WANBridge',
  vpRxPower: 'VirtualParameters.OpticalRXPower',
  vpTemperature: 'VirtualParameters.OpticalTemperature',
  vpActiveDevices: 'VirtualParameters.TotalStations',
  vpSuperAdmin: 'VirtualParameters.LoginSuperUser',
  vpSuperPassword: 'VirtualParameters.LoginSuperPass',
  vpUserAdmin: '',
  vpUserPassword: ''
};

// Values shipped by older SkyGenPanel releases. Only these exact values are
// migrated, so an operator's custom mappings are never overwritten.
export const LEGACY_DEFAULT_SETTINGS = {
  appName: 'GenieACS Panel',
  vpPppoeUsername: 'VirtualParameters.pppoeUsername',
  vpWanBridge: 'VirtualParameters.WANBRIDGE',
  vpRxPower: 'VirtualParameters.RXPower',
  vpTemperature: 'VirtualParameters.gettemp',
  vpActiveDevices: 'VirtualParameters.activedevices',
  vpSuperAdmin: 'VirtualParameters.superAdmin',
  vpSuperPassword: 'VirtualParameters.superPassword',
  vpUserAdmin: 'VirtualParameters.userAdmin',
  vpUserPassword: 'VirtualParameters.userPassword'
};

export async function seedDefaults(db = getDb()) {
  // Settings belong to a provider, so every provider gets the defaults — the
  // panel's name, its GenieACS, its VirtualParameter mapping.
  //
  // The providers are read from the connection that was passed in, not from
  // `getDb()`, and the column is written explicitly rather than through a
  // tenant context. Both matter: `dbManagementService` calls this against the
  // TARGET database of a database switch, where `getDb()` is still the source
  // and no context has been opened. Writing the column here also keeps this
  // file free of the scoping helpers, which it could not use anyway — it runs
  // at boot, before any request.
  const tenants = await db('tenants').orderBy('id', 'asc');

  for (const tenant of tenants) {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const existing = await db('settings').where({ tenant_id: tenant.id, key }).first();
      if (!existing) {
        await db('settings').insert({ tenant_id: tenant.id, key, value });
      } else if (
        Object.hasOwn(LEGACY_DEFAULT_SETTINGS, key) &&
        existing.value === LEGACY_DEFAULT_SETTINGS[key]
      ) {
        await db('settings')
          .where({ tenant_id: tenant.id, key })
          .update({ value, updated_at: new Date() });
      }
    }

    // The map centre, per provider — inside the loop since 0025 made the key
    // `(tenant_id, id)`. Before that it sat outside, with a comment saying so:
    // the row was a deployment-wide singleton, and a second provider's turn
    // would have collided on the same `id: 1`. Now every provider gets its own
    // row 1, which is the whole point — a latitude is literally where one ISP's
    // city is, and there is nothing shared about it.
    const map = await db('map_settings').where({ tenant_id: tenant.id, id: 1 }).first();
    if (!map) {
      await db('map_settings').insert({
        tenant_id: tenant.id,
        id: 1,
        center_lat: '-6.2088',
        center_lng: '106.8456',
        max_zoom_in: '18',
        max_zoom_out: '5',
        default_zoom: '13'
      });
    }
  }

  await seedVendorCatalogue(db, tenants);
}

/** The equipment catalogue, in the order the foreign key requires. */
const CATALOGUE_TABLES = ['vendors', 'wifi_security_mappings', 'wifi_security_config'];

/**
 * How many catalogue rows each provider has, across all three tables.
 *
 * Grouped rather than counted per provider, so this stays three queries at
 * every boot however many providers the deployment grows to.
 */
async function catalogueSizes(db) {
  const sizes = new Map();
  for (const table of CATALOGUE_TABLES) {
    const rows = await db(table).select('tenant_id').count({ n: '*' }).groupBy('tenant_id');
    for (const row of rows) {
      const tenantId = Number(row.tenant_id);
      sizes.set(tenantId, (sizes.get(tenantId) || 0) + Number(row.n));
    }
  }
  return sizes;
}

/**
 * Gives a provider with no equipment catalogue a copy of one that has it.
 *
 * 0026 made `vendors`, `wifi_security_mappings` and `wifi_security_config`
 * per-provider, and nothing seeds them: the catalogue is built by the operator
 * through `/api/vendor-management`. So the provider created after that step
 * starts empty, and empty is the worst possible failure here because it is
 * silent — detection matches no vendor, the WiFi write finds no parameter path
 * and falls back to guessing, and the panel merely looks wrong.
 *
 * WHAT IT COPIES FROM: the lowest-numbered provider that has a catalogue. That
 * is the installation's own — the one 0026 stamped every pre-existing row onto,
 * so it holds the catalogue this deployment has actually been running against,
 * corrections included. Ordering by id makes the choice the same at every boot
 * and on all three engines; "has a catalogue" rather than "is the first
 * provider" is what keeps this working on a deployment whose first provider was
 * removed or was itself created empty. When nobody has one there is nothing to
 * copy and nothing to do, which is the state of a brand-new install.
 *
 * The copy runs only for a provider whose three tables are ALL empty. Deleting
 * a vendor is an edit like any other, so anything left standing means an
 * operator has been here and the catalogue is theirs; that is also what makes
 * this safe at every boot, since the second boot finds the rows it wrote the
 * first time.
 */
async function seedVendorCatalogue(db, tenants) {
  const sizes = await catalogueSizes(db);
  const has = (tenant) => (sizes.get(Number(tenant.id)) || 0) > 0;

  const source = tenants.find(has);
  if (!source) return;

  for (const tenant of tenants) {
    if (has(tenant)) continue;
    await copyCatalogue(db, source.id, tenant.id);
  }
}

/**
 * Copies one provider's catalogue onto another.
 *
 * Vendors go first and their new ids are remembered, because a mapping points
 * at `vendors.id` and the copies have ids of their own — carrying the source's
 * `vendor_id` across would attach the new provider's mappings to the source
 * provider's vendors, which is the cross-provider foreign key 0026 exists to
 * prevent. The identity and the timestamps are dropped rather than copied: the
 * new rows are new, and their `created_at` should say so.
 */
async function copyCatalogue(db, sourceId, targetId) {
  const vendorIds = new Map();

  const vendors = await db('vendors').where({ tenant_id: sourceId }).orderBy('id', 'asc');
  for (const vendor of vendors) {
    const { id, tenant_id, created_at, updated_at, ...columns } = vendor;
    vendorIds.set(
      id,
      await insertReturningId('vendors', { ...columns, tenant_id: targetId }, db)
    );
  }

  const mappings = await db('wifi_security_mappings')
    .where({ tenant_id: sourceId })
    .orderBy('id', 'asc');
  for (const mapping of mappings) {
    const { id, tenant_id, created_at, updated_at, vendor_id, ...columns } = mapping;
    const copiedVendorId = vendorIds.get(vendor_id);
    // A mapping whose vendor was not copied would be one pointing outside the
    // source provider — impossible through the models, and not something to
    // reproduce in the target if a hand-edited database has it anyway.
    if (copiedVendorId === undefined) continue;
    await db('wifi_security_mappings')
      .insert({ ...columns, tenant_id: targetId, vendor_id: copiedVendorId });
  }

  const configs = await db('wifi_security_config')
    .where({ tenant_id: sourceId })
    .orderBy('id', 'asc');
  for (const config of configs) {
    const { id, tenant_id, created_at, updated_at, ...columns } = config;
    await db('wifi_security_config').insert({ ...columns, tenant_id: targetId });
  }
}
