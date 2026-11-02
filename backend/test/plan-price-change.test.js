import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';
import { smtpDeMentira, decodificarQuotedPrintable } from './helpers/fakeSmtp.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: Coupon } = await import('../src/models/Coupon.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: PlanPriceChange } = await import('../src/models/PlanPriceChange.js');
const { tinsertReturningId } = await import('../src/config/database.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: PlanPriceChangeService, addDaysIso } = await import('../src/services/planPriceChangeService.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');

/**
 * O reajuste de preço com data de vigência (0122).
 *
 * A montagem de `platform-coupons.test.js`: o roteador do console de verdade
 * num app mínimo, o painel para a rota do provedor e um gateway de mentira em
 * `127.0.0.1` — mais um SMTP de mentira para o aviso. O que importa é o
 * dinheiro:
 *
 * 1. A cobrança que vence ANTES da data paga o preço de antes; a que vence na
 *    data ou depois, o novo — no mensal e no anual, com o cupom descontando
 *    sobre o preço novo.
 * 2. A cobrança já emitida com o preço velho que vence na vigência é
 *    reemitida UMA vez (a passada repetida, a falha do gateway e a retomada
 *    não fazem duas), e a de valor mudado à mão e a do isento não são tocadas.
 * 3. Cancelar o reajuste devolve ao preço de antes o que já tinha saído pelo
 *    novo.
 * 4. O aviso sai uma vez por provedor e por reajuste.
 *
 * Datas ao segundo, como em todo teste de cobrança: o MySQL guarda ao segundo.
 */
const CHAVE = 'chave-do-reajuste';
const DIA = 24 * 60 * 60 * 1000;

let gateway;
let recebidas = [];
let proximoId = 0;
let cancelamentoFalha = false;
let smtp;
let emails;
let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let estranhoToken;
let alfa;
let beta;
let gama;
const planos = {};
let sequencia = 0;

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
          id: `pay_reajuste_${proximoId}`,
          invoiceUrl: `https://asaas.test/i/${proximoId}`,
          dueDate: payload?.dueDate ?? null,
          value: payload?.value,
          status: 'PENDING'
        });
      }
      if (req.method === 'DELETE' && /^\/payments\/[^/]+$/.test(caminho)) {
        if (cancelamentoFalha) return responder(500, { errors: [{ description: 'fora do ar' }] });
        return responder(200, { deleted: true });
      }
      if (req.method === 'GET' && caminho === '/payments') return responder(200, { data: [] });
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

