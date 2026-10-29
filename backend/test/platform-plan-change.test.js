import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  authHeaders, call, getDb, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { decidePlanChange } = await import('../src/services/selfBillingService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');

/**
 * A troca de plano pelo console com a regra do provedor
 * (`SelfBillingService.changePlanAsPlatform`) e a prévia dela
 * (`GET .../subscription/plan-preview`) — mais as prévias que a lista de
 * planos do provedor ganhou (troca de ciclo, descida agendada).
 *
 * Self-hosted, pelo motivo de `platform-subscriptions.test.js`: só fora da
 * SaaS o cliente do gateway aceita `127.0.0.1`, e o que importa aqui é o que
 * SAI para o gateway — a fatura de pró-rata uma vez só, nenhuma quando o
 * console a dispensa. O roteador de verdade do console é montado num app
 * mínimo, atrás do mesmo resolvedor e do mesmo `attachLocale`.
 *
 * O que não pode dar errado, em dinheiro:
 *
 * 1. **Cobrar a pró-rata duas vezes** — o clique repetido, os dois cliques
 *    ao mesmo tempo.
 * 2. **Apagar uma troca agendada sem saber** — 409 `pending_change`.
 * 3. **A exceção sem dono** — forçar agora uma descida, ou pular o limite,
 *    sem o motivo na trilha.
 */
const CHAVE = 'chave-da-troca-pelo-console';
const DIA = 86_400_000;

let gateway;
let recebidas = [];
let proximoId = 0;
let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let donoId;
let alfa;
let beta;
let gama;
let caixa;
const planos = {};

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
        const id = `pay_troca_${proximoId}`;
        return responder(200, {
          id, status: 'PENDING', value: payload.value, dueDate: payload.dueDate,
          invoiceUrl: `https://gateway.exemplo.test/i/${id}`
        });
      }
      if (req.method === 'DELETE' && caminho.startsWith('/payments/')) return responder(200, { deleted: true });
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
  ...options,
  headers: { ...authHeaders(donoToken), ...(options.headers || {}) }
});
const trocar = (tenantId, body) => platform(`/tenants/${tenantId}/subscription`, { method: 'PUT', body });
const previa = (tenantId, query) => platform(`/tenants/${tenantId}/subscription/plan-preview?${new URLSearchParams(query)}`);

/** Um instante relativo a agora, ao segundo (o MySQL guarda segundos e arredonda). */
const daquiA = (dias) => new Date(Math.floor((Date.now() + dias * DIA) / 1000) * 1000);
const iso = (data) => new Date(data).toISOString();
const postsDeProrata = () => recebidas.filter((r) => r.method === 'POST'
  && /:proration:/.test(r.payload?.externalReference ?? ''));
const prorratas = (tenantId) => getDb()('billing_charges').where({ tenant_id: tenantId, kind: 'proration' });
const trilha = (tenantId) => getDb()('platform_audit')
  .where({ tenant_id: tenantId, action: 'subscription.plan_changed' }).orderBy('id', 'asc');

