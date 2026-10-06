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
const { default: BillingCharge, RETENTION_CANCEL_MARKER } = await import('../src/models/BillingCharge.js');
const {
  default: SubscriptionService, GATE_CODES, overdueSince
} = await import('../src/services/subscriptionService.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const {
  default: CancellationService, addMonths, retentionCouponCode
} = await import('../src/services/cancellationService.js');
const {
  saveProfile, retentionConfig, invalidatePlatformProfile
} = await import('../src/services/platformProfileService.js');
const { default: TenantCredit } = await import('../src/models/TenantCredit.js');
const { default: UsagePeak } = await import('../src/models/UsagePeak.js');
const { retentionCyclesFor } = await import('../src/services/cancellationService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');
const { default: platformReportsRoutes } = await import('../src/routes/platformReports.js');

/**
 * A retenção no cancelamento (0106) cruzada com o plano anual (0103), o
 * excedente (0104) e os créditos de indicação (0105) — as regras que só
 * existem quando as quatro estão juntas:
 *
 *   - a pausa e o cancelamento agendado não emitem nada, e a reserva de
 *     crédito de uma fatura cancelada por eles volta ao saldo;
 *   - o tempo pausado não vira excedente (o pico não é medido na pausa), e o
 *     excedente do período usado antes da pausa vai para a fatura da volta;
 *   - a troca agendada (descida, ciclo anual) espera o fim da pausa;
 *   - no anual, o desconto de retenção vale uma fatura (um ciclo = um ano).
 *
 * (Cabeçalho herdado de cancellation-retention.test.js:)
 * A retenção no cancelamento (0106).
 *
 * O dono pede para cancelar, diz o motivo, e recebe as ofertas: desconto
 * (cupom de retenção, uma vez a cada doze meses) ou pausa (sem cobrança até
 * `paused_until`). Recusando, o cancelamento é agendado para o fim do período
 * pago e o agendador o cumpre na data. O que este arquivo garante, acima de
 * tudo, é o dinheiro: nenhuma fatura sai durante a pausa nem depois do
 * cancelamento agendado, a fatura que já tinha saído é cancelada no gateway
 * ANTES de a decisão ser gravada (e a recusa do gateway não muda nada), e a
 * cobrança volta sozinha no fim da pausa.
 *
 * Self-hosted, pelo motivo de `tenant-self-billing.test.js`: o Asaas de
 * mentira mora no loopback. A porta da assinatura (só SaaS) é conferida pela
 * decisão pura (`SubscriptionService.decide`).
 *
 * As datas são ao segundo: o MySQL guarda ao segundo e ARREDONDA.
 */
const CHAVE = 'chave-da-integracao';
const DIA = 24 * 60 * 60 * 1000;
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const daquiA = (dias) => aoSegundo(Date.now() + dias * DIA);

let gateway;
let recebidas = [];
let proximoId = 0;
let recusarCancelamento = false;
let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let adminToken;
let viewerToken;
let alfa;
let caixa;
let plano;
let outroPlano;

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
      if (req.method === 'POST' && caminho === '/customers') return responder(200, { id: 'cus_alfa' });
      if (req.method === 'POST' && caminho === '/payments') {
        proximoId += 1;
        const id = `pay_ret_${proximoId}`;
        return responder(200, {
          id, status: 'PENDING', value: payload.value, dueDate: payload.dueDate,
          invoiceUrl: `https://gateway.exemplo.test/i/${id}`
        });
      }
      const umaCobranca = /^\/payments\/([^/]+)$/.exec(caminho);
      if (req.method === 'DELETE' && umaCobranca) {
        if (recusarCancelamento) return responder(500, { errors: [{ description: 'cancelamento recusado' }] });
        return responder(200, { deleted: true, id: decodeURIComponent(umaCobranca[1]) });
      }
      if (req.method === 'GET' && umaCobranca) return responder(200, { id: umaCobranca[1], status: 'PENDING' });
      return responder(404, {});
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

