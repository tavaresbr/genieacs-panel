import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O painel inicial do console (`GET /api/platform/overview`, aba Início): a
 * guarda, o formato, a tolerância a falha de cada bloco, a janela das
 * renovações e dos trials, e o mês de Brasília dos provedores novos.
 *
 * No app de verdade (edição SaaS), como `platform-metrics.test.js`.
 * Datas ao segundo: o MySQL guarda ao segundo e ARREDONDA os milissegundos.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const {
  default: PlatformOverviewService, OVERVIEW_BLOCKS, OVERVIEW_LIST_LIMIT, variacao
} = await import('../src/services/platformOverviewService.js');

const DAY = 24 * 60 * 60 * 1000;
const segundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const daqui = (dias) => segundo(Date.now() + dias * DAY);

let panelUrl;
let token;
let comumToken;
let plano;
let gratis;
const ids = {};

const overview = (tok = token) => call(`${panelUrl}/api/platform/overview`, { headers: tok ? authHeaders(tok) : {} });

const LIMPA = {
  status: 'active', trial_ends_at: null, renews_at: null, canceled_at: null,
  billing_exempt_at: null, billing_exempt_until: null, suspended_reason: null,
  paused_until: null, pause_started_at: null, cancel_at: null, proration_due_at: null,
  card_autopay_at: null, card_token_ciphertext: null, pending_plan_id: null, coupon_id: null
};