async function assinar(tenantId, {
  plan = planos.medio, status = 'active', renewsAt = daquiA(15), cycle = 'monthly', pending = null
} = {}) {
  await Subscription.upsertForTenant(tenantId, {
    plan_id: plan.id,
    status,
    billing_cycle: cycle,
    renews_at: status === 'trial' ? null : renewsAt,
    trial_ends_at: status === 'trial' ? daquiA(5) : null,
    canceled_at: null,
    cancel_at: null,
    paused_until: null,
    pending_plan_id: pending?.plan.id ?? null,
    pending_plan_at: pending?.at ?? null,
    pending_plan_locked_at: null,
    pending_billing_cycle: null,
    upgraded_at: null,
    billing_exempt_at: null,
    proration_due_at: null,
    suspended_reason: null,
    coupon_id: null,
    coupon_cycles_left: null,
    coupon_applied_at: null
  });
  await SubscriptionService.invalidate(tenantId);
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;

  ({ panelUrl } = await startTestServers());
  consoleUrl = await subirConsole();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-troca', password: 'senha-da-dona-1', email: 'dona@troca.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  donoId = setup.body.data.user.id;
  await getDb()('platform_admins').insert({ user_id: donoId });

  const db = getDb();
  alfa = (await db('tenants').where({ kind: 'provider' }).orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'troca-beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'troca-beta' }).first()).id;
  await db('tenants').insert({ slug: 'troca-gama', name: 'Provedor Gama', status: 'active' });
  gama = (await db('tenants').where({ slug: 'troca-gama' }).first()).id;
  caixa = (await db('tenants').where({ kind: 'platform' }).first())?.id;
  if (!caixa) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
    caixa = (await db('tenants').where({ kind: 'platform' }).first()).id;
  }
  resetDeploymentSharing();
  await db('tenants').whereIn('id', [alfa, beta, gama])
    .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_troca' });

  const criar = (row) => Plan.create({ currency: 'BRL', period_days: 30, trial_days: 0, active: true, ...row });
  planos.basico = await criar({ code: 'tc-basico', name: 'Básico', price_cents: 10000 });
  planos.medio = await criar({ code: 'tc-medio', name: 'Médio', price_cents: 16000, price_yearly_cents: 160000 });
  planos.pro = await criar({ code: 'tc-pro', name: 'Pro', price_cents: 25000 });
  // Não comporta operador nenhum: com uma pessoa na equipe, acima do teto.
  planos.mini = await criar({ code: 'tc-mini', name: 'Mini', price_cents: 5000, max_operators: 0, max_subscribers: 0 });
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
  const db = getDb();
  await db('billing_charges').whereIn('tenant_id', [alfa, beta, gama]).del();
  await db('billing_events').whereIn('tenant_id', [beta, gama]).del();
  await db('platform_audit').del();
  await db('tenant_users').where({ tenant_id: beta }).del();
  await assinar(beta);
  await assinar(gama, { status: 'trial' });
});

describe('a decisão (decidePlanChange) — a regra do provedor, extraída', () => {
  const agora = new Date('2026-10-06T12:00:00Z');
  const vivo = { status: 'active', plan_id: null, billing_cycle: 'monthly', renews_at: new Date(agora.getTime() + 10 * DIA) };
  const de = (plan) => ({ ...vivo, plan_id: plan.id });

  it('subir vale na hora, com a pró-rata; descer e trocar de ciclo, na renovação', () => {
    const sobe = decidePlanChange({ subscription: de(planos.medio), current: planos.medio, plan: planos.pro, now: agora });
    assert.equal(sobe.direction, 'upgrade');
    assert.equal(sobe.timing, 'now');
    assert.equal(sobe.proration.eligible, true);
    assert.equal(sobe.upgradedAt.getTime(), agora.getTime());

    const desce = decidePlanChange({ subscription: de(planos.medio), current: planos.medio, plan: planos.basico, now: agora });
    assert.equal(desce.direction, 'downgrade');
    assert.equal(desce.timing, 'renewal');
    assert.equal(desce.effectiveAt.getTime(), vivo.renews_at.getTime());
    assert.equal(desce.proration, null);
    assert.equal(desce.priceCents, 10000);

    const ciclo = decidePlanChange({
      subscription: de(planos.medio), current: planos.medio, plan: planos.medio, cycle: 'annual', now: agora
    });
    assert.equal(ciclo.direction, 'cycle');
    assert.equal(ciclo.timing, 'renewal');
    assert.equal(ciclo.priceCents, 160000);
  });

  it('sem período pago correndo, tudo vale na hora; a descida depois de uma subida espera a renovação seguinte', () => {
    const atrasado = { ...de(planos.medio), status: 'past_due' };
    assert.equal(decidePlanChange({ subscription: atrasado, current: planos.medio, plan: planos.basico, now: agora }).timing, 'now');
    const vencido = { ...de(planos.medio), renews_at: new Date(agora.getTime() - DIA) };
    assert.equal(decidePlanChange({ subscription: vencido, current: planos.medio, plan: planos.basico, now: agora }).timing, 'now');

    const subiu = { ...de(planos.pro), upgraded_at: agora };
    const adiada = decidePlanChange({ subscription: subiu, current: planos.pro, plan: planos.basico, now: agora });
    assert.equal(adiada.deferredByUpgrade, true);
    assert.equal(adiada.effectiveAt.getTime(), vivo.renews_at.getTime() + 30 * DIA);
  });

  it('o modo do console força, e diz que forçou', () => {
    const agoraMesmo = decidePlanChange({
      subscription: de(planos.medio), current: planos.medio, plan: planos.basico, mode: 'now', now: agora
    });
    assert.equal(agoraMesmo.timing, 'now');
    assert.equal(agoraMesmo.forced, true);
    assert.equal(agoraMesmo.proration, null, 'descer não cobra nada');
    const naRenovacao = decidePlanChange({
      subscription: de(planos.medio), current: planos.medio, plan: planos.pro, mode: 'renewal', now: agora
    });
    assert.equal(naRenovacao.timing, 'renewal');
    assert.equal(naRenovacao.forced, true);
    assert.equal(naRenovacao.proration, null, 'a subida agendada não cobra pró-rata');
    const cicloAgora = decidePlanChange({
      subscription: de(planos.basico), current: planos.basico, plan: planos.medio, cycle: 'annual', mode: 'now', now: agora
    });
    assert.equal(cicloAgora.proration, null);
    assert.equal(cicloAgora.prorationSkipped, 'cycle_change');
  });
});