const platform = (caminho, options = {}, token = donoToken) => call(`${consoleUrl}/api/platform${caminho}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

/** Um instante relativo a agora, já ao segundo (o MySQL arredonda os milissegundos). */
const daquiA = (dias) => new Date(Math.floor((Date.now() + dias * DIA) / 1000) * 1000);
const hoje = () => ChargeIssuingService.isoDate(new Date());
/** O meio-dia, em São Paulo, de uma data `YYYY-MM-DD`. */
const meioDia = (iso) => new Date(`${iso}T12:00:00-03:00`);

async function assinar(tenantId, {
  plan = planos.pro, cycle = 'monthly', status = 'active', renewsAt = daquiA(45), coupon = null, exempt = false
} = {}) {
  await Subscription.upsertForTenant(tenantId, {
    plan_id: plan.id,
    billing_cycle: cycle,
    pending_billing_cycle: null,
    status,
    renews_at: renewsAt,
    trial_ends_at: null,
    canceled_at: null,
    pending_plan_id: null,
    pending_plan_at: null,
    pending_plan_locked_at: null,
    upgraded_at: null,
    billing_exempt_at: exempt ? daquiA(-1) : null,
    billing_exempt_reason: exempt ? 'cortesia' : null,
    proration_due_at: null,
    suspended_reason: null,
    cancel_at: null,
    paused_until: null,
    coupon_id: coupon?.id ?? null,
    coupon_cycles_left: null,
    coupon_applied_at: coupon ? daquiA(-1) : null
  });
  await SubscriptionService.invalidate(tenantId);
}

async function cupom(row = {}) {
  sequencia += 1;
  return Coupon.create({
    code: `REAJ${sequencia}`, kind: 'percent', value: 10, duration: 'forever', redemptions: 0, active: true, ...row
  });
}

const emitir = (tenantId) => runInTenant(tenantId, () => ChargeIssuingService.issueCurrent({ manual: true }));
const cobrancasDe = (tenantId) => getDb()('billing_charges').where({ tenant_id: tenantId }).orderBy('id', 'asc');

/** Agenda pelo console: `effectiveAt` relativo a hoje, em dias. */
const agendar = (planId, { cycle = 'monthly', newCents = 12000, dias = 40, noticeDays, notify, reason } = {}) => platform(
  `/plans/${planId}/price-changes`,
  {
    method: 'POST',
    body: {
      cycle, newCents, effectiveAt: addDaysIso(hoje(), dias),
      ...(noticeDays === undefined ? {} : { noticeDays }),
      ...(notify === undefined ? {} : { notify }),
      ...(reason === undefined ? {} : { reason })
    }
  }
);

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  ({ server: smtp, recebidas: emails } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtp.address().port}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'Plataforma <nao-responda@exemplo.test>';
  resetMailTransport();

  ({ panelUrl } = await startTestServers());
  consoleUrl = await subirConsole();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });

  const contratado = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(donoToken),
    body: { username: 'outro-admin', password: 'senha-do-outro-1', role: 'admin', email: 'outro@exemplo.test' }
  });
  assert.equal(contratado.status, 201, JSON.stringify(contratado.body));
  const entrou = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'outro-admin', password: 'senha-do-outro-1' }
  });
  estranhoToken = entrou.body?.data?.token;
  assert.ok(estranhoToken);

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
  await db('tenants').insert({ slug: 'gama', name: 'Provedor Gama', status: 'active' });
  gama = (await db('tenants').where({ slug: 'gama' }).first()).id;
  await db('tenants').whereIn('id', [alfa, beta, gama])
    .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_reajuste' });

  const criar = (row) => Plan.create({ currency: 'BRL', period_days: 30, trial_days: 0, active: true, ...row });
  planos.pro = await criar({ code: 'reaj-pro', name: 'Pro', price_cents: 10000, price_yearly_cents: 100000 });
  planos.so = await criar({ code: 'reaj-so-mensal', name: 'Só mensal', price_cents: 5000 });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  resetMailTransport();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  await new Promise((r) => consoleServer.close(r));
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => smtp.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  recebidas = [];
  emails.length = 0;
  cancelamentoFalha = false;
  const db = getDb();
  await db('plan_price_change_marks').del();
  await db('plan_price_changes').del();
  await db('billing_charges').whereIn('tenant_id', [alfa, beta, gama]).del();
  await db('billing_events').whereIn('tenant_id', [alfa, beta, gama]).del();
  await db('platform_audit').del();
  await db('plans').where({ id: planos.pro.id }).update({ price_cents: 10000, price_yearly_cents: 100000 });
  await db('tenants').whereIn('id', [alfa, beta, gama]).update({ billing_email: null, billing_phone: null });
  await assinar(alfa);
  // Beta e gama fora do plano, a não ser que o caso os ponha nele.
  await assinar(beta, { plan: planos.so });
  await assinar(gama, { plan: planos.so });
});

describe('o agendamento e as recusas', () => {
  it('agenda, grava na trilha e aparece na lista dos planos', async () => {
    const r = await agendar(planos.pro.id, { reason: 'IPCA' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pc = r.body.data.priceChange;
    assert.equal(pc.oldCents, 10000);
    assert.equal(pc.newCents, 12000);
    assert.equal(pc.noticeDays, 30);
    assert.equal(pc.notify, true);
    assert.equal(pc.status, 'scheduled');
    assert.equal(pc.effectiveAt, addDaysIso(hoje(), 40));
    assert.equal(r.body.data.preview.affected, 1);

    const trilha = await getDb()('platform_audit').where({ action: 'plan.price_change_scheduled' });
    assert.equal(trilha.length, 1);
    assert.equal(JSON.parse(trilha[0].detail).affected, 1);

    const lista = await platform('/plans');
    const pro = lista.body.data.plans.find((p) => p.id === planos.pro.id);
    assert.equal(pro.priceChanges.length, 1);
    assert.equal(pro.priceChanges[0].id, pc.id);
    // O preço do plano não muda antes da data.
    assert.equal(pro.priceCents, 10000);
  });

  it('recusa o que não serve, com o código que a tela lê', async () => {
    const casos = [
      [{ cycle: 'weekly' }, 400, 'invalid_cycle'],
      [{ newCents: 0 }, 400, 'invalid_price'],
      [{ newCents: -5 }, 400, 'invalid_price'],
      [{ newCents: 10000 }, 400, 'same_price'],
      [{ noticeDays: 0 }, 400, 'invalid_notice_days'],
      [{ noticeDays: 400 }, 400, 'invalid_notice_days'],
      // Trinta dias de aviso pedem a data a partir de hoje + 30.
      [{ dias: 10 }, 400, 'effective_too_soon'],
      [{ dias: 29 }, 400, 'effective_too_soon'],
      [{ dias: 15, noticeDays: 20 }, 400, 'effective_too_soon'],
      [{ dias: 800 }, 400, 'effective_too_far'],
      [{ notify: 'sim' }, 400, 'invalid_notify']
    ];
    for (const [opcoes, status, code] of casos) {
      // eslint-disable-next-line no-await-in-loop
      const r = await agendar(planos.pro.id, opcoes);
      assert.equal(r.status, status, `${JSON.stringify(opcoes)}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code, JSON.stringify(opcoes));
    }
    const dataRuim = await platform(`/plans/${planos.pro.id}/price-changes`, {
      method: 'POST', body: { cycle: 'monthly', newCents: 12000, effectiveAt: '2026-02-30' }
    });
    assert.equal(dataRuim.body.code, 'invalid_date');
    // O anual de um plano sem preço anual não tem o que reajustar.
    const semAnual = await agendar(planos.so.id, { cycle: 'annual' });
    assert.equal(semAnual.body.code, 'no_current_price');
    // Com aviso mais curto, a data mais cedo passa.
    assert.equal((await agendar(planos.pro.id, { dias: 15, noticeDays: 15 })).status, 201);
    assert.equal(await getDb()('plan_price_changes').count({ n: '*' }).first().then((l) => Number(l.n)), 1);
  });

  it('um reajuste agendado por plano e ciclo; o outro ciclo pode', async () => {
    assert.equal((await agendar(planos.pro.id)).status, 201);
    const outro = await agendar(planos.pro.id, { newCents: 13000, dias: 60 });
    assert.equal(outro.status, 409);
    assert.equal(outro.body.code, 'price_change_exists');
    assert.equal((await agendar(planos.pro.id, { cycle: 'annual', newCents: 110000 })).status, 201);
  });

  // Quem não é da plataforma toma 404, como em todo o console: a porta não se anuncia.
  it('é do console: quem não é da plataforma não alcança, e id que não existe é 404', async () => {
    const r = await platform(`/plans/${planos.pro.id}/price-changes`, {
      method: 'POST', body: { cycle: 'monthly', newCents: 12000, effectiveAt: addDaysIso(hoje(), 40) }
    }, estranhoToken);
    assert.equal(r.status, 404);
    assert.equal((await platform(`/plans/${planos.pro.id}/price-change-preview?cycle=monthly`, {}, estranhoToken)).status, 404);
    assert.equal((await platform('/plan-price-changes/1/cancel', { method: 'POST' }, estranhoToken)).status, 404);
    assert.equal((await agendar(999999)).status, 404);
    assert.equal((await platform('/plans/999999/price-change-preview?cycle=monthly')).status, 404);
    assert.equal((await platform('/plan-price-changes/999999/cancel', { method: 'POST' })).status, 404);
    assert.equal(await getDb()('plan_price_changes').count({ n: '*' }).first().then((l) => Number(l.n)), 0);
  });
});

