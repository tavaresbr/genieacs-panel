import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: Coupon } = await import('../src/models/Coupon.js');
const { default: Addon } = await import('../src/models/Addon.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const {
  default: AddonService, renewalItemsFor, addonCyclePriceCents
} = await import('../src/services/addonService.js');
const { chargeBreakdown } = await import('../src/services/accountingExportService.js');
const { aggregateRevenue, parseRange } = await import('../src/services/revenueReportService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');

/**
 * Os add-ons pagos (0125).
 *
 * A montagem de `platform-coupons.test.js`: o painel de verdade (self-hosted),
 * o roteador do console num app mínimo e um gateway de mentira em
 * `127.0.0.1`, com as requisições que SAEM asseridas. O que importa, em
 * dinheiro e em acesso:
 *
 * 1. **A porta só fecha quando o catálogo manda** — sem add-on `gated`,
 *    ninguém perde o WhatsApp; com ele, quem não tem ouve 402 (depois do 401).
 * 2. **A renovação cobra os add-ons**, por cima do plano e fora do cupom, no
 *    preço do ciclo (anual: o anual do add-on, ou 12 × o mensal).
 * 3. **A ativação cobra a pró-rata uma vez só**, mesmo com dois cliques.
 * 4. **Cancelar vale na renovação**; reativar antes não cobra de novo.
 * 5. **Um provedor não alcança o add-on do outro.**
 */
const CHAVE = 'chave-dos-add-ons';
const TOKEN_WEBHOOK = 'token-do-webhook-dos-add-ons';
const DAY = 24 * 60 * 60 * 1000;

let gateway;
let recebidas = [];
let proximoId = 0;
let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let alfa;
let beta;
let caixa;
const planos = {};
const addons = {};

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', () => {
      let payload = null;
      try { payload = bruto ? JSON.parse(bruto) : null; } catch { payload = null; }
      const caminho = req.url.split('?')[0];
      recebidas.push({ method: req.method, path: caminho, payload });
      const responder = (status, corpo) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (req.headers.access_token !== CHAVE) return responder(401, {});
      if (req.method === 'POST' && caminho === '/payments') {
        proximoId += 1;
        return responder(200, {
          id: `pay_addon_${proximoId}`,
          invoiceUrl: `https://asaas.test/i/${proximoId}`,
          dueDate: payload?.dueDate ?? null,
          value: payload?.value,
          status: 'PENDING'
        });
      }
      if (req.method === 'DELETE' && /^\/payments\/[^/]+$/.test(caminho)) return responder(200, { deleted: true });
      return responder(404, {});
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