/** O roteador do console de verdade, num app mínimo — como em platform-subscriptions.test.js. */
function subirConsole() {
  const app = express();
  app.use(express.json());
  app.use(attachLocale);
  app.use('/api', resolveTenant);
  app.use('/api/platform', platformBillingRoutes);
  app.use('/api/platform', platformReportsRoutes);
  return new Promise((resolve) => {
    consoleServer = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${consoleServer.address().port}`));
  });
}

const pedir = (caminho, { method = 'GET', body, token = donoToken } = {}) => call(`${panelUrl}/api/tenant${caminho}`, {
  method, headers: authHeaders(token), ...(body === undefined ? {} : { body })
});
const plataforma = (caminho, { method = 'GET', token = donoToken } = {}) => call(`${consoleUrl}/api/platform${caminho}`, {
  method, headers: authHeaders(token)
});
const pedirCancelamento = (reason = 'too_expensive', comment = 'caro demais para nós') => pedir(
  '/subscription/cancellation', { method: 'POST', body: { reason, comment } }
);
const aceitar = (offer, months) => pedir('/subscription/cancellation/accept', {
  method: 'POST', body: { offer, ...(months === undefined ? {} : { months }) }
});
const confirmar = () => pedir('/subscription/cancellation/confirm', { method: 'POST' });
const desfazer = () => pedir('/subscription/cancellation', { method: 'DELETE' });

const assinatura = () => Subscription.forTenant(alfa);
const cobrancas = () => getDb()('billing_charges').where({ tenant_id: alfa }).orderBy('id');
const pedidos = () => getDb()('cancellation_requests').where({ tenant_id: alfa }).orderBy('id');
const eventos = (tipo) => getDb()('billing_events').where({ tenant_id: alfa, type: tipo }).orderBy('id');
const criados = () => recebidas.filter((r) => r.method === 'POST' && r.path === '/payments');
const cancelados = () => recebidas.filter((r) => r.method === 'DELETE');
const emitir = (opcoes = {}) => runInTenant(alfa, () => ChargeIssuingService.issueCurrent(opcoes));
const cumprir = (now) => runInTenant(alfa, () => CancellationService.processDue({ now }));

async function assinar(patch = {}) {
  await Subscription.upsertForTenant(alfa, {
    plan_id: plano.id, status: 'active', renews_at: daquiA(2), trial_ends_at: null, canceled_at: null,
    pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null, upgraded_at: null,
    coupon_id: null, coupon_cycles_left: null, coupon_applied_at: null, billing_exempt_at: null,
    suspended_reason: null, cancel_at: null, paused_until: null, pause_started_at: null, proration_due_at: null,
    billing_cycle: 'monthly', pending_billing_cycle: null,
    ...patch
  });
  await SubscriptionService.invalidate(alfa);
}

/** Uma cobrança de renovação já emitida no gateway para o prazo vivo. */
async function cobrancaEmitida({ gatewayChargeId = 'pay_existente', amountCents = 10000 } = {}) {
  const sub = await assinatura();
  const prazo = new Date(sub.renews_at ?? sub.trial_ends_at);
  return runInTenant(alfa, async () => {
    const id = await BillingCharge.open({
      periodEnd: ChargeIssuingService.periodKey(prazo),
      amountCents,
      currency: 'BRL',
      provider: 'asaas',
      dueDate: ChargeIssuingService.isoDate(prazo)
    });
    await BillingCharge.update(id, {
      gateway_charge_id: gatewayChargeId, invoice_url: `https://gateway.exemplo.test/i/${gatewayChargeId}`
    });
    return id;
  });
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  ({ panelUrl } = await startTestServers());
  consoleUrl = await subirConsole();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });

  for (const [username, role] of [['o-admin', 'admin'], ['so-olha', 'viewer']]) {
    // eslint-disable-next-line no-await-in-loop
    const criado = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(donoToken),
      body: { username, password: `senha-de-${username}-1`, role, email: `${username}@exemplo.test` }
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
  }
  const entrar = async (username) => (await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username, password: `senha-de-${username}-1` }
  })).body?.data?.token;
  adminToken = await entrar('o-admin');
  viewerToken = await entrar('so-olha');
  assert.ok(adminToken && viewerToken);

  const db = getDb();
  alfa = (await db('tenants').where({ kind: 'provider' }).orderBy('id', 'asc').first()).id;
  caixa = (await db('tenants').where({ kind: 'platform' }).first())?.id;
  if (!caixa) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
    caixa = (await db('tenants').where({ kind: 'platform' }).first()).id;
  }
  resetDeploymentSharing();
  plano = await Plan.create({
    code: 'int-pro', name: 'Pro', price_cents: 10000, price_yearly_cents: 100000, currency: 'BRL', period_days: 30, trial_days: 0, active: true,
    max_devices: 10, overage_price_cents_devices: 100
  });
  outroPlano = await Plan.create({
    code: 'int-max', name: 'Max', price_cents: 20000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  await new Promise((r) => consoleServer.close(r));
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  recebidas = [];
  recusarCancelamento = false;
  const db = getDb();
  await db('billing_charges').where({ tenant_id: alfa }).del();
  await db('billing_events').where({ tenant_id: alfa }).del();
  await db('cancellation_requests').where({ tenant_id: alfa }).del();
  await db('credit_allocations').where({ tenant_id: alfa }).del();
  await db('tenant_credits').where({ tenant_id: alfa }).del();
  await db('usage_peaks').where({ tenant_id: alfa }).del();
  await db('coupons').where('code', 'like', 'RETENCAO-%').del();
  await db('subscription_reminder_sends').where({ tenant_id: alfa }).del();
  await db('platform_audit').del();
  await db('tenants').where({ id: alfa }).update({
    billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa', billing_tax_id: '12345678000195',
    billing_legal_name: 'Alfa Telecom Ltda', billing_email: 'financeiro@alfa.test'
  });
  await assinar();
});


