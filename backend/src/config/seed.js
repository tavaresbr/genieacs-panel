import { getDb } from './database.js';

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

}