describe('a prévia', () => {
  it('conta só quem paga o preço novo, com o cupom de cada um, antes e depois', async () => {
    const dez = await cupom();
    await assinar(alfa, { coupon: dez });
    await assinar(beta);
    // Gama no anual do mesmo plano: não entra no reajuste do mensal.
    await assinar(gama, { cycle: 'annual' });
    const r = await platform(`/plans/${planos.pro.id}/price-change-preview?cycle=monthly&newCents=12000`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = r.body.data.preview;
    assert.equal(p.affected, 2);
    assert.equal(p.currentCents, 10000);
    assert.equal(p.newCents, 12000);
    // 9000 (alfa, 10% de 10000) + 10000 (beta) → 10800 + 12000.
    assert.equal(p.revenueBeforeCents, 19000);
    assert.equal(p.revenueAfterCents, 22800);
    assert.equal(p.deltaCents, 3800);

    // O isento e o cancelado ficam de fora — o isento é contado à parte.
    await assinar(beta, { exempt: true });
    await assinar(alfa, { status: 'canceled' });
    const depois = (await platform(`/plans/${planos.pro.id}/price-change-preview?cycle=monthly&newCents=12000`)).body.data.preview;
    assert.equal(depois.affected, 0);
    assert.equal(depois.exempt, 1);
    assert.equal(depois.revenueBeforeCents, 0);

    const anual = (await platform(`/plans/${planos.pro.id}/price-change-preview?cycle=annual&newCents=120000`)).body.data.preview;
    assert.equal(anual.affected, 1);
    assert.equal(anual.revenueBeforeCents, 100000);
    assert.equal(anual.revenueAfterCents, 120000);
  });
});

describe('o preço pelo vencimento', () => {
  it('mensal: antes da data, o preço de antes; na data e depois, o novo', async () => {
    assert.equal((await agendar(planos.pro.id, { dias: 40 })).status, 201);
    await assinar(alfa, { renewsAt: daquiA(35) });
    const antes = await emitir(alfa);
    assert.equal(antes.issued, true, JSON.stringify(antes));
    assert.equal(Number((await cobrancasDe(alfa))[0].amount_cents), 10000);
    assert.equal(recebidas.find((r) => r.method === 'POST').payload.value, 100);

    await getDb()('billing_charges').where({ tenant_id: alfa }).del();
    recebidas = [];
    // Vencendo exatamente na data de vigência: o preço novo.
    await assinar(alfa, { renewsAt: meioDia(addDaysIso(hoje(), 40)) });
    assert.equal((await emitir(alfa)).issued, true);
    assert.equal(Number((await cobrancasDe(alfa))[0].amount_cents), 12000);
    assert.equal(recebidas.find((r) => r.method === 'POST').payload.value, 120);
  });

  it('anual: o reajuste do anual muda só a fatura do ano, e só depois da data', async () => {
    assert.equal((await agendar(planos.pro.id, { cycle: 'annual', newCents: 120000 })).status, 201);
    await assinar(alfa, { cycle: 'annual', renewsAt: daquiA(45) });
    assert.equal((await emitir(alfa)).issued, true);
    assert.equal(Number((await cobrancasDe(alfa))[0].amount_cents), 120000);

    await getDb()('billing_charges').where({ tenant_id: alfa }).del();
    await assinar(alfa, { cycle: 'annual', renewsAt: daquiA(35) });
    assert.equal((await emitir(alfa)).issued, true);
    assert.equal(Number((await cobrancasDe(alfa))[0].amount_cents), 100000);

    // O mensal do mesmo plano não muda com o reajuste do anual.
    await getDb()('billing_charges').where({ tenant_id: alfa }).del();
    await assinar(alfa, { renewsAt: daquiA(45) });
    assert.equal((await emitir(alfa)).issued, true);
    assert.equal(Number((await cobrancasDe(alfa))[0].amount_cents), 10000);
  });

  it('o cupom desconta sobre o preço novo', async () => {
    assert.equal((await agendar(planos.pro.id)).status, 201);
    await assinar(alfa, { coupon: await cupom(), renewsAt: daquiA(45) });
    assert.equal((await emitir(alfa)).issued, true);
    const linha = (await cobrancasDe(alfa))[0];
    assert.equal(Number(linha.amount_cents), 10800, '12000 − 10%');
  });

  it('aplicado na data: o plano passa ao preço novo, uma vez; a cobrança que vence antes segue no de antes', async () => {
    const r = await agendar(planos.pro.id);
    const efetiva = r.body.data.priceChange.effectiveAt;
    // A véspera não aplica.
    await PlanPriceChangeService.runDue({ now: meioDia(addDaysIso(efetiva, -1)) });
    assert.equal(Number((await Plan.findById(planos.pro.id)).price_cents), 10000);

    const resumo = await PlanPriceChangeService.runDue({ now: meioDia(efetiva) });
    assert.equal(resumo.applied, 1);
    assert.equal(Number((await Plan.findById(planos.pro.id)).price_cents), 12000);
    assert.equal(Number((await Plan.findById(planos.pro.id)).price_yearly_cents), 100000, 'o anual fica');
    const change = await PlanPriceChange.findById(r.body.data.priceChange.id);
    assert.equal(change.status, 'applied');
    assert.ok(change.applied_at);
    assert.equal((await PlanPriceChangeService.runDue({ now: meioDia(efetiva) })).applied, 0, 'uma vez só');
    assert.equal((await getDb()('platform_audit').where({ action: 'plan.price_change_applied' })).length, 1);

    // A cobrança atrasada que vence antes da data é do preço de antes.
    await assinar(alfa, { status: 'past_due', renewsAt: meioDia(addDaysIso(efetiva, -3)) });
    assert.equal((await emitir(alfa)).issued, true);
    assert.equal(Number((await cobrancasDe(alfa))[0].amount_cents), 10000);
  });
});

describe('a cobrança já emitida', () => {
  /** A cobrança do prazo vivo emitida com o preço de antes, antes de haver reajuste. */
  async function emitidaAntes(tenantId) {
    assert.equal((await emitir(tenantId)).issued, true);
    const [linha] = await cobrancasDe(tenantId);
    assert.equal(Number(linha.amount_cents), 10000);
    recebidas = [];
    return linha;
  }

  it('a que vence na vigência é reemitida uma vez com o preço novo', async () => {
    const velha = await emitidaAntes(alfa);
    assert.equal((await agendar(planos.pro.id, { notify: false })).status, 201);

    const r1 = await PlanPriceChangeService.runDue();
    assert.equal(r1.repriced, 1, JSON.stringify(r1));
    const [linha] = await cobrancasDe(alfa);
    assert.equal(Number(linha.amount_cents), 12000);
    assert.notEqual(linha.gateway_charge_id, velha.gateway_charge_id);
    assert.deepEqual(recebidas.map((r) => r.method), ['DELETE', 'POST']);
    assert.equal(recebidas[0].path, `/payments/${velha.gateway_charge_id}`);
    assert.equal(recebidas[1].payload.value, 120);

    // A passada repetida (e uma terceira) não faz nada.
    recebidas = [];
    assert.equal((await PlanPriceChangeService.runDue()).repriced, 0);
    assert.equal((await PlanPriceChangeService.runDue()).repriced, 0);
    assert.deepEqual(recebidas, []);
    assert.equal((await cobrancasDe(alfa)).length, 1);
    const trilha = await getDb()('audit_log').where({ tenant_id: alfa }).where('detail', 'like', '%plan.price_change_repriced%');
    assert.equal(trilha.length, 1);
  });

  it('o gateway fora: nada muda, a marca espera, e a retomada reemite uma vez', async () => {
    const velha = await emitidaAntes(alfa);
    assert.equal((await agendar(planos.pro.id, { notify: false })).status, 201);
    cancelamentoFalha = true;
    const r1 = await PlanPriceChangeService.runDue();
    assert.equal(r1.failed, 1);
    let [linha] = await cobrancasDe(alfa);
    assert.equal(Number(linha.amount_cents), 10000);
    assert.equal(linha.gateway_charge_id, velha.gateway_charge_id, 'a velha continua viva');
    assert.equal(recebidas.filter((r) => r.method === 'POST').length, 0);

    // Logo em seguida, ainda na espera: nem tenta.
    cancelamentoFalha = false;
    recebidas = [];
    assert.equal((await PlanPriceChangeService.runDue()).repriced, 0);
    assert.deepEqual(recebidas, []);

    // Passada a espera, reemite — uma vez.
    const depois = new Date(Date.now() + 20 * 60 * 1000);
    assert.equal((await PlanPriceChangeService.runDue({ now: depois })).repriced, 1);
    assert.equal((await PlanPriceChangeService.runDue({ now: new Date(depois.getTime() + 60_000) })).repriced, 0);
    [linha] = await cobrancasDe(alfa);
    assert.equal(Number(linha.amount_cents), 12000);
    assert.equal(recebidas.filter((r) => r.method === 'POST').length, 1);
  });

  it('não toca a de valor mudado à mão, a do isento, nem a que vence antes da data', async () => {
    const mexida = await emitidaAntes(alfa);
    await runInTenant(alfa, () => BillingCharge.update(mexida.id, { amount_overridden_at: daquiA(-1), amount_cents: 7000 }));
    await assinar(beta);
    await emitidaAntes(beta);
    await assinar(beta, { exempt: true });
    await assinar(gama, { renewsAt: daquiA(35) });
    await emitidaAntes(gama);
    assert.equal((await agendar(planos.pro.id, { notify: false })).status, 201);

    await PlanPriceChangeService.runDue();
    assert.deepEqual(recebidas.filter((r) => r.method !== 'GET'), []);
    assert.equal(Number((await cobrancasDe(alfa))[0].amount_cents), 7000);
    assert.equal(Number((await cobrancasDe(beta))[0].amount_cents), 10000);
    assert.equal(Number((await cobrancasDe(gama))[0].amount_cents), 10000);
  });

  it('cancelar o reajuste devolve ao preço de antes o que já saiu pelo novo', async () => {
    const r = await agendar(planos.pro.id, { notify: false });
    // Emitida DEPOIS do agendamento: já sai pelo preço novo.
    assert.equal((await emitir(alfa)).issued, true);
    const [nova] = await cobrancasDe(alfa);
    assert.equal(Number(nova.amount_cents), 12000);
    recebidas = [];

    const cancelado = await platform(`/plan-price-changes/${r.body.data.priceChange.id}/cancel`, { method: 'POST' });
    assert.equal(cancelado.status, 200, JSON.stringify(cancelado.body));
    assert.equal(cancelado.body.data.priceChange.status, 'canceled');
    const [linha] = await cobrancasDe(alfa);
    assert.equal(Number(linha.amount_cents), 10000);
    assert.deepEqual(recebidas.map((x) => x.method), ['DELETE', 'POST']);
    assert.equal((await getDb()('platform_audit').where({ action: 'plan.price_change_canceled' })).length, 1);

    // A passada seguinte não mexe de novo, e o plano nunca muda.
    recebidas = [];
    await PlanPriceChangeService.runDue({ now: meioDia(r.body.data.priceChange.effectiveAt) });
    assert.deepEqual(recebidas, []);
    assert.equal(Number((await Plan.findById(planos.pro.id)).price_cents), 10000);

    // Cancelar de novo é 409.
    const outra = await platform(`/plan-price-changes/${r.body.data.priceChange.id}/cancel`, { method: 'POST' });
    assert.equal(outra.status, 409);
    assert.equal(outra.body.code, 'not_scheduled');
    // E dá para agendar outro no lugar.
    assert.equal((await agendar(planos.pro.id)).status, 201);
  });
});

describe('o aviso', () => {
  it('sai uma vez por provedor e por reajuste, e entra na trilha do provedor', async () => {
    await assinar(beta);
    await getDb()('tenants').where({ id: beta }).update({ billing_email: 'financeiro@beta.test' });
    const r = await agendar(planos.pro.id);
    assert.equal(r.status, 201);
    const efetiva = r.body.data.priceChange.effectiveAt;

    // Antes da antecedência (40 dias à frente, 30 de aviso), nada sai.
    assert.equal((await PlanPriceChangeService.runDue()).notified, 0);
    assert.equal(emails.length, 0);
    const naHora = meioDia(addDaysIso(efetiva, -30));
    const primeira = await PlanPriceChangeService.runDue({ now: naHora });
    assert.equal(primeira.notified, 2, JSON.stringify(primeira));
    assert.equal(emails.length, 2);
    const texto = decodificarQuotedPrintable(emails.join('\n'));
    assert.match(texto, /Pro/);
    assert.match(texto, /120,00/);
    assert.match(texto, /100,00/);
    const [ano, mes, dia] = r.body.data.priceChange.effectiveAt.split('-');
    assert.ok(texto.includes(`${dia}/${mes}/${ano}`), 'a data no aviso');

    assert.equal((await PlanPriceChangeService.runDue({ now: naHora })).notified, 0);
    assert.equal((await PlanPriceChangeService.runDue({ now: new Date(naHora.getTime() + 3 * DIA) })).notified, 0);
    assert.equal(emails.length, 2, 'uma vez só');
    assert.ok((await PlanPriceChange.findById(r.body.data.priceChange.id)).notified_at);

    const trilha = await getDb()('audit_log').where({ tenant_id: beta }).where('detail', 'like', '%plan.price_change_notified%');
    assert.equal(trilha.length, 1);
  });

  it('desligado, não sai; e o isento não é avisado', async () => {
    await assinar(beta, { exempt: true });
    await getDb()('tenants').where({ id: beta }).update({ billing_email: 'financeiro@beta.test' });
    assert.equal((await agendar(planos.pro.id, { notify: false })).status, 201);
    const naHora = meioDia(addDaysIso(hoje(), 10));
    await PlanPriceChangeService.runDue({ now: naHora });
    assert.equal(emails.length, 0);
    assert.equal((await agendar(planos.pro.id, { cycle: 'annual', newCents: 110000 })).status, 201);
    await PlanPriceChangeService.runDue({ now: naHora });
    assert.equal(emails.length, 0, 'ninguém no anual');
  });

  it('a tela de Plano do provedor vê o reajuste que o pega, no plano atual do catálogo', async () => {
    const atualDe = async () => {
      const res = await call(`${panelUrl}/api/tenant/plans`, { headers: authHeaders(donoToken) });
      assert.equal(res.status, 200);
      return res.body.data.find((p) => p.current);
    };
    assert.equal((await atualDe()).priceChange, null);
    const r = await agendar(planos.pro.id);
    assert.deepEqual((await atualDe()).priceChange, {
      cycle: 'monthly', oldCents: 10000, newCents: 12000, effectiveAt: r.body.data.priceChange.effectiveAt, currency: 'BRL'
    });
    // `/subscription` continua sem falar de preço.
    const tela = await call(`${panelUrl}/api/tenant/subscription`, { headers: authHeaders(donoToken) });
    assert.equal(JSON.stringify(tela.body).includes('price'), false);
  });
});

describe('a edição direta com reajuste agendado', () => {
  const editar = (body) => platform(`/plans/${planos.pro.id}`, { method: 'PATCH', body });

  it('o preço do ciclo agendado não muda à mão: 409 price_change_scheduled', async () => {
    assert.equal((await agendar(planos.pro.id)).status, 201);
    const r = await editar({ priceCents: 15000 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'price_change_scheduled');
    assert.ok(r.body.message.includes(addDaysIso(hoje(), 40)), r.body.message);
    assert.equal(Number((await Plan.findById(planos.pro.id)).price_cents), 10000);

    // O mesmo preço (a tela manda os dois em toda edição) e o outro ciclo passam.
    const nome = await editar({ name: 'Pro Plus', priceCents: 10000, priceYearlyCents: 110000 });
    assert.equal(nome.status, 200, JSON.stringify(nome.body));
    assert.equal(Number((await Plan.findById(planos.pro.id)).price_yearly_cents), 110000);
    await getDb()('plans').where({ id: planos.pro.id }).update({ name: 'Pro' });

    // O anual agendado também trava o anual.
    assert.equal((await agendar(planos.pro.id, { cycle: 'annual', newCents: 130000 })).status, 201);
    const anual = await editar({ priceYearlyCents: 120000 });
    assert.equal(anual.status, 409);
    assert.equal(anual.body.code, 'price_change_scheduled');
  });

  it('cancelado o agendado, a edição direta volta a valer', async () => {
    const r = await agendar(planos.pro.id);
    await platform(`/plan-price-changes/${r.body.data.priceChange.id}/cancel`, { method: 'POST' });
    const editado = await editar({ priceCents: 15000 });
    assert.equal(editado.status, 200, JSON.stringify(editado.body));
  });
});

describe('quem vai estar no plano (a troca agendada)', () => {
  it('entra na prévia e recebe o aviso, pelo ciclo agendado', async () => {
    // Beta está no "Só mensal" e desce para o Pro na renovação, no mensal.
    await getDb()('subscriptions').where({ tenant_id: beta }).update({ pending_plan_id: planos.pro.id, pending_billing_cycle: null });
    // Gama vai para o Pro no ANUAL: não entra no reajuste do mensal.
    await getDb()('subscriptions').where({ tenant_id: gama }).update({ pending_plan_id: planos.pro.id, pending_billing_cycle: 'annual' });
    await SubscriptionService.invalidate(beta);
    await SubscriptionService.invalidate(gama);
    await getDb()('tenants').where({ id: beta }).update({ billing_email: 'financeiro@beta.test' });

    const p = (await platform(`/plans/${planos.pro.id}/price-change-preview?cycle=monthly&newCents=12000`)).body.data.preview;
    assert.equal(p.affected, 2, 'alfa e beta');
    assert.equal(p.revenueBeforeCents, 20000);
    assert.equal(p.revenueAfterCents, 24000);
    const anual = (await platform(`/plans/${planos.pro.id}/price-change-preview?cycle=annual&newCents=120000`)).body.data.preview;
    assert.equal(anual.affected, 1, 'gama, no anual agendado');

    const r = await agendar(planos.pro.id);
    const naHora = meioDia(addDaysIso(r.body.data.priceChange.effectiveAt, -30));
    await PlanPriceChangeService.runDue({ now: naHora });
    const avisados = (await PlanPriceChange.marksOf(r.body.data.priceChange.id)).filter((m) => m.mark === 'notice');
    assert.deepEqual(avisados.map((m) => Number(m.tenant_id)).sort((a, b) => a - b), [alfa, beta].sort((a, b) => a - b));
    assert.ok(emails.length >= 1);
  });
});

describe('a marca da reprecificação', () => {
  it('a candidata que não é a cobrança viva fica sem marca, e é revista depois', async () => {
    // Uma cobrança em aberto de OUTRO prazo (não a do `renews_at`), já no gateway.
    const efetiva = addDaysIso(hoje(), 40);
    const outroPrazo = addDaysIso(hoje(), 75);
    await runInTenant(alfa, () => tinsertReturningId('billing_charges', {
      period_end: outroPrazo, amount_cents: 10000, currency: 'BRL', provider: 'asaas', status: 'pending',
      gateway_charge_id: 'pay_outro_prazo', due_date: outroPrazo
    }));
    assert.equal((await agendar(planos.pro.id, { notify: false })).status, 201);
    assert.ok(outroPrazo >= efetiva);
    const change = (await PlanPriceChange.list({ planId: planos.pro.id }))[0];

    await PlanPriceChangeService.runDue();
    const marcas = await PlanPriceChange.marksOf(change.id, { prefix: 'reprice:' });
    assert.deepEqual(marcas, [], 'nenhuma marca para a cobrança que a reprecificação não olhou');
    // E segue candidata na passada seguinte.
    const candidatas = await PlanPriceChangeService.candidateCharges(change, 'reprice:');
    assert.equal(candidatas.length, 1);
    assert.equal(Number((await cobrancasDe(alfa))[0].amount_cents), 10000, 'não foi tocada');
  });

  it('a cobrança viva fica marcada, uma vez', async () => {
    assert.equal((await emitir(alfa)).issued, true);
    recebidas = [];
    assert.equal((await agendar(planos.pro.id, { notify: false })).status, 201);
    const change = (await PlanPriceChange.list({ planId: planos.pro.id }))[0];
    await PlanPriceChangeService.runDue();
    const [linha] = await cobrancasDe(alfa);
    const marcas = await PlanPriceChange.marksOf(change.id, { prefix: 'reprice:' });
    assert.deepEqual(marcas.map((m) => [m.mark, m.status]), [[`reprice:${linha.id}`, 'done']]);
  });
});

describe('o aviso de cancelamento', () => {
  it('quem foi avisado ouve, uma vez, que o reajuste caiu; quem não foi, nada', async () => {
    await assinar(beta);
    await getDb()('tenants').where({ id: beta }).update({ billing_email: 'financeiro@beta.test' });
    const r = await agendar(planos.pro.id);
    const id = r.body.data.priceChange.id;
    const naHora = meioDia(addDaysIso(r.body.data.priceChange.effectiveAt, -30));
    await PlanPriceChangeService.runDue({ now: naHora });
    assert.equal(emails.length, 2);
    emails.length = 0;

    // Cancelar pelo console manda o aviso de cancelamento na hora.
    assert.equal((await platform(`/plan-price-changes/${id}/cancel`, { method: 'POST' })).status, 200);
    assert.equal(emails.length, 2);
    const texto = decodificarQuotedPrintable(emails.join('\n'));
    assert.match(texto, /cancelado/);
    const marcas = (await PlanPriceChange.marksOf(id)).filter((m) => m.mark === 'cancel_notice');
    assert.equal(marcas.length, 2);
    assert.ok(marcas.every((m) => m.status === 'done'));
    const trilha = await getDb()('audit_log').where({ tenant_id: beta }).where('detail', 'like', '%plan.price_change_cancel_notified%');
    assert.equal(trilha.length, 1);

    // A passada seguinte não repete.
    emails.length = 0;
    const resumo = await PlanPriceChangeService.runDue({ now: new Date(Date.now() + 60 * 60 * 1000) });
    assert.equal(resumo.canceledNotices, 0);
    assert.equal(emails.length, 0);
  });

  it('cancelado antes do aviso: ninguém ouve nada', async () => {
    await getDb()('tenants').where({ id: alfa }).update({ billing_email: 'financeiro@alfa.test' });
    const r = await agendar(planos.pro.id);
    assert.equal((await platform(`/plan-price-changes/${r.body.data.priceChange.id}/cancel`, { method: 'POST' })).status, 200);
    await PlanPriceChangeService.runDue();
    assert.equal(emails.length, 0);
    assert.deepEqual((await PlanPriceChange.marksOf(r.body.data.priceChange.id)).filter((m) => m.mark === 'cancel_notice'), []);
  });
});

describe('a regra pura', () => {
  it('resolvePrice: agendado vale da data em diante; aplicado vale o de antes antes dele', () => {
    const plano = { id: 1, price_cents: 10000 };
    const agendado = { id: 1, cycle: 'monthly', status: 'scheduled', effective_at: '2027-01-10', old_cents: 10000, new_cents: 12000 };
    assert.equal(PlanPriceChange.resolvePrice([agendado], plano, 'monthly', '2027-01-09'), null);
    assert.equal(PlanPriceChange.resolvePrice([agendado], plano, 'monthly', '2027-01-10'), 12000);
    assert.equal(PlanPriceChange.resolvePrice([agendado], plano, 'annual', '2027-01-10'), null);
    const aplicado = { ...agendado, status: 'applied' };
    assert.equal(PlanPriceChange.resolvePrice([aplicado], plano, 'monthly', '2027-01-09'), 10000);
    assert.equal(PlanPriceChange.resolvePrice([{ ...agendado, status: 'canceled' }], plano, 'monthly', '2027-02-01'), null);
  });

  it('resolvePrice: o aplicado vale o novo dele da data em diante, mesmo com a linha do plano lida antes da aplicação', () => {
    const aplicado = {
      id: 1, cycle: 'monthly', status: 'applied', effective_at: '2027-01-10', old_cents: 10000, new_cents: 12000,
      applied_at: new Date('2027-01-10T15:00:00Z')
    };
    // A emissão leu o plano um instante antes de a aplicação gravar nele.
    const velho = { id: 1, price_cents: 10000, updated_at: new Date('2027-01-01T00:00:00Z') };
    assert.equal(PlanPriceChange.resolvePrice([aplicado], velho, 'monthly', '2027-01-10'), 12000);
    assert.equal(PlanPriceChange.resolvePrice([aplicado], velho, 'monthly', '2027-03-10'), 12000);
    // Antes da data, a regra de sempre: o preço de antes.
    assert.equal(PlanPriceChange.resolvePrice([aplicado], velho, 'monthly', '2027-01-09'), 10000);
    // O plano editado à mão DEPOIS da aplicação: a linha é a que vale.
    const editado = { id: 1, price_cents: 13000, updated_at: new Date('2027-02-01T00:00:00Z') };
    assert.equal(PlanPriceChange.resolvePrice([aplicado], editado, 'monthly', '2027-03-10'), null);
    // Um agendado depois do aplicado, até o vencimento, manda.
    const agendado = { id: 2, cycle: 'monthly', status: 'scheduled', effective_at: '2027-06-10', old_cents: 12000, new_cents: 14000 };
    assert.equal(PlanPriceChange.resolvePrice([aplicado, agendado], velho, 'monthly', '2027-06-10'), 14000);
    assert.equal(PlanPriceChange.resolvePrice([aplicado, agendado], velho, 'monthly', '2027-05-10'), 12000);
  });
});