const saldo = () => runInTenant(alfa, () => TenantCredit.balance());
const darCredito = (cents) => runInTenant(alfa, () => TenantCredit.add({ amountCents: cents, source: 'manual' }));
const medir = (devices, now) => runInTenant(alfa, () => SubscriptionService.recordUsagePeaks({
  countDevices: async () => devices, now
}));
const picos = (renova) => runInTenant(alfa, () => UsagePeak.forPeriod(ChargeIssuingService.periodKey(renova)));
const alocacoes = (chargeId) => getDb()('credit_allocations').where({ tenant_id: alfa, charge_id: chargeId });

describe('o crédito (0105) e a retenção', () => {
  it('a pausa cancela a renovação com crédito reservado, e a reserva volta ao saldo', async () => {
    await darCredito(3000);
    const emissao = await emitir();
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(emissao.creditCents, 3000);
    assert.equal(await saldo(), 0);

    await pedirCancelamento('temporary');
    const aceito = await aceitar('pause', 1);
    assert.equal(aceito.status, 200, JSON.stringify(aceito.body));
    const linha = (await cobrancas())[0];
    assert.equal(linha.status, 'canceled');
    assert.equal(linha.last_error, RETENTION_CANCEL_MARKER);
    assert.equal(linha.credit_reserved_cents, null);
    assert.deepEqual((await alocacoes(linha.id)).map((a) => a.status), ['released']);
    assert.equal(await saldo(), 3000, 'o crédito volta inteiro');
  });

  it('o cancelamento agendado também solta a reserva, e nada mais é emitido nem reservado', async () => {
    await darCredito(2000);
    assert.equal((await emitir()).issued, true);
    assert.equal(await saldo(), 0);
    await pedirCancelamento('too_expensive');
    const r = await confirmar();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await cobrancas())[0].status, 'canceled');
    assert.equal(await saldo(), 2000);

    recebidas = [];
    const denovo = await emitir({ manual: true });
    assert.equal(denovo.reason, 'cancel_scheduled');
    assert.equal(criados().length, 0);
    assert.equal(await saldo(), 2000, 'a fatura que não sai não reserva');
  });

  it('desfeito o agendamento, a fatura reaberta reserva de novo pelo preço cheio', async () => {
    await darCredito(2000);
    assert.equal((await emitir()).issued, true);
    await pedirCancelamento('too_expensive');
    await confirmar();
    assert.equal(await saldo(), 2000);
    assert.equal((await desfazer()).status, 200);
    const emissao = await emitir();
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(emissao.creditCents, 2000);
    const linha = (await cobrancas())[0];
    assert.equal(Number(linha.amount_cents), 8000);
    assert.equal(BillingCharge.baseAmountOf(linha), 10000);
    assert.equal(await saldo(), 0);
  });

  it('a linha reservada que não vai ao gateway devolve a reserva e o preço sem crédito', async () => {
    await darCredito(1500);
    const id = await runInTenant(alfa, () => BillingCharge.open({
      periodEnd: '2099-01-01', amountCents: 10000, currency: 'BRL', provider: 'asaas', dueDate: '2099-01-01'
    }));
    const reserva = await runInTenant(alfa, () => TenantCredit.reserveForCharge(id, 10000));
    assert.equal(reserva.reservedCents, 1500);
    assert.equal(await saldo(), 0);
    await runInTenant(alfa, () => ChargeIssuingService.soltarCreditoNaoEmitido(id, reserva.reservedCents, 10000));
    const linha = await runInTenant(alfa, () => BillingCharge.findById(id));
    assert.equal(Number(linha.amount_cents), 10000);
    assert.equal(linha.credit_reserved_cents, null);
    assert.equal(await saldo(), 1500);
  });
});