function subirConsole() {
  const app = express();
  app.use(express.json());
  app.use(attachLocale);
  app.use('/api', resolveTenant);
  app.use('/api/platform', platformBillingRoutes);
  return new Promise((resolve) => {
    consoleServer = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${consoleServer.address().port}`));
  });
}

const platform = (caminho, options = {}) => call(`${consoleUrl}/api/platform${caminho}`, {
  ...options, headers: { ...authHeaders(donoToken), ...(options.headers || {}) }
});
const provedor = (caminho, { method = 'GET', body, token = donoToken } = {}) => call(`${panelUrl}/api/tenant${caminho}`, {
  method, headers: token ? authHeaders(token) : {}, ...(body === undefined ? {} : { body })
});
const ativar = (code) => provedor(`/addons/${code}/activate`, { method: 'POST', body: {} });
const cancelar = (code) => provedor(`/addons/${code}/cancel`, { method: 'POST', body: {} });
const entregar = (corpo) => call(`${panelUrl}/api/billing-webhook`, {
  method: 'POST', headers: { 'asaas-access-token': TOKEN_WEBHOOK }, body: corpo
});

/** Um instante relativo a agora, ao segundo (o MySQL guarda segundos). */
const daquiA = (dias) => new Date(Math.floor((Date.now() + dias * DAY) / 1000) * 1000);
const cobrancasDe = (tenantId) => getDb()('billing_charges').where({ tenant_id: tenantId }).orderBy('id', 'asc');
const linhasDe = (tenantId) => getDb()('tenant_addons').where({ tenant_id: tenantId }).orderBy('id', 'asc');
const emitir = (tenantId, opcoes = {}) => runInTenant(tenantId, () => ChargeIssuingService.issueCurrent(opcoes));
const postsDeAddon = () => recebidas.filter((r) => r.method === 'POST' && /:addon:/.test(r.payload?.externalReference ?? ''));
const ehRenovacao = (c) => c.kind === 'renewal';

async function assinar(tenantId, {
  plan = planos.pro, status = 'active', renewsAt = daquiA(15), coupon = null, cycle = 'monthly', trialEndsAt = null
} = {}) {
  await Subscription.upsertForTenant(tenantId, {
    plan_id: plan.id,
    status,
    renews_at: renewsAt,
    trial_ends_at: trialEndsAt,
    canceled_at: null,
    pending_plan_id: null,
    pending_plan_at: null,
    pending_plan_locked_at: null,
    upgraded_at: null,
    billing_exempt_at: null,
    proration_due_at: null,
    suspended_reason: null,
    billing_cycle: cycle,
    coupon_id: coupon?.id ?? null,
    coupon_cycles_left: null,
    coupon_applied_at: coupon ? new Date(Math.floor(Date.now() / 1000) * 1000) : null
  });
  await SubscriptionService.invalidate(tenantId);
}

async function catalogo(row) {
  const addon = await Addon.create({
    currency: 'BRL', active: true, public: true, gated: false, trial_access: true, sort: 0, ...row
  });
  AddonService.invalidateCatalog();
  return addon;
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  process.env.BILLING_WEBHOOK_TOKEN = TOKEN_WEBHOOK;

  ({ panelUrl } = await startTestServers());
  consoleUrl = await subirConsole();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-addons', password: 'senha-da-dona-1', email: 'dona@addons.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta-addons', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta-addons' }).first()).id;
  caixa = (await db('tenants').where({ kind: 'platform' }).first())?.id;
  if (!caixa) {
    await db('tenants').insert({ slug: 'plataforma-addons', name: 'Plataforma', status: 'active', kind: 'platform' });
    caixa = (await db('tenants').where({ kind: 'platform' }).first()).id;
  }
  resetDeploymentSharing();
  await db('tenants').where({ id: alfa }).update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa' });
  await db('tenants').where({ id: beta }).update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_beta' });

  const criar = (row) => Plan.create({ currency: 'BRL', period_days: 30, trial_days: 0, active: true, ...row });
  planos.pro = await criar({ code: 'addon-pro', name: 'Pro', price_cents: 20000, price_yearly_cents: 200000 });
  planos.gratis = await criar({ code: 'addon-gratis', name: 'Grátis', price_cents: 0 });

  addons.whatsapp = await catalogo({ code: 'whatsapp', name: 'WhatsApp', kind: 'feature', feature: 'whatsapp', price_cents: 6000, price_yearly_cents: 60000 });
  addons.ia = await catalogo({ code: 'ia', name: 'IA', kind: 'feature', feature: 'ai', price_cents: 3000, sort: 1 });
  addons.operadores = await catalogo({
    code: 'mais-operadores', name: '+2 operadores', kind: 'limit', limit_resource: 'operators', limit_amount: 2, price_cents: 1000, sort: 2
  });
  addons.centavos = await catalogo({ code: 'centavos', name: 'Barato', kind: 'feature', feature: 'barato', price_cents: 600, sort: 3 });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  delete process.env.BILLING_WEBHOOK_TOKEN;
  await new Promise((r) => consoleServer.close(r));
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  recebidas = [];
  const db = getDb();
  await db('billing_charges').whereIn('tenant_id', [alfa, beta]).del();
  await db('billing_events').whereIn('tenant_id', [alfa, beta]).del();
  await db('tenant_addons').whereIn('tenant_id', [alfa, beta]).del();
  await db('addons').update({ gated: false, active: true, trial_access: true });
  await db('plans').where({ id: planos.pro.id }).update({ max_operators: null });
  AddonService.invalidateCatalog();
  for (const tenantId of [alfa, beta]) await assinar(tenantId);
});

describe('a conta (pura)', () => {
  it('a pró-rata é o preço do ciclo × o que falta, arredondada para cima', () => {
    const agora = new Date('2026-10-06T12:00:00Z');
    const sub = { status: 'active', renews_at: new Date(agora.getTime() + 10 * DAY + 1000), billing_cycle: 'monthly' };
    const q = AddonService.prorationQuote(sub, planos.pro, addons.whatsapp, agora);
    assert.equal(q.eligible, true);
    assert.equal(q.amountCents, Math.ceil((6000 * (10 * 86_400 + 1)) / (30 * 86_400)));
    assert.equal(q.remainingDays, 11);
    assert.equal(q.priceCents, 6000);
  });

  it('nada na hora em teste, sem período correndo ou isento; abaixo do mínimo, `skipped`', () => {
    const agora = new Date('2026-10-06T12:00:00Z');
    const vivo = { status: 'active', renews_at: new Date(agora.getTime() + 15 * DAY) };
    assert.equal(AddonService.prorationQuote({ ...vivo, status: 'trial' }, planos.pro, addons.ia, agora).eligible, false);
    assert.equal(AddonService.prorationQuote({ ...vivo, renews_at: new Date(agora.getTime() - DAY) }, planos.pro, addons.ia, agora).eligible, false);
    assert.equal(AddonService.prorationQuote({ ...vivo, billing_exempt_at: agora }, planos.pro, addons.ia, agora).eligible, false);
    const barato = AddonService.prorationQuote(vivo, planos.pro, addons.centavos, agora);
    assert.equal(barato.amountCents, 300);
    assert.equal(barato.skipped, 'below_minimum');
  });

  it('no anual: o preço anual do add-on, ou doze vezes o mensal sem ele; o período é o ano', () => {
    assert.equal(addonCyclePriceCents(addons.whatsapp, 'annual'), 60000);
    assert.equal(addonCyclePriceCents(addons.ia, 'annual'), 36000);
    const agora = new Date('2026-10-06T12:00:00Z');
    const sub = { status: 'active', renews_at: new Date(agora.getTime() + 73 * DAY), billing_cycle: 'annual' };
    const q = AddonService.prorationQuote(sub, planos.pro, addons.whatsapp, agora);
    assert.equal(q.billingCycle, 'annual');
    assert.equal(q.amountCents, 12000, '60000 × 73 ÷ 365');
  });

  it('a renovação: fora a cancelada para o início do período, a de graça e a repetida', () => {
    const catalog = new Map(Object.values(addons).map((a) => [Number(a.id), a]));
    const keyOf = (d) => ChargeIssuingService.periodKey(d);
    const rows = [
      { addon_id: addons.whatsapp.id, status: 'active', free: false, cancel_at: null },
      { addon_id: addons.whatsapp.id, status: 'active', free: false, cancel_at: null },
      { addon_id: addons.ia.id, status: 'active', free: false, cancel_at: new Date('2026-11-10T15:00:00Z') },
      { addon_id: addons.operadores.id, status: 'active', free: true, cancel_at: null },
      { addon_id: addons.centavos.id, status: 'canceled', free: false, cancel_at: null }
    ];
    assert.deepEqual(
      renewalItemsFor({ rows, catalog, cycle: 'monthly', periodKey: '2026-11-10', keyOf }),
      [{ code: 'whatsapp', name: 'WhatsApp', cents: 6000 }]
    );
    assert.deepEqual(
      renewalItemsFor({ rows, catalog, cycle: 'monthly', periodKey: '2026-10-10', keyOf }).map((i) => i.code),
      ['whatsapp', 'ia'],
      'o período ANTES do cancelamento ainda o cobra'
    );
  });

  it('a contabilidade abre os add-ons sem quebrar a conta', () => {
    const conta = chargeBreakdown({
      amount_cents: 26000 - 2000,
      credit_reserved_cents: 0,
      coupon_id: null,
      kind: 'renewal',
      pricing_detail: JSON.stringify({ base: 18000, overage: [], addons: [{ code: 'whatsapp', cents: 6000 }] })
    });
    assert.equal(conta.addonCents, 6000);
    assert.equal(conta.adjustmentCents, 0);
    assert.equal(conta.grossCents - conta.couponDiscountCents - conta.creditCents + conta.adjustmentCents, conta.netCents);
    const prorata = chargeBreakdown({
      amount_cents: 2000, kind: 'addon', pricing_detail: JSON.stringify({ base: 0, addons: [{ code: 'ia', cents: 2000, proration: true }] })
    });
    assert.deepEqual([prorata.grossCents, prorata.addonCents, prorata.adjustmentCents, prorata.netCents], [2000, 2000, 0, 2000]);
  });

  it('o relatório de receita soma o MRR dos add-ons à parte', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    const range = parseRange({ from: '2026-10-01', to: '2026-10-31' }, now);
    const sub = { id: 1, tenant_id: 1, plan_id: planos.pro.id, status: 'active', renews_at: new Date('2026-11-01T00:00:00Z') };
    const r = aggregateRevenue({
      range, now, tenants: [{ id: 1 }], subscriptions: [sub], plans: [planos.pro], prices: new Map([[1, 20000]]),
      charges: [], events: [], addonPrices: new Map([[1, 6000]])
    });
    assert.equal(r.mrrCents, 20000);
    assert.equal(r.addonMrrCents, 6000);
  });
});

describe('a porta (requireAddon)', () => {
  const contas = (token = donoToken) => call(`${panelUrl}/api/whatsapp/accounts`, { headers: token ? authHeaders(token) : {} });

  it('sem add-on `gated` no catálogo, nada muda para ninguém', async () => {
    const res = await contas();
    assert.notEqual(res.status, 402, JSON.stringify(res.body));
  });

  it('com o add-on `gated`, quem não tem ouve 402 — e o anônimo, o 401 de sempre', async () => {
    await getDb()('addons').where({ id: addons.whatsapp.id }).update({ gated: true });
    AddonService.invalidateCatalog();
    const res = await contas();
    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.code, 'addon_required');
    assert.deepEqual(res.body.addons, ['whatsapp']);
    assert.equal((await contas(null)).status, 401);

    // Quem tem, passa.
    assert.equal((await ativar('whatsapp')).status, 200);
    assert.notEqual((await contas()).status, 402);
  });

  it('o add-on `gated` mas INATIVO no catálogo não fecha nada', async () => {
    await getDb()('addons').where({ id: addons.whatsapp.id }).update({ gated: true, active: false });
    AddonService.invalidateCatalog();
    assert.notEqual((await contas()).status, 402);
  });

  it('em teste passa quando o add-on deixa; a caixa da plataforma passa sempre', async () => {
    await getDb()('addons').where({ id: addons.whatsapp.id }).update({ gated: true });
    AddonService.invalidateCatalog();
    await assinar(alfa, { status: 'trial', renewsAt: null, trialEndsAt: daquiA(7) });
    assert.notEqual((await contas()).status, 402);
    await getDb()('addons').where({ id: addons.whatsapp.id }).update({ trial_access: false });
    AddonService.invalidateCatalog();
    assert.equal((await contas()).status, 402);
    assert.equal(await runInTenant(caixa, () => AddonService.refusalFor('whatsapp')), null);
  });

  it('a IA tem a porta dela, nas rotas da IA', async () => {
    await getDb()('addons').where({ id: addons.ia.id }).update({ gated: true });
    AddonService.invalidateCatalog();
    const status = await call(`${panelUrl}/api/whatsapp/ai/status`, { headers: authHeaders(donoToken) });
    assert.equal(status.status, 402);
    assert.notEqual((await contas()).status, 402, 'o WhatsApp continua aberto');
  });
});

describe('os tetos', () => {
  it('o add-on de limite soma ao teto do plano', async () => {
    const usados = await runInTenant(alfa, () => SubscriptionService.operatorCount());
    await getDb()('plans').where({ id: planos.pro.id }).update({ max_operators: usados });
    await SubscriptionService.invalidate(alfa);
    await assert.rejects(runInTenant(alfa, () => SubscriptionService.assertCanAddOperator()), { code: 'plan_limit_operators' });
    assert.equal((await ativar('mais-operadores')).status, 200);
    await runInTenant(alfa, () => SubscriptionService.assertCanAddOperator());
    const uso = await runInTenant(alfa, () => SubscriptionService.usage());
    assert.equal(uso.limits.operators, usados + 2);
    // O vizinho continua com o teto do plano.
    assert.deepEqual((await AddonService.entitlements(beta)).limits, { operators: 0, subscribers: 0, devices: 0 });
  });
});

describe('a ativação', () => {
  it('cobra a pró-rata uma vez só, mesmo com dois cliques', async () => {
    const [a, b] = await Promise.all([ativar('whatsapp'), ativar('whatsapp')]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal((await linhasDe(alfa)).filter((l) => l.status === 'active').length, 1);
    const prorratas = (await cobrancasDe(alfa)).filter((c) => c.kind === 'addon');
    assert.equal(prorratas.length, 1);
    assert.equal(postsDeAddon().length, 1);
    const [pr] = prorratas;
    assert.match(pr.period_end, /^a[0-9a-f]{9}$/);
    const detalhe = JSON.parse(pr.proration_detail);
    assert.equal(Number(pr.amount_cents), Math.ceil((6000 * detalhe.remainingSeconds) / (30 * 86_400)));
    assert.equal(postsDeAddon()[0].payload.externalReference, `tenant:${alfa}:addon:${pr.id}`);
    assert.match(postsDeAddon()[0].payload.description, /add-on WhatsApp \(pró-rata\)/);
    assert.equal(BillingCharge.addonCentsOf(pr), Number(pr.amount_cents));

    // De novo depois: já ativo, nada.
    const outra = await ativar('whatsapp');
    assert.equal(outra.body.data.result.already, true);
    assert.equal((await cobrancasDe(alfa)).filter((c) => c.kind === 'addon').length, 1);
  });

  it('paga, a pró-rata não compra período', async () => {
    const renova = (await Subscription.forTenant(alfa)).renews_at;
    assert.equal((await ativar('ia')).status, 200);
    const [pr] = (await cobrancasDe(alfa)).filter((c) => c.kind === 'addon');
    const res = await entregar({
      event: 'PAYMENT_RECEIVED',
      payment: { id: pr.gateway_charge_id, value: Number(pr.amount_cents) / 100, customer: 'cus_alfa', externalReference: `tenant:${alfa}:addon:${pr.id}` }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.code, 'recorded');
    assert.equal((await getDb()('billing_charges').where({ id: pr.id }).first()).status, 'paid');
    assert.equal(new Date((await Subscription.forTenant(alfa)).renews_at).getTime(), new Date(renova).getTime());
  });

  it('recusa o código desconhecido, o inativo e o plano de graça', async () => {
    assert.equal((await ativar('nao-existe')).status, 404);
    await getDb()('addons').where({ id: addons.ia.id }).update({ active: false });
    assert.equal((await ativar('ia')).status, 404);
    await assinar(alfa, { plan: planos.gratis });
    const gratis = await ativar('whatsapp');
    assert.equal(gratis.status, 409);
    assert.equal(gratis.body.code, 'paid_plan_required');
  });

  it('a vitrine mostra a prévia da pró-rata e o estado', async () => {
    const lista = (await provedor('/addons')).body.data;
    const whatsapp = lista.addons.find((a) => a.code === 'whatsapp');
    assert.equal(whatsapp.available, true);
    assert.ok(whatsapp.proration.amountCents > 0);
    assert.equal(whatsapp.cycleCents, 6000);
    await ativar('whatsapp');
    const depois = (await provedor('/addons')).body.data.addons.find((a) => a.code === 'whatsapp');
    assert.equal(depois.subscription.live, true);
    assert.equal(depois.available, false);
  });
});

describe('a renovação', () => {
  it('soma os add-ons ao plano, fora do cupom, e diz na descrição', async () => {
    const cupom = await Coupon.create({ code: 'ADDON10', kind: 'percent', value: 10, duration: 'forever', redemptions: 0, active: true });
    await assinar(alfa, { coupon: cupom, renewsAt: daquiA(2) });
    await runInTenant(alfa, () => getDb()('tenant_addons').insert([
      { tenant_id: alfa, addon_id: addons.whatsapp.id, status: 'active', active_key: addons.whatsapp.id, started_at: daquiA(-3) },
      { tenant_id: alfa, addon_id: addons.ia.id, status: 'active', active_key: addons.ia.id, started_at: daquiA(-3) }
    ]));
    const emitida = await emitir(alfa);
    assert.equal(emitida.issued, true, JSON.stringify(emitida));
    const [renovacao] = (await cobrancasDe(alfa)).filter(ehRenovacao);
    // 20000 com 10% = 18000; os add-ons inteiros.
    assert.equal(Number(renovacao.amount_cents), 18000 + 6000 + 3000);
    const conta = BillingCharge.pricingDetailOf(renovacao);
    assert.equal(conta.base, 18000);
    assert.deepEqual(conta.addons, [{ code: 'whatsapp', name: 'WhatsApp', cents: 6000 }, { code: 'ia', name: 'IA', cents: 3000 }]);
    const post = recebidas.find((r) => r.method === 'POST' && r.payload?.externalReference === `tenant:${alfa}:${renovacao.period_end}`);
    assert.match(post.payload.description, /\+ add-ons R\$ 90,00 \(WhatsApp R\$ 60,00; IA R\$ 30,00\)/);
    assert.equal(post.payload.value, 270);
    const linhaContabil = chargeBreakdown(renovacao, { plan: planos.pro });
    assert.equal(linhaContabil.couponDiscountCents, 2000);
    assert.equal(linhaContabil.addonCents, 9000);
    assert.equal(linhaContabil.adjustmentCents, 0);
  });

  it('no anual, o preço anual de cada add-on (ou doze vezes o mensal)', async () => {
    await assinar(alfa, { cycle: 'annual', renewsAt: daquiA(2) });
    await getDb()('tenant_addons').insert([
      { tenant_id: alfa, addon_id: addons.whatsapp.id, status: 'active', active_key: addons.whatsapp.id, started_at: daquiA(-3) },
      { tenant_id: alfa, addon_id: addons.ia.id, status: 'active', active_key: addons.ia.id, started_at: daquiA(-3) }
    ]);
    assert.equal((await emitir(alfa)).issued, true);
    const [renovacao] = (await cobrancasDe(alfa)).filter(ehRenovacao);
    assert.equal(Number(renovacao.amount_cents), 200000 + 60000 + 36000);
    assert.equal(renovacao.billing_cycle, 'annual');
  });

  it('a de graça do console não entra na fatura', async () => {
    const dado = await platform(`/tenants/${alfa}/addons`, { method: 'POST', body: { code: 'whatsapp', reason: 'parceiro' } });
    assert.equal(dado.status, 201, JSON.stringify(dado.body));
    await assinar(alfa, { renewsAt: daquiA(2) });
    assert.equal((await emitir(alfa)).issued, true);
    const [renovacao] = (await cobrancasDe(alfa)).filter(ehRenovacao);
    assert.equal(Number(renovacao.amount_cents), 20000);
    assert.ok((await AddonService.entitlements(alfa)).features.includes('whatsapp'));
  });

  it('a fatura da renovação JÁ emitida é reemitida com o add-on, pela porta da troca de plano', async () => {
    await assinar(alfa, { renewsAt: daquiA(2) });
    assert.equal((await emitir(alfa)).issued, true);
    const [antes] = (await cobrancasDe(alfa)).filter(ehRenovacao);
    assert.equal(Number(antes.amount_cents), 20000);
    recebidas = [];
    assert.equal((await ativar('ia')).status, 200);
    assert.ok(recebidas.some((r) => r.method === 'DELETE' && r.path === `/payments/${antes.gateway_charge_id}`), 'a velha cancelada');
    const [depois] = (await cobrancasDe(alfa)).filter(ehRenovacao);
    assert.equal(depois.id, antes.id);
    assert.equal(Number(depois.amount_cents), 23000);
    assert.notEqual(depois.gateway_charge_id, antes.gateway_charge_id);
  });
});

describe('o cancelamento', () => {
  it('vale na renovação: o add-on segue até lá, e a fatura seguinte sai sem ele', async () => {
    await assinar(alfa, { renewsAt: daquiA(4) });
    assert.equal((await ativar('whatsapp')).status, 200);
    const prorratas = (await cobrancasDe(alfa)).filter((c) => c.kind === 'addon').length;
    const res = await cancelar('whatsapp');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.result.scheduled, true);
    const [linha] = await linhasDe(alfa);
    assert.equal(linha.status, 'active');
    assert.equal(new Date(linha.cancel_at).getTime(), new Date((await Subscription.forTenant(alfa)).renews_at).getTime());
    assert.ok((await AddonService.entitlements(alfa)).features.includes('whatsapp'), 'vale até a renovação');

    assert.equal((await emitir(alfa)).issued, true);
    const [renovacao] = (await cobrancasDe(alfa)).filter(ehRenovacao);
    assert.equal(Number(renovacao.amount_cents), 20000, 'a renovação já sai sem ele');
    assert.equal((await cobrancasDe(alfa)).filter((c) => c.kind === 'addon').length, prorratas, 'cancelar não cobra');

    // Chegou a renovação: deixa de valer, e a faxina põe o estado em dia.
    await getDb()('tenant_addons').where({ id: linha.id }).update({ cancel_at: daquiA(-1) });
    AddonService.invalidate(alfa);
    assert.ok(!(await AddonService.entitlements(alfa)).features.includes('whatsapp'));
    await provedor('/addons');
    const [fechada] = await linhasDe(alfa);
    assert.equal(fechada.status, 'canceled');
    assert.equal(fechada.active_key, null);
  });

  it('reativar antes da renovação só desfaz o agendamento — sem cobrar de novo', async () => {
    assert.equal((await ativar('whatsapp')).status, 200);
    assert.equal((await cancelar('whatsapp')).status, 200);
    const antes = (await cobrancasDe(alfa)).filter((c) => c.kind === 'addon').length;
    const res = await ativar('whatsapp');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.result.reactivated, true);
    const linhas = await linhasDe(alfa);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].cancel_at, null);
    assert.equal((await cobrancasDe(alfa)).filter((c) => c.kind === 'addon').length, antes);
  });

  it('sem período pago correndo, sai na hora', async () => {
    await assinar(alfa, { status: 'trial', renewsAt: null, trialEndsAt: daquiA(7) });
    assert.equal((await ativar('whatsapp')).status, 200);
    assert.deepEqual((await cobrancasDe(alfa)).filter((c) => c.kind === 'addon'), [], 'em teste, sem pró-rata');
    const res = await cancelar('whatsapp');
    assert.equal(res.body.data.result.scheduled, false);
    assert.equal((await linhasDe(alfa))[0].status, 'canceled');
  });
});

describe('o console e o isolamento', () => {
  it('o catálogo: criar, ligar a porta, apagar só o nunca contratado', async () => {
    const criado = await platform('/addons', {
      method: 'POST',
      body: { code: 'relatorios', name: 'Relatórios', kind: 'feature', feature: 'reports', priceCents: 2500, gated: false }
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    const id = criado.body.data.addon.id;
    const mudado = await platform(`/addons/${id}`, { method: 'PATCH', body: { gated: true, priceCents: 2700 } });
    assert.equal(mudado.status, 200);
    assert.equal(mudado.body.data.addon.gated, true);
    assert.equal((await platform(`/addons/${id}`, { method: 'PATCH', body: { code: 'x' } })).status, 400);
    assert.equal((await platform('/addons', {
      method: 'POST', body: { code: 'relatorios', name: 'X', kind: 'feature', feature: 'x', priceCents: 1 }
    })).status, 409);
    // O já contratado (mesmo cancelado) não se apaga: desativa-se.
    await getDb()('tenant_addons').insert({ tenant_id: alfa, addon_id: id, status: 'canceled', started_at: daquiA(-2) });
    const emUso = await platform(`/addons/${id}`, { method: 'DELETE' });
    assert.equal(emUso.status, 409);
    assert.equal(emUso.body.code, 'addon_in_use');
    await getDb()('tenant_addons').where({ addon_id: id }).del();
    assert.equal((await platform(`/addons/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await platform('/addons/999999', { method: 'PATCH', body: { name: 'x' } })).status, 404);
  });

  it('o add-on de um provedor não aparece, não vale e não é revogável no outro', async () => {
    assert.equal((await ativar('whatsapp')).status, 200);
    assert.deepEqual(await linhasDe(beta), []);
    assert.deepEqual((await AddonService.entitlements(beta)).features, []);
    const doBeta = await platform(`/tenants/${beta}/addons`);
    assert.equal(doBeta.status, 200);
    assert.deepEqual(doBeta.body.data.addons, []);
    const revogar = await platform(`/tenants/${beta}/addons/whatsapp/revoke`, { method: 'POST', body: { reason: 'teste' } });
    assert.equal(revogar.status, 409);
    assert.equal((await linhasDe(alfa))[0].status, 'active', 'o do alfa ficou');
    assert.equal((await platform(`/tenants/${caixa}/addons`)).status, 404);
  });

  it('revogar tira na hora, com motivo e nas duas trilhas', async () => {
    assert.equal((await ativar('whatsapp')).status, 200);
    const sem = await platform(`/tenants/${alfa}/addons/whatsapp/revoke`, { method: 'POST', body: {} });
    assert.equal(sem.status, 400);
    const res = await platform(`/tenants/${alfa}/addons/whatsapp/revoke`, { method: 'POST', body: { reason: 'pedido do cliente' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await linhasDe(alfa))[0].status, 'canceled');
    assert.ok(!(await AddonService.entitlements(alfa)).features.includes('whatsapp'));
    const trilha = await getDb()('platform_audit').where({ action: 'tenant.addon_changed', tenant_id: alfa }).orderBy('id', 'desc').first();
    assert.equal(JSON.parse(trilha.detail).reason, 'pedido do cliente');
  });
});
