import crypto from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: AffiliateService, addMonths, normalizeAffiliateCode, commissionCents } = await import('../src/services/affiliateService.js');
const { default: AffiliatePayoutService, previousPeriod, periodEnd } = await import('../src/services/affiliatePayoutService.js');
const { saveProfile, invalidatePlatformProfile } = await import('../src/services/platformProfileService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformAffiliatesRoutes } = await import('../src/routes/platformAffiliates.js');
const { default: affiliatePortalRoutes } = await import('../src/routes/affiliatePortal.js');
const { DEVELOPMENT_FALLBACK } = await import('../src/config/runtimeEnv.js');

/**
 * O programa de afiliados (0125) — o dinheiro. O cadastro com `?aff=` está em
 * `affiliates-signup.test.js`, que precisa do SaaS.
 *
 * A montagem de `referrals.test.js`: o roteador do console e o do portal de
 * verdade num app mínimo, o painel para o webhook, e um Asaas de mentira em
 * `127.0.0.1` com `/transfers`. Os indicados são criados direto na tabela,
 * com `referred_by_affiliate_id` e `referred_at`, como o cadastro grava.
 *
 * O que não pode dar errado, em dinheiro:
 *
 * 1. **A comissão fora da janela**, ou na taxa errada.
 * 2. **A comissão duas vezes** — o webhook reentrega.
 * 3. **O estorno que não desfaz** — nem a comissão livre, nem a do lote.
 * 4. **O lote duas vezes**, ou o Pix sem aprovação, ou o Pix duas vezes.
 * 5. **A falha do gateway que corrompe o lote**, ou que se reenvia às cegas.
 * 6. **Um afiliado vendo o outro**, ou o token do painel valendo no portal.
 *
 * As datas são gravadas ao segundo: o MySQL guarda ao segundo.
 */
const CHAVE = 'chave-dos-afiliados';
const TOKEN_WEBHOOK = 'token-do-webhook-dos-afiliados';
const DAY = 24 * 60 * 60 * 1000;

let gateway;
let recebidas = [];
let respostaDaTransferencia = null;
let atrasoDaTransferencia = 0;
let proximaTransferencia = 0;
let panelUrl;
let appServer;
let appUrl;
let donoToken;
let plano;
let sequencia = 0;

const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const daquiA = (dias) => aoSegundo(Date.now() + dias * DAY);

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', async () => {
      let payload = null;
      try { payload = bruto ? JSON.parse(bruto) : null; } catch { payload = null; }
      const caminho = req.url.split('?')[0];
      recebidas.push({ method: req.method, path: caminho, payload, idem: req.headers['idempotency-key'] ?? null });
      const responder = (status, corpo) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (req.headers.access_token !== CHAVE) return responder(401, {});
      if (req.method === 'POST' && caminho === '/transfers') {
        if (atrasoDaTransferencia) await new Promise((r) => { setTimeout(r, atrasoDaTransferencia); });
        if (respostaDaTransferencia) {
          const [status, corpo] = respostaDaTransferencia;
          return responder(status, corpo);
        }
        proximaTransferencia += 1;
        return responder(200, {
          id: `tra_${proximaTransferencia}`, value: payload?.value, status: 'PENDING', operationType: 'PIX'
        });
      }
      const uma = /^\/transfers\/([^/]+)$/.exec(caminho);
      if (req.method === 'GET' && uma) return responder(200, { id: uma[1], status: 'DONE', value: 1 });
      return responder(404, {});
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(attachLocale);
  app.use('/api', resolveTenant);
  app.use('/api/platform', platformAffiliatesRoutes);
  app.use('/api/affiliate', affiliatePortalRoutes);
  return new Promise((resolve) => {
    appServer = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${appServer.address().port}`));
  });
}

const noConsole = (caminho, { method = 'GET', body } = {}) => call(`${appUrl}${caminho}`, {
  method, headers: authHeaders(donoToken), ...(body === undefined ? {} : { body })
});
const noPortal = (caminho, { method = 'GET', body, cookie = null, headers = {} } = {}) => call(`${appUrl}/api/affiliate${caminho}`, {
  method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body })
});
const entregar = (corpo) => call(`${panelUrl}/api/billing-webhook`, {
  method: 'POST', headers: { 'asaas-access-token': TOKEN_WEBHOOK }, body: corpo
});
const pagar = (tenantId, opcoes) => runInTenant(tenantId, () => SubscriptionService.recordPayment({ currency: 'BRL', provider: 'asaas', ...opcoes }));
const estornar = (tenantId, externalId) => runInTenant(tenantId, () => SubscriptionService.reversePayment({ externalId }));
const comissoesDe = (affiliateId) => getDb()('affiliate_commissions').where({ affiliate_id: affiliateId }).orderBy('id');
const lotesDe = (affiliateId) => getDb()('affiliate_payouts').where({ affiliate_id: affiliateId }).orderBy('id');
const transferencias = () => recebidas.filter((r) => r.method === 'POST' && r.path === '/transfers');

async function configurar({ rateBp = 1000, months = 12, minCents = 5000 } = {}) {
  await saveProfile({ affiliateRateBp: rateBp, affiliateMonths: months, affiliatePayoutMinCents: minCents });
  invalidatePlatformProfile();
}

async function afiliado(extra = {}) {
  sequencia += 1;
  return AffiliateService.create({
    name: `Afiliado ${sequencia}`,
    email: `afiliado${sequencia}@afiliados.test`,
    pixKey: `afiliado${sequencia}@pix.test`,
    pixKeyType: 'EMAIL',
    status: 'active',
    ...extra
  });
}

async function assinar(tenantId, renewsAt = daquiA(2)) {
  await Subscription.upsertForTenant(tenantId, {
    plan_id: plano.id,
    status: 'active',
    renews_at: renewsAt,
    trial_ends_at: null,
    canceled_at: null,
    pending_plan_id: null,
    pending_plan_at: null,
    pending_plan_locked_at: null,
    upgraded_at: null,
    billing_exempt_at: null,
    suspended_reason: null,
    proration_due_at: null,
    coupon_id: null,
    coupon_cycles_left: null,
    coupon_applied_at: null
  });
  SubscriptionService.invalidate(tenantId);
}

/** Um provedor indicado por um afiliado, há `diasAtras` dias. */
async function indicado(affiliateId, { diasAtras = 10 } = {}) {
  sequencia += 1;
  const slug = `aff${sequencia}`;
  const db = getDb();
  await db('tenants').insert({
    slug,
    name: `Provedor Indicado ${sequencia}`,
    status: 'active',
    kind: 'provider',
    billing_gateway: 'asaas',
    billing_customer_ref: `cus_${slug}`,
    referred_by_affiliate_id: affiliateId,
    referred_at: daquiA(-diasAtras)
  });
  const id = (await db('tenants').where({ slug }).first()).id;
  await assinar(id);
  return id;
}

/** Um afiliado com senha definida pelo link, e o cookie da sessão dele. */
async function entrarComo(af, senha = 'senha-do-afiliado-1') {
  const { token } = await AffiliateService.issuePasswordLink(af.id);
  const definida = await noPortal('/password', { method: 'POST', body: { token, password: senha } });
  assert.equal(definida.status, 200, JSON.stringify(definida.body));
  const login = await noPortal('/login', { method: 'POST', body: { email: af.email, password: senha } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const cookie = login.response.headers.get('set-cookie');
  assert.match(cookie, /skygp_affiliate_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  return cookie.split(';')[0];
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  process.env.BILLING_WEBHOOK_TOKEN = TOKEN_WEBHOOK;
  ({ panelUrl } = await startTestServers());
  appUrl = await subirApp();
  const db = getDb();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-dos-afiliados', password: 'senha-da-casa-1', email: 'dona@afiliados.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  donoToken = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  if (!(await db('tenants').where({ kind: 'platform' }).first())) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  }
  plano = await Plan.create({
    code: 'aff-pro', name: 'Pro', price_cents: 20000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  delete process.env.BILLING_WEBHOOK_TOKEN;
  await new Promise((r) => appServer.close(r));
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  recebidas = [];
  respostaDaTransferencia = null;
  atrasoDaTransferencia = 0;
  resetDeploymentSharing();
  await configurar();
});

describe('as peças puras', () => {
  it('normaliza o código com o prefixo, e só ele', () => {
    assert.equal(normalizeAffiliateCode(' a-ab12cd '), 'A-AB12CD');
    assert.equal(normalizeAffiliateCode('ab12cd'), 'A-AB12CD');
    assert.equal(normalizeAffiliateCode('x'), null);
  });

  it('soma meses no calendário, sem dias de brinde no fim do mês', () => {
    assert.equal(addMonths(new Date('2026-01-31T12:00:00Z'), 1).toISOString(), '2026-02-28T12:00:00.000Z');
    assert.equal(addMonths(new Date('2026-03-15T00:00:00Z'), 12).toISOString(), '2027-03-15T00:00:00.000Z');
  });

  it('a comissão é o piso, em centavos', () => {
    assert.equal(commissionCents(19999, 1000), 1999);
    assert.equal(commissionCents(0, 1000), 0);
    assert.equal(commissionCents(10000, 0), 0);
  });

  it('o período anterior e o fim dele, no fuso de Brasília', () => {
    // 01/03 às 02h em Brasília ainda é março lá; às 01h UTC do dia 1 ainda é fevereiro.
    assert.equal(previousPeriod(new Date('2026-03-01T05:00:00Z')), '2026-02');
    assert.equal(previousPeriod(new Date('2026-03-01T01:00:00Z')), '2026-01');
    assert.equal(previousPeriod(new Date('2026-01-10T12:00:00Z')), '2025-12');
    assert.equal(periodEnd('2026-02').toISOString(), '2026-03-01T03:00:00.000Z');
  });
});

describe('a comissão', () => {
  it('nasce em cada pagamento dentro dos 12 meses, na taxa padrão', async () => {
    const af = await afiliado();
    const id = await indicado(af.id, { diasAtras: 30 });
    await pagar(id, { amountCents: 20000, externalId: `pay_a_${id}` });
    await pagar(id, { amountCents: 20000, externalId: `pay_b_${id}` });
    const linhas = await comissoesDe(af.id);
    assert.equal(linhas.length, 2);
    for (const linha of linhas) {
      assert.equal(Number(linha.amount_cents), 2000);
      assert.equal(Number(linha.rate_bp), 1000);
      assert.equal(linha.status, 'accrued');
      assert.equal(Number(linha.tenant_id), Number(id));
    }
    const evento = await getDb()('billing_events').where({ tenant_id: id, external_id: `pay_a_${id}` }).first();
    assert.equal(JSON.parse(evento.detail).affiliateCommission.amountCents, 2000);
  });

  it('não nasce depois da janela; para o afiliado suspenso, fica guardada (`held`)', async () => {
    const af = await afiliado();
    const velho = await indicado(af.id, { diasAtras: 400 });
    await pagar(velho, { amountCents: 20000, externalId: `pay_velho_${velho}` });
    assert.equal((await comissoesDe(af.id)).length, 0);

    const suspenso = await afiliado();
    const id = await indicado(suspenso.id, { diasAtras: 5 });
    await AffiliateService.setStatus(suspenso.id, 'suspended');
    await pagar(id, { amountCents: 20000, externalId: `pay_susp_${id}` });
    const [guardada] = await comissoesDe(suspenso.id);
    assert.equal(guardada.status, 'held');
    assert.equal(Number(guardada.amount_cents), 2000);

    // Guardada não entra em lote.
    const futuro = new Date(Date.now() + 40 * DAY);
    await AffiliatePayoutService.buildBatches({ period: previousPeriod(futuro), now: futuro });
    assert.equal((await lotesDe(suspenso.id)).length, 0);
    const totais = (await AffiliateService.totalsByAffiliate([suspenso.id])).get(Number(suspenso.id));
    assert.equal(totais.heldCents, 2000);

    // Reativado dentro da janela: volta a `accrued`, com a data de origem.
    const reativado = await AffiliateService.setStatus(suspenso.id, 'active');
    assert.deepEqual(reativado.released, { released: 1, forfeited: 0 });
    const [liberada] = await comissoesDe(suspenso.id);
    assert.equal(liberada.status, 'accrued');
    assert.equal(new Date(liberada.accrued_at).getTime(), new Date(guardada.accrued_at).getTime());
  });

  it('a guardada de janela vencida na reativação é perdida; o estorno desfaz a guardada', async () => {
    const af = await afiliado({ months: 1 });
    const id = await indicado(af.id, { diasAtras: 20 });
    await AffiliateService.setStatus(af.id, 'suspended');
    await pagar(id, { amountCents: 20000, externalId: `pay_held_a_${id}` });
    await pagar(id, { amountCents: 20000, externalId: `pay_held_b_${id}` });
    await estornar(id, `pay_held_b_${id}`);
    const linhas = await comissoesDe(af.id);
    assert.deepEqual(linhas.map((l) => l.status), ['held', 'reversed']);
    // A reativação vem 15 dias depois: a janela de 1 mês já fechou.
    const depois = new Date(Date.now() + 15 * DAY);
    const r = await AffiliateService.setStatus(af.id, 'active', { now: depois });
    assert.deepEqual(r.released, { released: 0, forfeited: 1 });
    assert.equal((await comissoesDe(af.id))[0].status, 'reversed');
  });

  it('respeita a taxa e a janela do próprio afiliado', async () => {
    const af = await afiliado({ rateBp: 2500, months: 1 });
    const dentro = await indicado(af.id, { diasAtras: 10 });
    await pagar(dentro, { amountCents: 20000, externalId: `pay_dentro_${dentro}` });
    const fora = await indicado(af.id, { diasAtras: 40 });
    await pagar(fora, { amountCents: 20000, externalId: `pay_fora_${fora}` });
    const linhas = await comissoesDe(af.id);
    assert.equal(linhas.length, 1);
    assert.equal(Number(linhas[0].amount_cents), 5000);
    assert.equal(Number(linhas[0].tenant_id), Number(dentro));
    // E a janela global configurada vale para quem não tem a própria.
    await configurar({ months: 1 });
    const outro = await afiliado();
    const longe = await indicado(outro.id, { diasAtras: 40 });
    await pagar(longe, { amountCents: 20000, externalId: `pay_longe_${longe}` });
    assert.equal((await comissoesDe(outro.id)).length, 0);
  });

  it('uma vez só quando o webhook reentrega o mesmo pagamento', async () => {
    const af = await afiliado();
    const id = await indicado(af.id);
    const corpo = {
      event: 'PAYMENT_RECEIVED',
      payment: { id: `pay_dup_${id}`, value: 200, customer: `cus_aff`, externalReference: `tenant:${id}` }
    };
    const [um, dois] = await Promise.all([entregar(corpo), entregar(corpo)]);
    assert.equal(um.status, 200, JSON.stringify(um.body));
    assert.equal(dois.status, 200, JSON.stringify(dois.body));
    const tres = await entregar(corpo);
    assert.equal(tres.status, 200);
    const linhas = await comissoesDe(af.id);
    assert.equal(linhas.length, 1);
    assert.equal(Number(linhas[0].amount_cents), 2000);
  });
});

describe('o estorno', () => {
  it('desfaz a comissão livre, e o segundo estorno não faz nada', async () => {
    const af = await afiliado();
    const id = await indicado(af.id);
    await pagar(id, { amountCents: 20000, externalId: `pay_est_${id}` });
    await estornar(id, `pay_est_${id}`);
    await estornar(id, `pay_est_${id}`);
    const linhas = await comissoesDe(af.id);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].status, 'reversed');
  });

  it('tira do lote em rascunho, e abate do próximo a que já está num lote aprovado', async () => {
    const af = await afiliado();
    const id = await indicado(af.id, { diasAtras: 60 });
    await pagar(id, { amountCents: 50000, externalId: `pay_r1_${id}` });
    await pagar(id, { amountCents: 50000, externalId: `pay_r2_${id}` });
    await pagar(id, { amountCents: 50000, externalId: `pay_r3_${id}` });
    const futuro = new Date(Date.now() + 40 * DAY);
    await AffiliatePayoutService.buildBatches({ period: previousPeriod(futuro), now: futuro });
    assert.equal((await lotesDe(af.id)).length, 1);
    const [lote] = await lotesDe(af.id);
    assert.equal(Number(lote.amount_cents), 15000);

    // No rascunho: sai do lote, que é recalculado.
    await estornar(id, `pay_r1_${id}`);
    let depois = await AffiliatePayoutService.findById(lote.id);
    assert.equal(Number(depois.amount_cents), 10000);
    assert.equal(Number(depois.commission_count), 2);

    // Aprovado: o lote não muda por baixo de quem aprovou; nasce o abatimento.
    await AffiliatePayoutService.approve(lote.id);
    await estornar(id, `pay_r2_${id}`);
    depois = await AffiliatePayoutService.findById(lote.id);
    assert.equal(Number(depois.amount_cents), 10000);
    const linhas = await comissoesDe(af.id);
    const abatimento = linhas.find((l) => l.kind === 'clawback');
    assert.ok(abatimento);
    assert.equal(Number(abatimento.amount_cents), -5000);
    assert.equal(abatimento.status, 'accrued');
    assert.equal(abatimento.payment_ref, `pay_r2_${id}:refund`);
  });

  it('a aprovação recalcula o total pelas comissões do lote', async () => {
    const { af, lote } = await comLote();
    // Um total que não bate (o de um estorno que correu pela metade).
    await getDb()('affiliate_payouts').where({ id: lote.id }).update({ amount_cents: 999999, commission_count: 7 });
    const aprovado = await AffiliatePayoutService.approve(lote.id);
    const soma = (await comissoesDe(af.id)).filter((c) => c.status === 'in_payout')
      .reduce((t, c) => t + Number(c.amount_cents), 0);
    assert.equal(Number(aprovado.amount_cents), soma);
    assert.equal(Number(aprovado.commission_count), 1);
  });

  for (const ordem of ['estorno antes', 'aprovação antes']) {
    it(`estorno e aprovação ao mesmo tempo (${ordem}): o aprovado é a soma do que está nele`, async () => {
      const af = await afiliado();
      const id = await indicado(af.id, { diasAtras: 60 });
      await pagar(id, { amountCents: 50000, externalId: `pay_c1_${id}` });
      await pagar(id, { amountCents: 50000, externalId: `pay_c2_${id}` });
      const futuro = new Date(Date.now() + 40 * DAY);
      await AffiliatePayoutService.buildBatches({ period: previousPeriod(futuro), now: futuro });
      const [lote] = await lotesDe(af.id);
      const passos = [
        () => estornar(id, `pay_c1_${id}`),
        () => AffiliatePayoutService.approve(lote.id)
      ];
      if (ordem === 'aprovação antes') passos.reverse();
      await Promise.all(passos.map((passo) => passo()));

      const depois = await AffiliatePayoutService.findById(lote.id);
      assert.equal(depois.status, 'approved');
      const linhas = await comissoesDe(af.id);
      const noLote = linhas.filter((c) => Number(c.payout_id) === Number(lote.id) && c.status === 'in_payout');
      assert.equal(Number(depois.amount_cents), noLote.reduce((t, c) => t + Number(c.amount_cents), 0));
      assert.equal(Number(depois.commission_count), noLote.length);
      // O estornado ou saiu do lote, ou virou abatimento — nunca os dois, nunca nenhum.
      const saiu = linhas.some((c) => c.payment_ref === `pay_c1_${id}` && c.status === 'reversed');
      const abatido = linhas.some((c) => c.kind === 'clawback');
      assert.equal(saiu !== abatido, true, JSON.stringify(linhas.map((c) => [c.kind, c.status, c.payout_id])));
      assert.equal(Number(depois.amount_cents), saiu ? 5000 : 10000);
    });
  }
});

describe('o lote mensal', () => {
  it('é montado uma vez só, e o saldo abaixo do mínimo fica para o mês seguinte', async () => {
    await configurar({ minCents: 5000 });
    const pouco = await afiliado();
    const idPouco = await indicado(pouco.id);
    await pagar(idPouco, { amountCents: 20000, externalId: `pay_pouco_${idPouco}` }); // R$ 20 < R$ 50
    const muito = await afiliado();
    const idMuito = await indicado(muito.id);
    await pagar(idMuito, { amountCents: 60000, externalId: `pay_muito_${idMuito}` }); // R$ 60

    const futuro = new Date(Date.now() + 40 * DAY);
    const periodo = previousPeriod(futuro);
    const [a, b] = await Promise.all([
      AffiliatePayoutService.buildBatches({ period: periodo, now: futuro }),
      AffiliatePayoutService.buildBatches({ period: periodo, now: futuro })
    ]);
    assert.equal((await lotesDe(muito.id)).length, 1);
    assert.equal((await lotesDe(pouco.id)).length, 0);
    assert.ok(a.carried.includes(Number(pouco.id)) || b.carried.includes(Number(pouco.id)));
    const terceira = await AffiliatePayoutService.buildBatches({ period: periodo, now: futuro });
    assert.deepEqual(terceira.created, []);

    // O mês seguinte: o saldo que ficou soma com o novo e passa do mínimo.
    await pagar(idPouco, { amountCents: 40000, externalId: `pay_pouco2_${idPouco}` });
    const depois = new Date(futuro.getTime() + 35 * DAY);
    await AffiliatePayoutService.buildBatches({ period: previousPeriod(depois), now: depois });
    const [lote] = await lotesDe(pouco.id);
    assert.equal(Number(lote.amount_cents), 6000);
    assert.equal(Number(lote.commission_count), 2);
    assert.equal(lote.status, 'draft');
  });

  it('recusa montar um período que não acabou', async () => {
    const r = await noConsole('/api/platform/affiliate-payouts/build', { method: 'POST', body: { period: '2999-01' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'period_open');
  });
});

/** Um afiliado com um lote em rascunho de `cents`. */
async function comLote(cents = 10000, extra = {}) {
  const af = await afiliado(extra);
  const id = await indicado(af.id);
  await pagar(id, { amountCents: cents * 10, externalId: `pay_lote_${id}` });
  const futuro = new Date(Date.now() + 40 * DAY);
  await AffiliatePayoutService.buildBatches({ period: previousPeriod(futuro), now: futuro });
  const [lote] = await lotesDe(af.id);
  assert.ok(lote, 'o lote não foi montado');
  return { af, lote };
}

describe('o Pix do lote', () => {
  it('não sai sem aprovação', async () => {
    const { lote } = await comLote();
    const r = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'not_approved');
    assert.equal(transferencias().length, 0);
    assert.equal((await AffiliatePayoutService.findById(lote.id)).status, 'draft');
  });

  it('sai uma vez só no clique duplo, com a chave idempotente do lote, e a trilha registra', async () => {
    const { af, lote } = await comLote();
    const aprovado = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/approve`, { method: 'POST', body: {} });
    assert.equal(aprovado.status, 200, JSON.stringify(aprovado.body));
    atrasoDaTransferencia = 150;
    const [um, dois] = await Promise.all([
      noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} }),
      noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} })
    ]);
    const statuses = [um.status, dois.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(transferencias().length, 1);
    const [pedido] = transferencias();
    assert.equal(pedido.payload.value, 100);
    assert.equal(pedido.payload.pixAddressKeyType, 'EMAIL');
    assert.equal(pedido.payload.pixAddressKey, af.email.replace('@afiliados.test', '@pix.test'));
    const depois = await AffiliatePayoutService.findById(lote.id);
    assert.equal(depois.status, 'sent');
    assert.equal(pedido.idem, depois.idempotency_key);
    assert.equal(pedido.payload.externalReference, depois.idempotency_key);

    // O terceiro clique, depois de enviado, também não manda nada.
    const tres = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} });
    assert.equal(tres.status, 409);
    assert.equal(transferencias().length, 1);

    // O webhook da transferência fecha o lote e as comissões.
    const entrega = await entregar({ event: 'TRANSFER_DONE', transfer: { id: depois.transfer_id, status: 'DONE' } });
    assert.equal(entrega.status, 200);
    assert.equal(entrega.body.code, 'transfer_applied');
    assert.equal((await AffiliatePayoutService.findById(lote.id)).status, 'paid');
    assert.ok((await comissoesDe(af.id)).every((c) => c.status === 'paid'));

    const trilha = (await getDb()('platform_audit').where('action', 'like', 'affiliate.payout_%')).map((l) => l.action);
    assert.ok(trilha.includes('affiliate.payout_approved'));
    assert.ok(trilha.includes('affiliate.payout_sent'));
  });

  it('a recusa do gateway deixa o lote falho e reenviável, sem perder nada', async () => {
    const { lote } = await comLote();
    await AffiliatePayoutService.approve(lote.id);
    respostaDaTransferencia = [400, { errors: [{ code: 'invalid_action', description: 'Saldo insuficiente' }] }];
    const r = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.payout.status, 'failed');
    assert.equal(r.body.data.payout.errorCode, 'refused');
    const chave = (await AffiliatePayoutService.findById(lote.id)).idempotency_key;
    assert.ok((await comissoesDe(lote.affiliate_id)).every((c) => c.status === 'in_payout'));

    respostaDaTransferencia = null;
    const de_novo = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} });
    assert.equal(de_novo.status, 200, JSON.stringify(de_novo.body));
    assert.equal(de_novo.body.data.payout.status, 'sent');
    assert.equal(transferencias().length, 2);
    // A recusa 4xx pode estar guardada no gateway com a chave: o reenvio
    // depois dela usa outra, para não ouvir a mesma recusa de novo.
    assert.equal(transferencias()[0].idem, chave);
    assert.notEqual(transferencias()[1].idem, chave);
  });

  it('banco recusou → reenvio com chave nova → resposta perdida → a confirmação reusa a chave nova', async () => {
    const { lote } = await comLote();
    await AffiliatePayoutService.approve(lote.id);
    await AffiliatePayoutService.send(lote.id);
    const enviado = await AffiliatePayoutService.findById(lote.id);
    await entregar({ event: 'TRANSFER_FAILED', transfer: { id: enviado.transfer_id, status: 'FAILED', failReason: 'Conta encerrada' } });

    // O reenvio troca a chave e já tira do lote a transferência recusada.
    respostaDaTransferencia = [502, { message: 'bad gateway' }];
    const incerto = await AffiliatePayoutService.send(lote.id);
    assert.equal(incerto.status, 'failed');
    assert.equal(incerto.error_code, 'uncertain');
    assert.equal(incerto.transfer_id, null);
    assert.equal(incerto.transfer_status, null);
    assert.notEqual(incerto.idempotency_key, enviado.idempotency_key);

    // A confirmação de que nada saiu reusa a chave do envio incerto — se o
    // Pix saiu, o gateway devolve o mesmo em vez de mandar outro.
    respostaDaTransferencia = null;
    await assert.rejects(AffiliatePayoutService.send(lote.id), { code: 'confirm_not_sent' });
    const final = await AffiliatePayoutService.send(lote.id, { confirmNotSent: true });
    assert.equal(final.status, 'sent');
    const idems = transferencias().map((t) => t.idem);
    assert.equal(idems.length, 3);
    assert.notEqual(idems[0], idems[1]);
    assert.equal(idems[1], idems[2]);
    assert.equal(final.idempotency_key, idems[2]);
  });

  it('o webhook TRANSFER_* nunca responde 500 — a consulta de hora em hora acerta', async () => {
    const original = AffiliatePayoutService.applyTransferWebhook;
    AffiliatePayoutService.applyTransferWebhook = async () => { throw new Error('banco fora do ar'); };
    try {
      const r = await entregar({ event: 'TRANSFER_DONE', transfer: { id: 'tra_qualquer', status: 'DONE' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.code, 'transfer_deferred');
    } finally {
      AffiliatePayoutService.applyTransferWebhook = original;
    }
  });

  it('a chave Pix trocada depois da aprovação barra o envio até nova aprovação', async () => {
    const { af, lote } = await comLote();
    await AffiliatePayoutService.approve(lote.id);
    const aprovado = await AffiliatePayoutService.findById(lote.id);
    assert.equal(aprovado.approved_pix_key, af.pix_key);
    await AffiliateService.update(af.id, { pixKey: 'nova-chave@pix.test', pixKeyType: 'EMAIL' });

    const r = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'pix_key_changed');
    assert.equal(transferencias().length, 0);
    const lista = await noConsole('/api/platform/affiliate-payouts');
    assert.equal(lista.body.data.payouts.find((p) => p.id === Number(lote.id)).pixKeyChanged, true);

    // A nova aprovação confere a chave nova; aí sai, para ela.
    const de_novo = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/approve`, { method: 'POST', body: {} });
    assert.equal(de_novo.status, 200, JSON.stringify(de_novo.body));
    assert.equal(de_novo.body.data.payout.approvedPixKey, 'nova-chave@pix.test');
    const enviado = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} });
    assert.equal(enviado.body.data.payout.status, 'sent');
    assert.equal(transferencias()[0].payload.pixAddressKey, 'nova-chave@pix.test');
    // Sem troca de chave, aprovar de novo o aprovado continua recusado.
    const outro = await comLote();
    await AffiliatePayoutService.approve(outro.lote.id);
    await assert.rejects(AffiliatePayoutService.approve(outro.lote.id), { code: 'not_draft' });
  });

  it('a resposta perdida exige a confirmação de que nada saiu, e reusa a mesma chave', async () => {
    const { lote } = await comLote();
    await AffiliatePayoutService.approve(lote.id);
    respostaDaTransferencia = [502, { message: 'bad gateway' }];
    const r = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} });
    assert.equal(r.body.data.payout.status, 'failed');
    assert.equal(r.body.data.payout.errorCode, 'uncertain');
    respostaDaTransferencia = null;
    const sem = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} });
    assert.equal(sem.status, 409);
    assert.equal(sem.body.code, 'confirm_not_sent');
    assert.equal(transferencias().length, 1);
    const cancelarSem = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/cancel`, { method: 'POST', body: {} });
    assert.equal(cancelarSem.status, 409);
    const com = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: { confirmNotSent: true } });
    assert.equal(com.body.data.payout.status, 'sent');
    assert.equal(transferencias().length, 2);
    assert.equal(transferencias()[0].idem, transferencias()[1].idem);
  });

  it('a transferência recusada pelo banco volta a falha e o reenvio usa outra chave', async () => {
    const { lote } = await comLote();
    await AffiliatePayoutService.approve(lote.id);
    await AffiliatePayoutService.send(lote.id);
    const enviado = await AffiliatePayoutService.findById(lote.id);
    await entregar({ event: 'TRANSFER_FAILED', transfer: { id: enviado.transfer_id, status: 'FAILED', failReason: 'Chave inexistente' } });
    const falho = await AffiliatePayoutService.findById(lote.id);
    assert.equal(falho.status, 'failed');
    assert.equal(falho.error_code, 'transfer_failed');
    await AffiliatePayoutService.send(lote.id);
    assert.equal(transferencias().length, 2);
    assert.notEqual(transferencias()[0].idem, transferencias()[1].idem);
  });

  it('a consulta fecha o lote enviado; marcar como pago e cancelar seguem as regras', async () => {
    const { lote } = await comLote();
    await AffiliatePayoutService.approve(lote.id);
    await AffiliatePayoutService.send(lote.id);
    const consulta = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/refresh`, { method: 'POST', body: {} });
    assert.equal(consulta.status, 200, JSON.stringify(consulta.body));
    assert.equal(consulta.body.data.payout.status, 'paid');

    const outro = await comLote();
    const rascunho = await noConsole(`/api/platform/affiliate-payouts/${outro.lote.id}/mark-paid`, { method: 'POST', body: {} });
    assert.equal(rascunho.status, 409);
    await AffiliatePayoutService.approve(outro.lote.id);
    const pago = await noConsole(`/api/platform/affiliate-payouts/${outro.lote.id}/mark-paid`, { method: 'POST', body: { note: 'TED manual' } });
    assert.equal(pago.status, 200, JSON.stringify(pago.body));
    assert.equal(pago.body.data.payout.paidManually, true);
    assert.equal(transferencias().length, 1);

    const terceiro = await comLote();
    const cancelado = await noConsole(`/api/platform/affiliate-payouts/${terceiro.lote.id}/cancel`, { method: 'POST', body: {} });
    assert.equal(cancelado.status, 200);
    assert.ok((await comissoesDe(terceiro.af.id)).every((c) => c.status === 'accrued' && c.payout_id === null));

    const inexistente = await noConsole('/api/platform/affiliate-payouts/999999/approve', { method: 'POST', body: {} });
    assert.equal(inexistente.status, 404);
  });

  it('não manda Pix sem chave', async () => {
    const { af, lote } = await comLote();
    await getDb()('affiliates').where({ id: af.id }).update({ pix_key: null, pix_key_type: null });
    await AffiliatePayoutService.approve(lote.id);
    const r = await noConsole(`/api/platform/affiliate-payouts/${lote.id}/send`, { method: 'POST', body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'no_pix_key');
    assert.equal(transferencias().length, 0);
    assert.equal((await AffiliatePayoutService.findById(lote.id)).status, 'approved');
  });
});

describe('o console', () => {
  it('cadastra, aprova, suspende e gera o link de senha, com a trilha', async () => {
    const criado = await noConsole('/api/platform/affiliates', {
      method: 'POST',
      body: { name: 'Maria Divulga', email: 'Maria@Divulga.test', pixKey: '529.982.247-25', pixKeyType: 'CPF', rateBp: 1500 }
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    const { id, status, code, email, pixKey } = criado.body.data.affiliate;
    assert.equal(status, 'pending');
    assert.match(code, /^A-[A-Z0-9]{7}$/);
    assert.equal(email, 'maria@divulga.test');
    assert.equal(pixKey, '52998224725');

    const repetido = await noConsole('/api/platform/affiliates', { method: 'POST', body: { name: 'Outra', email: 'maria@divulga.test' } });
    assert.equal(repetido.status, 409);
    const pixRuim = await noConsole('/api/platform/affiliates', { method: 'POST', body: { name: 'Outra', email: 'x@y.test', pixKey: '123', pixKeyType: 'CPF' } });
    assert.equal(pixRuim.status, 400);

    const aprovado = await noConsole(`/api/platform/affiliates/${id}`, { method: 'PATCH', body: { status: 'active', months: 6 } });
    assert.equal(aprovado.status, 200, JSON.stringify(aprovado.body));
    assert.equal(aprovado.body.data.affiliate.status, 'active');
    assert.equal(aprovado.body.data.affiliate.months, 6);

    const link = await noConsole(`/api/platform/affiliates/${id}/password-link`, { method: 'POST', body: {} });
    assert.equal(link.status, 200);
    assert.match(link.body.data.token, /^[0-9a-f]{64}$/);
    const guardado = await getDb()('affiliates').where({ id }).first();
    assert.notEqual(guardado.password_token_hash, link.body.data.token);

    const detalhe = await noConsole(`/api/platform/affiliates/${id}`);
    assert.equal(detalhe.status, 200);
    assert.equal(detalhe.body.data.affiliate.passwordLinkOpen, true);
    assert.equal(JSON.stringify(detalhe.body).includes('password_hash'), false);
    assert.equal((await noConsole('/api/platform/affiliates/999999')).status, 404);

    const lista = await noConsole('/api/platform/affiliates');
    assert.equal(lista.status, 200);
    assert.equal(lista.body.data.defaults.rateBp, 1000);

    const acoes = (await getDb()('platform_audit').where('action', 'like', 'affiliate.%')).map((l) => l.action);
    for (const acao of ['affiliate.created', 'affiliate.updated', 'affiliate.status_changed', 'affiliate.password_link']) {
      assert.ok(acoes.includes(acao), acao);
    }
    const detalhesDaTrilha = (await getDb()('platform_audit').where('action', 'like', 'affiliate.%')).map((l) => l.detail ?? '').join(' ');
    assert.equal(detalhesDaTrilha.includes('52998224725'), false);
  });
});

describe('o portal do afiliado', () => {
  it('cada afiliado lê só o que é dele, com o nome do indicado mascarado', async () => {
    const a = await afiliado();
    const b = await afiliado();
    const deA = await indicado(a.id);
    const deB = await indicado(b.id);
    await pagar(deA, { amountCents: 20000, externalId: `pay_portal_a_${deA}` });
    await pagar(deB, { amountCents: 30000, externalId: `pay_portal_b_${deB}` });

    const cookieA = await entrarComo(a);
    const visao = await noPortal('/overview', { cookie: cookieA });
    assert.equal(visao.status, 200, JSON.stringify(visao.body));
    assert.equal(visao.body.data.profile.email, a.email);
    assert.equal(visao.body.data.referrals.length, 1);
    assert.match(visao.body.data.referrals[0].name, /•••/);
    assert.equal(visao.body.data.commissions.length, 1);
    assert.equal(visao.body.data.commissions[0].amountCents, 2000);
    assert.equal(visao.body.data.commissions[0].tenantId, undefined);
    // A base (o valor da fatura do indicado) não vai ao portal; a taxa e a data, sim.
    assert.equal(visao.body.data.commissions[0].baseCents, undefined);
    assert.equal(visao.body.data.commissions[0].rateBp, 1000);
    assert.ok(visao.body.data.commissions[0].accruedAt);
    const texto = JSON.stringify(visao.body);
    assert.equal(texto.includes(`pay_portal_b_${deB}`), false);
    assert.equal(texto.includes('Provedor Indicado'), false);
    assert.equal(texto.includes(b.email), false);
  });

  it('não aceita o token do painel, nem como cabeçalho nem como cookie', async () => {
    const semNada = await noPortal('/overview');
    assert.equal(semNada.status, 401);
    const bearer = await noPortal('/overview', { headers: authHeaders(donoToken) });
    assert.equal(bearer.status, 401);
    const comoCookie = await noPortal('/overview', { cookie: `skygp_affiliate_session=${donoToken}` });
    assert.equal(comoCookie.status, 401);
  });

  it('a senha errada não entra, o link é de uso único, e suspender encerra a sessão', async () => {
    const af = await afiliado();
    const cookie = await entrarComo(af, 'senha-certa-123');
    const errada = await noPortal('/login', { method: 'POST', body: { email: af.email, password: 'senha-errada-123' } });
    assert.equal(errada.status, 401);
    assert.equal(errada.body.code, 'invalid_credentials');
    const inexistente = await noPortal('/login', { method: 'POST', body: { email: 'ninguem@afiliados.test', password: 'qualquer-coisa-1' } });
    assert.equal(inexistente.status, 401);

    const { token } = await AffiliateService.issuePasswordLink(af.id);
    assert.equal((await noPortal('/password', { method: 'POST', body: { token, password: 'outra-senha-12' } })).status, 200);
    assert.equal((await noPortal('/password', { method: 'POST', body: { token, password: 'mais-outra-123' } })).status, 400);
    // A senha trocada encerra a sessão aberta antes.
    assert.equal((await noPortal('/overview', { cookie })).status, 401);

    const nova = (await noPortal('/login', { method: 'POST', body: { email: af.email, password: 'outra-senha-12' } }))
      .response.headers.get('set-cookie').split(';')[0];
    assert.equal((await noPortal('/overview', { cookie: nova })).status, 200);
    await AffiliateService.setStatus(af.id, 'suspended');
    assert.equal((await noPortal('/overview', { cookie: nova })).status, 401);
    assert.equal((await noPortal('/login', { method: 'POST', body: { email: af.email, password: 'outra-senha-12' } })).status, 401);
  });

  it('a senha segue a política (nem comum, nem o e-mail); trocar o e-mail encerra a sessão', async () => {
    const af = await afiliado();
    const { token } = await AffiliateService.issuePasswordLink(af.id);
    const igualAoEmail = await noPortal('/password', { method: 'POST', body: { token, password: af.email } });
    assert.equal(igualAoEmail.status, 400);
    assert.equal(igualAoEmail.body.code, 'weak_password');
    assert.equal(igualAoEmail.body.problem, 'password_matches_identity');
    const comum = await noPortal('/password', { method: 'POST', body: { token, password: 'password123' } });
    assert.equal(comum.status, 400);
    assert.equal(comum.body.problem, 'password_too_common');
    // A recusa da política não gasta o link.
    const cookie = await entrarComo(af, 'uma-senha-boa-77');
    assert.equal((await noPortal('/overview', { cookie })).status, 200);
    await AffiliateService.update(af.id, { email: `trocado-${af.id}@afiliados.test` });
    assert.equal((await noPortal('/overview', { cookie })).status, 401);
  });

  it('a sessão só vale assinada em HS256', async () => {
    const af = await afiliado();
    const cookie = await entrarComo(af, 'senha-do-hs-256');
    const token = decodeURIComponent(cookie.split('=')[1]);
    const segredo = process.env.AFFILIATE_JWT_SECRET || crypto
      .createHmac('sha256', process.env.JWT_SECRET || DEVELOPMENT_FALLBACK)
      .update('skygenpanel-affiliate-portal-v1')
      .digest('hex');
    const { iat, exp, ...payload } = jwt.verify(token, segredo, { algorithms: ['HS256'] });
    assert.ok(iat && exp);
    const assinar = (algorithm) => jwt.sign(payload, segredo, { algorithm, expiresIn: 600 });
    // A mesma sessão, assinada com o mesmo segredo: HS256 entra, HS512 não.
    assert.equal((await noPortal('/overview', { cookie: `skygp_affiliate_session=${assinar('HS256')}` })).status, 200);
    assert.equal((await noPortal('/overview', { cookie: `skygp_affiliate_session=${assinar('HS512')}` })).status, 401);
  });

  it('o cookie é lido só pelo nome: `__proto__` e `constructor` no cabeçalho não mexem em nada', async () => {
    const { readCookie } = await import('../src/middleware/affiliateAuth.js');
    assert.equal(readCookie('__proto__=x; constructor=y; skygp_affiliate_session=abc%20d', 'skygp_affiliate_session'), 'abc d');
    assert.equal(readCookie('__proto__=x; constructor=y', 'skygp_affiliate_session'), undefined);
    assert.equal(readCookie('', 'skygp_affiliate_session'), undefined);
    assert.equal(Object.prototype.x, undefined);
    assert.equal(({}).polluted, undefined);

    const af = await afiliado();
    const cookie = await entrarComo(af, 'senha-do-proto-1');
    // Lixo antes do cookie certo não atrapalha; o certo continua valendo.
    const comLixo = `__proto__=polluted; constructor=prototype; ${cookie}`;
    assert.equal((await noPortal('/overview', { cookie: comLixo })).status, 200);
    assert.equal(({}).polluted, undefined);
    assert.equal((await noPortal('/overview', { cookie: '__proto__=polluted' })).status, 401);
  });

  it('a impressão no cookie é um HMAC com chave, não o sha256 do hash guardado', async () => {
    const af = await afiliado();
    const cookie = await entrarComo(af, 'senha-da-impressao-1');
    const { pwd, em } = jwt.decode(decodeURIComponent(cookie.split('=')[1]));
    const guardado = await getDb()('affiliates').where({ id: af.id }).first('password_hash');
    const semChave = crypto.createHash('sha256').update(String(guardado.password_hash)).digest('base64url').slice(0, 22);
    assert.equal(typeof pwd, 'string');
    assert.equal(pwd.length, 22);
    assert.notEqual(pwd, semChave);
    assert.equal(typeof em, 'string');
    assert.equal(em.length, 16);
  });

  it('o código do afiliado sai do alfabeto, com o prefixo e o tamanho certos', async () => {
    const { generateAffiliateCode } = await import('../src/services/affiliateService.js');
    for (let i = 0; i < 200; i += 1) {
      assert.match(generateAffiliateCode(), /^A-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{7}$/);
    }
  });
});