describe('o excedente (0104) e a pausa', () => {
  it('o tempo pausado não vira excedente; o do período usado vai para a fatura da volta', async () => {
    const renova = daquiA(2);
    await assinar({ renews_at: renova });
    // O período pago: 13 ONTs num plano de 10 — 3 acima, R$ 1,00 cada.
    assert.equal((await medir(13, new Date())).recorded, true);
    assert.equal((await picos(renova)).devices, 13);

    await pedirCancelamento('temporary');
    assert.equal((await aceitar('pause', 1)).status, 200);
    const ate = aoSegundo(addMonths(renova, 1).getTime());

    // Antes da pausa começar, o período pago ainda conta.
    assert.equal((await medir(14, new Date())).recorded, true);
    // Na pausa, nada se mede — nem um pico maior.
    const durante = new Date(renova.getTime() + 5 * DIA);
    const r = await medir(50, durante);
    assert.deepEqual(r, { recorded: false, reason: 'paused' });
    assert.equal((await picos(renova)).devices, 14);

    // A volta leva os picos do período usado para a chave nova.
    const fim = new Date(ate.getTime() + 60 * 1000);
    assert.equal((await cumprir(fim)).action, 'resumed');
    assert.equal((await picos(ate)).devices, 14);
    recebidas = [];
    const emissao = await emitir({ now: fim });
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(criados().length, 1);
    assert.equal(criados()[0].payload.value, 104, 'R$ 100 do plano + 4 ONTs acima × R$ 1');
    // Rodar a volta de novo não soma nada.
    await runInTenant(alfa, () => CancellationService.levarPicosDaPausa(renova, ate));
    assert.equal((await picos(ate)).devices, 14);
  });

  it('o cancelamento agendado continua medindo: desfeito, a renovação cobra o período usado', async () => {
    await pedirCancelamento('too_expensive');
    await confirmar();
    assert.equal((await medir(12, new Date())).recorded, true);
    assert.equal((await desfazer()).status, 200);
    recebidas = [];
    const emissao = await emitir();
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(criados()[0].payload.value, 102);
  });
});

describe('o plano anual (0103) e a retenção', () => {
  it('a troca agendada espera o fim da pausa, e se aplica na volta', async () => {
    const renova = daquiA(2);
    await assinar({ renews_at: renova });
    await pedirCancelamento('temporary');
    assert.equal((await aceitar('pause', 1)).status, 200);
    // Uma descida que já estava agendada para a renovação (antes do pedido).
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({
      pending_plan_id: outroPlano.id, pending_plan_at: renova, pending_billing_cycle: 'monthly'
    });
    await SubscriptionService.invalidate(alfa);
    const ate = aoSegundo(addMonths(renova, 1).getTime());
    const durante = new Date(renova.getTime() + 3 * DIA);
    const aplicar = (now) => runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now, countDevices: async () => 0 }));
    assert.deepEqual(await aplicar(durante), { applied: false, reason: 'paused' });
    assert.equal(Number((await assinatura()).plan_id), Number(plano.id));

    const fim = new Date(ate.getTime() + 60 * 1000);
    assert.equal((await cumprir(fim)).action, 'resumed');
    const depois = await aplicar(fim);
    assert.equal(depois.applied, true, JSON.stringify(depois));
    assert.equal(Number((await assinatura()).plan_id), Number(outroPlano.id));
  });

  it('no anual, o desconto de retenção vale uma fatura — a anual seguinte', async () => {
    await assinar({ billing_cycle: 'annual', renews_at: daquiA(30) });
    const pedido = await pedirCancelamento('too_expensive');
    assert.equal(pedido.status, 201, JSON.stringify(pedido.body));
    const desconto = pedido.body.data.offers.discount;
    assert.equal(desconto.available, true, JSON.stringify(desconto));
    assert.equal(desconto.billingCycle, 'annual');
    assert.equal(desconto.months, 1);
    assert.equal(desconto.priceCents, 80000, '20% sobre a fatura anual de R$ 1.000');

    const aceito = await aceitar('discount');
    assert.equal(aceito.status, 200, JSON.stringify(aceito.body));
    assert.equal(aceito.body.data.coupon.months, 1);
    const cupom = await Coupon.findByCode(retentionCouponCode(20, 1));
    assert.equal(cupom.duration, 'repeating');
    assert.equal(Number(cupom.duration_cycles), 1);
    const sub = await assinatura();
    assert.equal(Number(sub.coupon_cycles_left), 1);
    assert.equal(Number((await pedidos())[0].months), 1);
  });

  it('no mensal, continua a configuração (3 faturas)', async () => {
    const pedido = await pedirCancelamento('too_expensive');
    const desconto = pedido.body.data.offers.discount;
    assert.equal(desconto.billingCycle, 'monthly');
    assert.equal(desconto.months, 3);
    assert.equal(desconto.priceCents, 8000);
    assert.equal(retentionCyclesFor({ billing_cycle: 'annual' }, plano, 3), 1);
    assert.equal(retentionCyclesFor({ billing_cycle: 'annual' }, plano, 0), 0);
    assert.equal(retentionCyclesFor({ billing_cycle: 'monthly' }, plano, 5), 5);
    // Plano sem anual: o ciclo é o mensal, sempre.
    assert.equal(retentionCyclesFor({ billing_cycle: 'annual' }, outroPlano, 3), 3);
  });
});