describe('a prévia do console', () => {
  it('diz o que cada modo faria: a subida na hora com a pró-rata, ou na renovação', async () => {
    const res = await previa(beta, { planId: planos.pro.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = res.body.data.preview;
    assert.equal(p.direction, 'upgrade');
    assert.equal(p.modes.auto.timing, 'now');
    assert.ok(p.modes.auto.proration.amountCents > 0);
    assert.equal(p.modes.renewal.timing, 'renewal');
    assert.equal(p.modes.renewal.effectiveAt, iso((await Subscription.forTenant(beta)).renews_at));
    assert.equal(p.modes.renewal.proration, null);
    assert.equal(p.reasonRequiredForNow, false);
    assert.deepEqual(p.blockers, []);
    assert.equal(p.pending, null);
    assert.equal(recebidas.length, 0, 'a prévia não fala com o gateway');
    assert.equal((await prorratas(beta)).length, 0);
  });

  it('a descida: na renovação com a data e o preço novo; agora pede motivo; os excessos todos', async () => {
    await getDb()('tenant_users').insert({ tenant_id: beta, user_id: donoId, role: 'admin' });
    const res = await previa(beta, { planId: planos.mini.id });
    const p = res.body.data.preview;
    assert.equal(p.direction, 'downgrade');
    assert.equal(p.modes.auto.timing, 'renewal');
    assert.equal(p.modes.auto.priceCents, 5000);
    assert.equal(p.modes.auto.nextChargeAt, p.modes.auto.effectiveAt);
    assert.equal(p.modes.now.timing, 'now');
    assert.equal(p.reasonRequiredForNow, true);
    assert.deepEqual(p.overLimit.map((o) => o.resource), ['operators']);
    assert.equal(p.overLimit[0].used, 1);
    assert.equal(p.overLimit[0].limit, 0);
  });

  it('sem período correndo não há renovação; a troca agendada aparece; a caixa e o plano errado não', async () => {
    const teste = (await previa(gama, { planId: planos.pro.id })).body.data.preview;
    assert.equal(teste.modes.renewal, null);
    assert.equal(teste.modes.auto.timing, 'now');

    await assinar(beta, { pending: { plan: planos.basico, at: daquiA(15) } });
    const comAgendada = (await previa(beta, { planId: planos.pro.id })).body.data.preview;
    assert.equal(comAgendada.pending.planId, planos.basico.id);
    assert.equal(comAgendada.pending.locked, false);

    assert.equal((await previa(caixa, { planId: planos.pro.id })).status, 404);
    assert.equal((await previa(beta, { planId: 'x' })).status, 400);
    assert.equal((await previa(beta, { planId: 999999 })).status, 404);
    assert.equal((await previa(beta, { planId: planos.pro.id, cycle: 'semanal' })).status, 400);
    const semAnual = (await previa(beta, { planId: planos.pro.id, cycle: 'annual' })).body.data.preview;
    assert.deepEqual(semAnual.blockers, ['cycle_unavailable']);
  });
});

describe('a troca pelo console', () => {
  it('sem modo é a regra do provedor: a subida vale na hora e cobra a pró-rata UMA vez, mesmo clicando de novo', async () => {
    const res = await trocar(beta, { planId: planos.pro.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { outcome } = res.body.data;
    assert.equal(outcome.changed, true);
    assert.equal(outcome.timing, 'now');
    assert.equal(outcome.mode, 'auto');
    assert.equal(outcome.forced, false);
    assert.equal(outcome.limitCheck, 'passed');
    assert.equal(outcome.proration.issued, true);
    assert.ok(outcome.proration.chargeId);
    assert.equal(res.body.data.planId, planos.pro.id);
    assert.equal(postsDeProrata().length, 1);

    // O duplo clique: nada muda, nada sai, nada na trilha.
    const deNovo = await trocar(beta, { planId: planos.pro.id });
    assert.equal(deNovo.status, 200);
    assert.equal(deNovo.body.data.outcome.changed, false);
    assert.equal(deNovo.body.data.outcome.timing, 'none');
    assert.equal(deNovo.body.data.outcome.proration, null);
    assert.equal(postsDeProrata().length, 1);
    assert.equal((await prorratas(beta)).length, 1);
    assert.equal((await trilha(beta)).length, 1);

    const [linha] = await trilha(beta);
    const detalhe = JSON.parse(linha.detail);
    assert.equal(detalhe.mode, 'auto');
    assert.equal(detalhe.timing, 'now');
    assert.equal(detalhe.proration.issued, true);
    assert.equal(detalhe.from, planos.medio.id);
    assert.equal(detalhe.to, planos.pro.id);
  });

  it('dois cliques ao mesmo tempo: uma fatura de pró-rata só', async () => {
    const [um, dois] = await Promise.all([
      trocar(beta, { planId: planos.pro.id }),
      trocar(beta, { planId: planos.pro.id })
    ]);
    assert.ok([um.status, dois.status].every((s) => s === 200 || s === 409), `${um.status} ${dois.status}`);
    assert.equal((await prorratas(beta)).length, 1);
    assert.equal(postsDeProrata().length, 1);
    assert.equal((await Subscription.forTenant(beta)).plan_id, planos.pro.id);
  });

  it('`prorate: false` dispensa a pró-rata: nenhuma fatura, e o extrato e a trilha dizem que foi dispensada', async () => {
    const res = await trocar(beta, { planId: planos.pro.id, prorate: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.outcome.proration.issued, false);
    assert.equal(res.body.data.outcome.proration.skipped, 'waived');
    assert.ok(res.body.data.outcome.proration.amountCents > 0);
    assert.equal(postsDeProrata().length, 0);
    assert.equal((await prorratas(beta)).length, 0);
    const evento = await getDb()('billing_events').where({ tenant_id: beta, type: 'plan.changed' }).orderBy('id', 'desc').first();
    const detalhe = JSON.parse(evento.detail);
    assert.equal(detalhe.proration.notCharged, 'waived');
    assert.equal(detalhe.console, true);
    assert.equal(JSON.parse((await trilha(beta))[0].detail).proration.skipped, 'waived');
  });

  it('a descida no meio do período fica para a renovação, com a data, e o plano não muda agora', async () => {
    const renova = (await Subscription.forTenant(beta)).renews_at;
    const res = await trocar(beta, { planId: planos.basico.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { outcome } = res.body.data;
    assert.equal(outcome.scheduled, true);
    assert.equal(outcome.timing, 'renewal');
    assert.equal(outcome.effectiveAt, iso(renova));
    assert.equal(outcome.proration, null);
    assert.equal(outcome.limitCheck, 'deferred');
    const linha = await Subscription.forTenant(beta);
    assert.equal(linha.plan_id, planos.medio.id);
    assert.equal(Number(linha.pending_plan_id), planos.basico.id);
    assert.equal(recebidas.length, 0);
  });

  it('com uma troca agendada: 409 `pending_change`, a menos que venha `replacePending`; pedir a mesma de novo passa', async () => {
    const at = daquiA(15);
    await assinar(beta, { pending: { plan: planos.basico, at } });

    const recusa = await trocar(beta, { planId: planos.pro.id });
    assert.equal(recusa.status, 409, JSON.stringify(recusa.body));
    assert.equal(recusa.body.code, 'pending_change');
    assert.equal(recusa.body.pendingPlanId, planos.basico.id);
    assert.equal(recusa.body.effectiveAt, iso(at));
    // Desistir dela (o plano atual) também é mexer nela.
    assert.equal((await trocar(beta, { planId: planos.medio.id })).body.code, 'pending_change');
    assert.equal(Number((await Subscription.forTenant(beta)).pending_plan_id), planos.basico.id, 'nada mudou');
    assert.equal(recebidas.length, 0);

    // A mesma agendada pedida de novo não é substituir nada.
    const mesma = await trocar(beta, { planId: planos.basico.id });
    assert.equal(mesma.status, 200);
    assert.equal(mesma.body.data.outcome.changed, false);
    assert.equal(mesma.body.data.outcome.scheduled, true);
    assert.equal((await trilha(beta)).length, 0);

    const troca = await trocar(beta, { planId: planos.pro.id, replacePending: true });
    assert.equal(troca.status, 200, JSON.stringify(troca.body));
    assert.equal(troca.body.data.outcome.replacedPlanId, planos.basico.id);
    const linha = await Subscription.forTenant(beta);
    assert.equal(linha.plan_id, planos.pro.id);
    assert.equal(linha.pending_plan_id, null);
  });

  it('desistir da agendada com `replacePending`', async () => {
    await assinar(beta, { pending: { plan: planos.basico, at: daquiA(15) } });
    const res = await trocar(beta, { planId: planos.medio.id, replacePending: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.outcome.pendingCanceled, true);
    assert.equal((await Subscription.forTenant(beta)).pending_plan_id, null);
    assert.equal(JSON.parse((await trilha(beta))[0].detail).pendingCanceled, true);
  });

  it('forçar agora uma descida exige o motivo, que fica só na trilha da plataforma', async () => {
    const sem = await trocar(beta, { planId: planos.basico.id, mode: 'now' });
    assert.equal(sem.status, 400);
    assert.equal(sem.body.code, 'reason_required');
    assert.equal((await Subscription.forTenant(beta)).plan_id, planos.medio.id);

    const res = await trocar(beta, { planId: planos.basico.id, mode: 'now', reason: 'acordo comercial' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.outcome.timing, 'now');
    assert.equal(res.body.data.outcome.forced, true);
    assert.equal((await Subscription.forTenant(beta)).plan_id, planos.basico.id);

    const detalhe = JSON.parse((await trilha(beta))[0].detail);
    assert.equal(detalhe.reason, 'acordo comercial');
    assert.equal(detalhe.mode, 'now');
    assert.equal(detalhe.forced, true);
    const doProvedor = await getDb()('audit_log')
      .where({ tenant_id: beta, action: 'subscription.changed' }).orderBy('id', 'desc').first();
    const delas = JSON.parse(doProvedor.detail);
    assert.equal(delas.platformAction, 'subscription.plan_changed');
    assert.equal('reason' in delas, false, 'o motivo é anotação interna do console');
    assert.equal(doProvedor.actor_kind, 'platform');
  });

  it('o uso acima do teto barra a troca na hora; `skipLimitCheck` passa por cima, com o motivo', async () => {
    await getDb()('tenant_users').insert({ tenant_id: beta, user_id: donoId, role: 'admin' });
    const barrada = await trocar(beta, { planId: planos.mini.id, mode: 'now', reason: 'teste' });
    assert.equal(barrada.status, 409);
    assert.equal(barrada.body.code, 'over_limit');
    assert.equal(barrada.body.resource, 'operators');

    const semMotivo = await trocar(beta, { planId: planos.mini.id, mode: 'now', skipLimitCheck: true });
    assert.equal(semMotivo.status, 400);
    assert.equal(semMotivo.body.code, 'reason_required');

    const res = await trocar(beta, { planId: planos.mini.id, mode: 'now', skipLimitCheck: true, reason: 'migração' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.outcome.limitCheck, 'skipped');
    assert.deepEqual(res.body.data.outcome.overLimit.map((o) => o.resource), ['operators']);
    assert.equal((await Subscription.forTenant(beta)).plan_id, planos.mini.id);
    const detalhe = JSON.parse((await trilha(beta))[0].detail);
    assert.equal(detalhe.limitCheck, 'skipped');
    assert.equal(detalhe.reason, 'migração');
  });

  it('`renewal` agenda até a subida (sem pró-rata); sem período correndo é 409 `no_renewal`', async () => {
    const res = await trocar(beta, { planId: planos.pro.id, mode: 'renewal' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.outcome.scheduled, true);
    assert.equal(res.body.data.outcome.forced, true);
    assert.equal(res.body.data.outcome.proration, null);
    assert.equal(Number((await Subscription.forTenant(beta)).pending_plan_id), planos.pro.id);
    assert.equal(postsDeProrata().length, 0);

    const teste = await trocar(gama, { planId: planos.pro.id, mode: 'renewal' });
    assert.equal(teste.status, 409);
    assert.equal(teste.body.code, 'no_renewal');
  });

  it('a troca de ciclo vai para a renovação; o ciclo sem preço é recusado; e o corpo é conferido', async () => {
    const ciclo = await trocar(beta, { planId: planos.medio.id, cycle: 'annual' });
    assert.equal(ciclo.status, 200, JSON.stringify(ciclo.body));
    assert.equal(ciclo.body.data.outcome.scheduled, true);
    assert.equal(ciclo.body.data.outcome.billingCycle, 'annual');
    assert.equal((await Subscription.forTenant(beta)).pending_billing_cycle, 'annual');

    assert.equal((await trocar(gama, { planId: planos.pro.id, cycle: 'annual' })).body.code, 'cycle_unavailable');
    assert.equal((await trocar(beta, { planId: planos.pro.id, mode: 'já' })).body.code, 'invalid_mode');
    assert.equal((await trocar(beta, { planId: planos.pro.id, prorate: 'sim' })).status, 400);
    assert.equal((await trocar(beta, { planId: planos.pro.id, cycle: 'semanal' })).body.code, 'invalid_cycle');
  });

  it('o console ainda escolhe o plano de graça e troca o suspenso, na hora', async () => {
    await assinar(gama, { status: 'suspended' });
    const res = await trocar(gama, { planId: planos.basico.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.outcome.timing, 'now');
    const gratis = await Plan.findByCode('unlimited');
    const deGraca = await trocar(gama, { planId: gratis.id });
    assert.equal(deGraca.status, 200, JSON.stringify(deGraca.body));
    assert.equal((await Subscription.forTenant(gama)).plan_id, gratis.id);
  });
});

describe('as prévias do provedor na lista de planos', () => {
  it('a descida agendada (com a data e o preço da renovação) e a troca de ciclo', async () => {
    const renova = daquiA(12);
    await assinar(alfa, { plan: planos.medio, renewsAt: renova });
    const res = await call(`${panelUrl}/api/tenant/plans`, { headers: authHeaders(donoToken) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const lista = res.body.data;
    const basico = lista.find((p) => p.code === 'tc-basico');
    assert.equal(basico.changes.monthly.timing, 'renewal');
    assert.equal(basico.changes.monthly.direction, 'downgrade');
    assert.equal(basico.changes.monthly.effectiveAt, iso(renova));
    assert.equal(basico.changes.monthly.priceCents, 10000);
    assert.equal(basico.changes.annual, null, 'o Básico não tem anual');

    const medio = lista.find((p) => p.code === 'tc-medio');
    assert.equal(medio.current, true);
    assert.equal(medio.changes.monthly, null, 'o plano e ciclo de agora não têm prévia');
    assert.equal(medio.changes.annual.direction, 'cycle');
    assert.equal(medio.changes.annual.timing, 'renewal');
    assert.equal(medio.changes.annual.effectiveAt, iso(renova));
    assert.equal(medio.changes.annual.priceCents, 160000);

    const pro = lista.find((p) => p.code === 'tc-pro');
    assert.equal(pro.changes.monthly.timing, 'now');
    assert.ok(pro.changes.monthly.proration.amountCents > 0);
    assert.equal(pro.changes.monthly.proration.amountCents, pro.proration.amountCents, 'a mesma conta da prévia de sempre');
  });
});