async function assinatura(tenantId, patch) {
  await Subscription.upsertForTenant(tenantId, { ...LIMPA, plan_id: plano.id, ...patch });
  await SubscriptionService.invalidate(tenantId);
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'inicio', password: 'inicio-senha-1', email: 'inicio@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  const contratado = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { username: 'comum-inicio', password: 'senha-do-comum-1', role: 'admin', email: 'comum-i@exemplo.test' }
  });
  assert.equal(contratado.status, 201, JSON.stringify(contratado.body));
  const entrou = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'comum-inicio', password: 'senha-do-comum-1' }
  });
  comumToken = entrou.body?.data?.token;
  assert.ok(comumToken);

  plano = await Plan.create({
    code: 'inicio-pro', name: 'Pro', price_cents: 10000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
  gratis = await Plan.create({
    code: 'inicio-gratis', name: 'Grátis', price_cents: 0, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
  ids.padrao = (await db('tenants').where({ kind: 'provider' }).orderBy('id', 'asc').first()).id;
  for (const slug of ['ren-perto', 'ren-longe', 'ren-cancela', 'ren-isento', 'ren-gratis', 'trial-perto', 'trial-longe', 'cancela-pedido']) {
    // eslint-disable-next-line no-await-in-loop -- linhas de cenário
    await db('tenants').insert({ slug, name: `Provedor ${slug}`, status: 'active' });
    // eslint-disable-next-line no-await-in-loop
    ids[slug] = (await db('tenants').where({ slug }).first()).id;
  }
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('platform_alerts').del();
  await assinatura(ids.padrao, { renews_at: daqui(20) });
  // Renova em 2 dias, com o cartão recorrente ligado: entra, com `cardAutopay`.
  await assinatura(ids['ren-perto'], {
    renews_at: daqui(2), card_autopay_at: segundo(Date.now() - DAY), card_token_ciphertext: 'cifrado'
  });
  // Renova em 8 dias: fora da janela.
  await assinatura(ids['ren-longe'], { renews_at: daqui(8) });
  // Renova em 3 dias, mas o cancelamento está agendado: não vai renovar.
  await assinatura(ids['ren-cancela'], { renews_at: daqui(3), cancel_at: daqui(3) });
  // Isento e plano de graça: não há o que cobrar.
  await assinatura(ids['ren-isento'], { renews_at: daqui(1), billing_exempt_at: segundo(Date.now() - DAY) });
  await assinatura(ids['ren-gratis'], { renews_at: daqui(1), plan_id: gratis.id });
  await assinatura(ids['trial-perto'], { status: 'trial', trial_ends_at: daqui(5) });
  await assinatura(ids['trial-longe'], { status: 'trial', trial_ends_at: daqui(9) });
  await assinatura(ids['cancela-pedido'], { renews_at: daqui(15) });
  await getDb()('cancellation_requests').del();
  await runInTenant(ids['cancela-pedido'], () => getDb()('cancellation_requests').insert({
    tenant_id: ids['cancela-pedido'], reason: 'price'
  }));
});

describe('painel inicial: a guarda', () => {
  it('401 sem sessão, 404 para quem não é do console', async () => {
    assert.equal((await overview(null)).status, 401);
    assert.equal((await overview(comumToken)).status, 404);
  });
});

describe('painel inicial: a resposta', () => {
  it('os alertas que falharam: a mesma conta com o instante em número ou em texto', async () => {
    const db = getDb();
    const iso = (ms) => new Date(segundo(ms)).toISOString();
    const sql = (ms) => iso(ms).slice(0, 19).replace('T', ' ');
    await db('platform_alerts').insert([
      { event: 'charge_failed', dedupe_key: 'fmt-1', status: 'failed', created_at: segundo(Date.now() - 2 * DAY) },
      { event: 'charge_failed', dedupe_key: 'fmt-2', status: 'failed', created_at: iso(Date.now() - 3 * DAY) },
      { event: 'charge_failed', dedupe_key: 'fmt-3', status: 'failed', created_at: sql(Date.now() - 4 * DAY) },
      { event: 'charge_failed', dedupe_key: 'fmt-4', status: 'failed', created_at: iso(Date.now() - 20 * DAY) },
      { event: 'charge_failed', dedupe_key: 'fmt-5', status: 'failed', created_at: sql(Date.now() - 8 * DAY) },
      { event: 'charge_failed', dedupe_key: 'fmt-6', status: 'failed', created_at: segundo(Date.now() - 30 * DAY) }
    ]);
    const r = await overview();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.alerts.failed, 3);
  });

  it('traz todos os blocos, sem erro', async () => {
    const db = getDb();
    const agora = segundo(Date.now());
    await db('platform_alerts').insert([
      { event: 'charge_failed', dedupe_key: 'ov-1', status: 'failed', created_at: segundo(Date.now() - 2 * DAY) },
      { event: 'charge_failed', dedupe_key: 'ov-2', status: 'failed', created_at: segundo(Date.now() - 10 * DAY) },
      { event: 'charge_failed', dedupe_key: 'ov-3', status: 'sent', created_at: agora }
    ]);
    const r = await overview();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    for (const bloco of OVERVIEW_BLOCKS) assert.ok(d[bloco], `bloco ${bloco}`);
    assert.deepEqual(d.errors, []);
    assert.equal(d.timeZone, 'America/Sao_Paulo');
    assert.equal(d.windowDays, 7);

    assert.equal(d.revenue.currency, 'BRL');
    assert.match(d.revenue.month, /^\d{4}-\d{2}$/);
    for (const chave of ['value', 'previous', 'delta', 'pct']) {
      assert.ok(chave in d.revenue.mrr, chave);
      assert.ok(chave in d.revenue.received, chave);
    }
    assert.equal(typeof d.delinquency.count, 'number');
    assert.equal(typeof d.delinquency.totalOverdueCents, 'number');
    assert.deepEqual(Object.keys(d.delinquency.byBucket), ['1-7', '8-15', '16-30', '30+']);
    // Só a que falhou dentro dos sete dias.
    assert.equal(d.alerts.failed, 1);
    assert.equal(d.cancellations.pending, 1);
    assert.equal(d.cancellations.scheduled, 1);
    assert.ok(d.cancellations.nextScheduledAt);
    assert.equal(d.newTenants.month, d.revenue.month);
    assert.ok(d.newTenants.count >= 9, 'os provedores do cenário nasceram neste mês');
  });

  it('renovações: só as dos próximos sete dias que vão cobrar, da mais próxima', async () => {
    const { renewals } = (await overview()).body.data;
    assert.deepEqual(renewals.items.map((i) => i.tenant.slug), ['ren-perto']);
    assert.equal(renewals.total, 1);
    const [item] = renewals.items;
    assert.equal(item.amountCents, 10000);
    assert.equal(item.currency, 'BRL');
    assert.equal(item.cardAutopay, true);
    assert.equal(item.plan.name, 'Pro');
    assert.equal(item.billingCycle, 'monthly');
    assert.ok(Date.parse(item.renewsAt) > Date.now());
  });

  it('trials: só os que acabam nos próximos sete dias', async () => {
    const { trials } = (await overview()).body.data;
    assert.deepEqual(trials.items.map((i) => i.tenant.slug), ['trial-perto']);
    assert.equal(trials.total, 1);
    assert.equal(trials.items[0].cardSaved, false);
  });

  it('um bloco que falha volta nulo e não derruba os outros', async () => {
    const original = PlatformOverviewService.revenue;
    const erroOriginal = console.error;
    const logados = [];
    console.error = (...args) => { logados.push(args); };
    PlatformOverviewService.revenue = async () => { throw new Error('quebrou de propósito'); };
    try {
      const r = await overview();
      assert.equal(r.status, 200);
      assert.equal(r.body.data.revenue, null);
      assert.deepEqual(r.body.data.errors, ['revenue']);
      assert.ok(r.body.data.delinquency);
      assert.ok(r.body.data.renewals);
      assert.ok(logados.some((args) => String(args[0]).includes('revenue')));
    } finally {
      PlatformOverviewService.revenue = original;
      console.error = erroOriginal;
    }
  });
});

describe('painel inicial: as contas, sem banco', () => {
  const carteira = (tenants, assinaturas = []) => () => Promise.resolve({
    tenants,
    provedores: new Map(tenants.map((t) => [Number(t.id), t])),
    planos: new Map([[1, { id: 1, price_cents: 5000, currency: 'BRL', period_days: 30 }]]),
    assinaturas
  });

  it('provedores novos pelo mês de Brasília (a meia-noite é 03:00 UTC)', async () => {
    const now = new Date('2026-02-10T12:00:00Z');
    const r = await PlatformOverviewService.newTenants({
      now,
      carteira: carteira([
        { id: 1, created_at: new Date('2026-02-01T02:59:59Z') }, // 23:59:59 de 31/01 em Brasília
        { id: 2, created_at: new Date('2026-02-01T03:00:00Z') }, // meia-noite de fevereiro
        { id: 3, created_at: '2026-02-09 12:00:00' }, // texto sem fuso do SQLite: UTC
        { id: 4, created_at: '2026-01-02 12:00:00' },
        { id: 5, created_at: '2025-12-31 12:00:00' }
      ])
    });
    assert.equal(r.month, '2026-02');
    assert.equal(r.count, 2);
    assert.equal(r.previous, 2);
    assert.equal(r.delta, 0);
  });

  it('renovações: no máximo dez, e o total de todas', async () => {
    const now = new Date('2026-02-10T12:00:00Z');
    const tenants = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, slug: `p${i + 1}` }));
    const assinaturas = tenants.map((t, i) => ({
      id: 100 + i, tenant_id: t.id, plan_id: 1, status: 'active', billing_cycle: 'monthly',
      // Da mais distante para a mais próxima, para provar a ordem.
      renews_at: new Date(now.getTime() + (12 - i) * 12 * 60 * 60 * 1000)
    }));
    const r = await PlatformOverviewService.renewals({ now, carteira: carteira(tenants, assinaturas) });
    assert.equal(r.total, 12);
    assert.equal(r.items.length, OVERVIEW_LIST_LIMIT);
    assert.equal(r.items[0].tenant.slug, 'p12');
    assert.equal(r.items[0].amountCents, 5000);
    const instantes = r.items.map((i) => Date.parse(i.renewsAt));
    assert.deepEqual([...instantes].sort((a, b) => a - b), instantes);
  });

  it('a variação: sem base, sem porcentagem', () => {
    assert.deepEqual(variacao(150, 100), { value: 150, previous: 100, delta: 50, pct: 0.5 });
    assert.deepEqual(variacao(10, 0), { value: 10, previous: 0, delta: 10, pct: null });
    assert.deepEqual(variacao(undefined, 5), { value: null, previous: 5, delta: null, pct: null });
  });
});
