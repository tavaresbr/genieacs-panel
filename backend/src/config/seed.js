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

/**
 * Dá a cada provedor o que um provedor precisa para existir: settings, o
 * centro do mapa, o catálogo de equipamentos e uma assinatura.
 *
 * `tenantIds` restringe a passagem a esses provedores. Sem ele, a instalação
 * inteira — o que o boot quer. Com ele, o que o cadastro e o console querem:
 * o provedor que acabou de nascer, e só. A passagem completa custa dezessete
 * consultas POR provedor mesmo quando não há nada a inserir — medido: 24
 * consultas com um provedor, 704 com 41, 3424 com 201 — e o cadastro é uma
 * rota pública que a executava dentro da própria transação. Quanto mais
 * clientes, mais caro ficava cada estranho apertando "cadastrar".
 *
 * O caminho continua sendo um só: é a mesma função, com a mesma sequência,
 * sobre uma lista menor. O que muda é quantos provedores ela visita.
 */
export async function seedDefaults(db = getDb(), { tenantIds = null } = {}) {
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
  const tenants = tenantIds
    ? await db('tenants').whereIn('id', tenantIds).orderBy('id', 'asc')
    : await db('tenants').orderBy('id', 'asc');

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
        // Brasília, wide enough to show the whole country: the panel is sold
        // to Brazilian ISPs, and the onboarding asks each one where its plant
        // actually is. Jakarta was the upstream project's home, not ours.
        center_lat: '-15.7942',
        center_lng: '-47.8822',
        max_zoom_in: '18',
        max_zoom_out: '5',
        default_zoom: '13'
      });
    }
  }

  await seedVendorCatalogue(db, tenants);
  await seedSubscriptions(db, tenants);
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
/**
 * Todo provedor tem uma assinatura, e quem nasce depois da migração 0034 nasce
 * em teste.
 *
 * A migração deu `active` sem limite a quem já existia — um upgrade não pode
 * bloquear ninguém. Aqui é o contrário: um provedor cunhado pelo console, ou
 * por qualquer caminho futuro, começa em `trial` no plano que oferece teste,
 * com o prazo contado a partir de agora. É o seed e não o controlador que faz
 * isso pelo mesmo motivo de os settings e o catálogo serem seed: só há um
 * jeito de um provedor vir a existir, e é passando por aqui.
 *
 * Escrita crua, como o resto deste arquivo: roda no boot, sem escopo, e às
 * vezes contra o banco de DESTINO de uma troca. `tenant_id` vai na mão.
 */
async function seedSubscriptions(db, tenants) {
  if (!(await db.schema.hasTable('subscriptions'))) return;
  const withTrial = await db('plans')
    .where({ active: true })
    .where('trial_days', '>', 0)
    .orderBy('trial_days', 'desc')
    .orderBy('id', 'asc')
    .first();
  const plan = withTrial
    || await db('plans').where({ code: 'unlimited' }).first()
    || await db('plans').where({ active: true }).orderBy('id', 'asc').first();
  if (!plan) return;

  const trialDays = Number(plan.trial_days) > 0 ? Number(plan.trial_days) : DEFAULT_TRIAL_DAYS;
  for (const tenant of tenants) {
    // tenant-scope-exempt: seed, sem escopo aberto; o provedor vai na mão.
    const existing = await db('subscriptions').where({ tenant_id: tenant.id }).first();
    if (existing) continue;
    const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
    // tenant-scope-exempt: idem.
    await db('subscriptions').insert({
      tenant_id: tenant.id,
      plan_id: plan.id,
      status: 'trial',
      trial_ends_at: trialEndsAt
    });
    // tenant-scope-exempt: idem — e é a primeira linha do extrato deste provedor.
    const subscription = await db('subscriptions').where({ tenant_id: tenant.id }).first();
    await db('billing_events').insert({
      tenant_id: tenant.id,
      subscription_id: subscription?.id ?? null,
      type: 'trial.started',
      provider: 'manual',
      detail: JSON.stringify({ planCode: plan.code, trialDays, trialEndsAt })
    });
  }
}

/** Quantos dias de teste um provedor novo ganha quando nenhum plano diz. */
const DEFAULT_TRIAL_DAYS = 14;

async function seedVendorCatalogue(db, tenants) {
  const sizes = await catalogueSizes(db);
  const has = (tenant) => (sizes.get(Number(tenant.id)) || 0) > 0;

  // A fonte é qualquer provedor da instalação que já tenha catálogo — não
  // necessariamente um dos que estão sendo semeados. Quando a lista é só o
  // provedor recém-nascido, a fonte está fora dela por definição.
  const sourceId = [...sizes.entries()]
    .filter(([, size]) => size > 0)
    .map(([id]) => id)
    .sort((a, b) => a - b)[0];
  if (sourceId === undefined) return;

  for (const tenant of tenants) {
    if (has(tenant)) continue;
    await copyCatalogue(db, sourceId, tenant.id);
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
