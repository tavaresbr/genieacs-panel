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
  vpUserPassword: '',
  // Por quantos dias a trilha de auditoria é guardada.
  //
  // Semeada e não só lida com um padrão, porque a tela grava por
  // `PUT /api/settings/:key`, que ATUALIZA e responde 404 quando não há linha.
  // Sem semente, o campo existiria e não salvaria — e o provedor concluiria
  // que a tela está quebrada, que é pior do que não ter o campo.
  //
  // A semente alcança quem já existe: `seedDefaults` roda a cada boot e
  // insere toda chave que falta, provedor a provedor. Não precisa de migração.
  //
  // O leitor em `schedulerService` continua com o mesmo padrão e os mesmos
  // limites, e continua sendo a última linha: ele alcança valor escrito direto
  // no banco, e um deploy que nunca rodou o seed.
  auditRetentionDays: '365'
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

/** As tabelas do catálogo de equipamentos. */
const CATALOGUE_TABLES = ['vendors', 'wifi_security_config'];

/**
 * How many catalogue rows each provider has, across both tables.
 *
 * Grouped rather than counted per provider, so this stays two queries at
 * every boot however many providers the deployment grows to.
 */
export async function catalogueSizes(db) {
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
 * Todo provedor tem uma assinatura, e quem nasce depois da migração 0035 nasce
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
  /**
   * A linha da plataforma não entra em teste.
   *
   * Um teste vence, e um teste vencido vira `past_due`, que deixa a casa em
   * modo de leitura — na caixa com que a plataforma atende os provedores, isso
   * é parar de responder aos clientes num dia que ninguém marcou. Ela nasce
   * como os provedores herdados nasceram na migração 0035: `unlimited` e
   * `active`, com `renews_at` nulo, que é o valor que nunca vence.
   *
   * O plano sem limite é o mesmo `unlimited` que já existe, e não um plano novo
   * escondido: a tabela de preços é uma só, e inventar uma linha ali faria a
   * plataforma aparecer no catálogo que ela vende.
   */
  const semLimite = await db('plans').where({ code: 'unlimited' }).first();

  for (const tenant of tenants) {
    // tenant-scope-exempt: seed, sem escopo aberto; o provedor vai na mão.
    const existing = await db('subscriptions').where({ tenant_id: tenant.id }).first();
    if (existing) continue;

    if (tenant.kind === 'platform' && semLimite) {
      // tenant-scope-exempt: idem.
      await db('subscriptions').insert({
        tenant_id: tenant.id,
        plan_id: semLimite.id,
        status: 'active',
        trial_ends_at: null,
        renews_at: null
      });
      continue;
    }

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

/**
 * De QUEM o provedor novo herda o catálogo, e por quê.
 *
 * Exportada porque o console mostra esta mesma resposta na aba Catálogo padrão.
 * Duas leituras da mesma regra que discordam é o defeito que só aparece no dia
 * do boot, longe da tela que prometeu outra coisa.
 *
 * **A caixa da plataforma ganha, quando tem catálogo.** É o que faz o catálogo
 * padrão ser uma decisão de quem opera o deploy. Antes disto a fonte era o
 * provedor de MENOR ID que tivesse um — o que fazia do primeiro ISP a
 * referência de todos os próximos sem ninguém ter decidido isso, e ele edita
 * ou apaga o dele à vontade, porque é dele.
 *
 * **Sem caixa, a regra antiga, intacta:** o provedor de menor id que tenha
 * catálogo. É o que mantém funcionando todo install self-hosted e todo deploy
 * hospedado que nunca rodou `scripts/create-platform-tenant.js` — ali não há
 * plataforma nenhuma para decidir, e a instalação é a única referência que
 * existe. Ordenar por id mantém a escolha igual em todo boot e nos três
 * dialetos; "tem catálogo" em vez de "é o primeiro provedor" é o que a mantém
 * funcionando num deploy cujo primeiro provedor foi removido.
 *
 * Lê a caixa do `db` RECEBIDO e não por `Tenant.platform()`, que usa `getDb()`:
 * este arquivo roda também contra o banco de DESTINO de uma troca, onde
 * `getDb()` ainda é a origem. É a mesma razão de todo o resto daqui ler pelo
 * parâmetro.
 */
export async function catalogueSource(db, sizes = null) {
  const tamanhos = sizes ?? await catalogueSizes(db);
  const tem = (id) => (tamanhos.get(Number(id)) || 0) > 0;

  // `orderBy` pelo mesmo motivo que o recuo abaixo o tem: o script de criação é
  // idempotente e só faz uma caixa, mas um `first()` sem ordem escolhe o que o
  // dialeto quiser se um dia houver duas — e a escolha mudaria entre boots.
  const caixa = await db('tenants').where({ kind: 'platform' }).orderBy('id', 'asc').first();
  if (caixa && tem(caixa.id)) return { id: Number(caixa.id), kind: 'platform' };

  // A fonte é qualquer provedor da instalação que já tenha catálogo — não
  // necessariamente um dos que estão sendo semeados. Quando a lista é só o
  // provedor recém-nascido, a fonte está fora dela por definição.
  const sourceId = [...tamanhos.entries()]
    .filter(([, size]) => size > 0)
    .map(([id]) => id)
    .sort((a, b) => a - b)[0];
  if (sourceId === undefined) return { id: null, kind: 'none' };
  return { id: sourceId, kind: 'provider' };
}

/**
 * Gives a provider with no equipment catalogue a copy of one that has it.
 *
 * 0026 made `vendors` and `wifi_security_config` per-provider, and nothing seeds them: the catalogue is built by the operator
 * through `/api/vendor-management`. So the provider created after that step
 * starts empty, and empty is the worst possible failure here because it is
 * silent — detection matches no vendor, the WiFi write finds no parameter path
 * and falls back to guessing, and the panel merely looks wrong.
 *
 * DE ONDE ELE COPIA: `catalogueSource`, logo acima, e o porquê está lá.
 *
 * The copy runs only for a provider whose three tables are ALL empty. Deleting
 * a vendor is an edit like any other, so anything left standing means an
 * operator has been here and the catalogue is theirs; that is also what makes
 * this safe at every boot, since the second boot finds the rows it wrote the
 * first time.
 *
 * "Vazio" é a SOMA das duas tabelas e não tabela a tabela (`catalogueSizes`).
 * A consequência aparece na fonte: uma caixa de plataforma com zero fabricantes
 * e uma linha sobrando em `wifi_security_config` ainda conta como "tem
 * catálogo", e os provedores novos nascem então sem fabricante nenhum. É a
 * mesma regra de sempre, e desfazê-la seria restaurar o que um operador apagou
 * de propósito; o que ela precisa é APARECER, e aparece na aba Catálogo padrão
 * do console.
 */
async function seedVendorCatalogue(db, tenants) {
  const sizes = await catalogueSizes(db);
  const has = (tenant) => (sizes.get(Number(tenant.id)) || 0) > 0;

  const { id: sourceId } = await catalogueSource(db, sizes);
  if (sourceId === null) return;

  for (const tenant of tenants) {
    if (has(tenant)) continue;
    // A CAIXA também recebe, enquanto estiver vazia, e é de propósito: é assim
    // que ela nasce com o catálogo que o deploy já roda, sem ninguém redigitar
    // nada. É o único momento em que o primeiro ISP ainda é a referência —
    // uma vez, no dia em que a caixa é criada. Depois disso a fonte é ela, e
    // este laço nunca mais a visita, porque ela deixou de estar vazia.
    await copyCatalogue(db, sourceId, tenant.id);
  }
}

/**
 * Copies one provider's catalogue onto another.
 *
 * A identidade e os carimbos de tempo são descartados em vez de copiados: as
 * linhas novas são novas, e o `created_at` delas tem que dizer isso.
 *
 * A cópia é OPACA — pega as colunas que houver e troca o provedor. Já não foi:
 * `wifi_security_mappings` apontava para `vendors.id`, então os ids novos dos
 * fabricantes precisavam ser lembrados num `Map` e remapeados, ou os
 * mapeamentos do provedor novo ficariam pendurados nos fabricantes do provedor
 * de origem — a chave estrangeira entre provedores que a 0026 existe para
 * impedir. A 0052 derrubou aquela tabela, que nunca teve leitor, e com ela foi
 * embora a única parte desta função que precisava entender o que copiava.
 */
async function copyCatalogue(db, sourceId, targetId) {
  const vendors = await db('vendors').where({ tenant_id: sourceId }).orderBy('id', 'asc');
  for (const vendor of vendors) {
    const { id, tenant_id, created_at, updated_at, ...columns } = vendor;
    await insertReturningId('vendors', { ...columns, tenant_id: targetId }, db);
  }

  const configs = await db('wifi_security_config')
    .where({ tenant_id: sourceId })
    .orderBy('id', 'asc');
  for (const config of configs) {
    const { id, tenant_id, created_at, updated_at, ...columns } = config;
    await db('wifi_security_config').insert({ ...columns, tenant_id: targetId });
  }
}
