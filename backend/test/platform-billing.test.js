import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A metade comercial do console: planos, a assinatura de cada provedor, o
 * pagamento que nós registramos e o uso.
 *
 * SaaS, porque é onde o console existe. Dois provedores — o da instalação, que
 * a migração pôs em `active` sem limite, e um cunhado pelo console, que o seed
 * põe em `trial` — e cada mudança conferida em TRÊS lugares: a linha, o
 * extrato do provedor e as duas trilhas.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');

let panelUrl;
let alfa;
let beta;
let ownerToken;
let comumToken;

const DAY = 24 * 60 * 60 * 1000;

const platform = (path, options = {}) => call(`${panelUrl}/api/platform${path}`, {
  ...options,
  headers: { ...authHeaders(ownerToken), ...(options.headers || {}) }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;
  // The SaaS setup path may already have put the first administrator on the
  // roster; the guard keeps this from failing on the unique either way.
  if (!(await getDb()('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });
  }

  const hire = await call(`${panelUrl}/api/users`, {
    method: 'POST', headers: authHeaders(ownerToken),
    body: { username: 'comum', password: 'comum-senha-1', role: 'admin', email: 'comum@exemplo.test' }
  });
  assert.equal(hire.status, 201);
  const signIn = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'comum', password: 'comum-senha-1', email: 'comum@exemplo.test' }
  });
  comumToken = signIn.body.data.token;

  const created = await platform('/tenants', { method: 'POST', body: { slug: 'beta', name: 'Provedor Beta' } });
  assert.equal(created.status, 201);
  beta = created.body.data.tenant.id;
});

after(async () => {
  await stopTestServers();
});

describe('plans', () => {
  let proId;

  it('lists the backfill plan with how many providers sit on it', async () => {
    const res = await platform('/plans');
    assert.equal(res.status, 200);
    const unlimited = res.body.data.plans.find((p) => p.code === 'unlimited');
    assert.ok(unlimited);
    assert.deepEqual(unlimited.limits, { operators: null, subscribers: null, devices: null });
    assert.equal(unlimited.subscribers, 2, 'alfa from the migration, beta from the seed');
  });

  it('creates one, refuses a bad code and a taken code', async () => {
    const created = await platform('/plans', {
      method: 'POST',
      body: { code: 'pro', name: 'Pro', maxOperators: 5, maxSubscribers: 500, maxDevices: null, priceCents: 19990, currency: 'brl', trialDays: 14 }
    });
    assert.equal(created.status, 201);
    proId = created.body.data.plan.id;
    assert.equal(created.body.data.plan.currency, 'BRL');
    // Quem cria sem dizer o período recebe o default da COLUNA, e não um 30
    // repetido no controlador: a segunda cópia de um default é a que diverge.
    assert.equal(created.body.data.plan.periodDays, 30);
    assert.deepEqual(created.body.data.plan.limits, { operators: 5, subscribers: 500, devices: null });

    assert.equal((await platform('/plans', { method: 'POST', body: { code: 'Pro!', name: 'x' } })).status, 400);
    assert.equal((await platform('/plans', { method: 'POST', body: { code: 'pro', name: 'again' } })).status, 409);
    assert.equal((await platform('/plans', { method: 'POST', body: { code: 'ok', name: 'x', maxOperators: -1 } })).status, 400);

    const audit = await getDb()('platform_audit').where({ action: 'plan.created' }).first();
    assert.ok(audit);
  });

  it('updates limits and name, never the code', async () => {
    const res = await platform(`/plans/${proId}`, {
      method: 'PATCH', body: { name: 'Pro Plus', maxOperators: 6, code: 'renamed' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.plan.name, 'Pro Plus');
    assert.equal(res.body.data.plan.limits.operators, 6);
    assert.equal(res.body.data.plan.code, 'pro');
    assert.equal((await platform(`/plans/${proId}`, { method: 'PATCH', body: { code: 'only' } })).status, 400);
  });
});

describe("a provider's subscription", () => {
  it('a provider minted by the console starts on trial, with the first line on its statement', async () => {
    const res = await platform(`/tenants/${beta}/subscription`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.subscription.status, 'trial');
    assert.ok(res.body.data.subscription.trialEndsAt);
    assert.equal(res.body.data.events.at(-1).type, 'trial.started');
  });

  it('changing the plan writes the statement and both trails, and leaves the state alone', async () => {
    const plans = (await platform('/plans')).body.data.plans;
    const pro = plans.find((p) => p.code === 'pro');
    const res = await platform(`/tenants/${beta}/subscription`, { method: 'PUT', body: { planId: pro.id } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.planId, pro.id);
    assert.equal(res.body.data.subscription.status, 'trial', 'a plan change is not a payment');

    const event = await getDb()('billing_events').where({ tenant_id: beta, type: 'plan.changed' }).first();
    assert.ok(event);
    assert.equal(JSON.parse(event.detail).toCode, 'pro');
    assert.ok(await getDb()('platform_audit').where({ action: 'subscription.plan_changed', tenant_id: beta }).first());
    const own = await getDb()('audit_log').where({ tenant_id: beta, action: 'subscription.changed' }).first();
    assert.ok(own, 'the provider must be able to read why on its own trail');
    assert.equal(own.actor_kind, 'platform');
  });

  it('suspending by hand blocks the provider at once, with the reason on the statement', async () => {
    const res = await platform(`/tenants/${beta}/subscription`, {
      method: 'PUT', body: { status: 'suspended', reason: 'abuso' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.subscription.status, 'suspended');
    const decision = await runInTenant(beta, async () => {
      const state = await SubscriptionService.current();
      return SubscriptionService.decide(state.subscription, { method: 'GET' });
    });
    assert.equal(decision.allowed, false, 'the cache has to have been invalidated');
    const event = await getDb()('billing_events').where({ tenant_id: beta, type: 'status.changed' }).orderBy('id', 'desc').first();
    assert.equal(JSON.parse(event.detail).reason, 'abuso');
    assert.equal((await platform(`/tenants/${beta}/subscription`, { method: 'PUT', body: { status: 'weird' } })).status, 400);
    assert.equal((await platform(`/tenants/${beta}/subscription`, { method: 'PUT', body: {} })).status, 400);
  });

  it('a payment on a suspended provider is recorded but does not reactivate it', async () => {
    const res = await platform(`/tenants/${beta}/payments`, {
      method: 'POST', body: { amountCents: 19990, currency: 'BRL', reference: 'PIX-001' }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.subscription.status, 'suspended');
    const event = await getDb()('billing_events').where({ tenant_id: beta, type: 'payment.recorded' }).first();
    assert.equal(event.amount_cents, 19990);
    assert.equal(event.external_id, 'PIX-001');
    assert.equal(event.provider, 'manual');
  });

  it('a payment on a past-due provider makes it active for thirty days, and a second one stacks', async () => {
    await platform(`/tenants/${beta}/subscription`, { method: 'PUT', body: { status: 'past_due' } });
    const first = await platform(`/tenants/${beta}/payments`, { method: 'POST', body: { amountCents: 19990, currency: 'BRL' } });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.subscription.status, 'active');
    const renewsAt = new Date(first.body.data.subscription.renewsAt).getTime();
    // Trinta porque é o `period_days` do plano do beta, e não porque é um
    // número dentro do serviço: desde a 0046 o prazo sai do catálogo.
    assert.ok(Math.abs(renewsAt - (Date.now() + 30 * DAY)) < 5 * 60 * 1000);

    const second = await platform(`/tenants/${beta}/payments`, { method: 'POST', body: { amountCents: 19990, currency: 'BRL' } });
    const stacked = new Date(second.body.data.subscription.renewsAt).getTime();
    assert.ok(Math.abs(stacked - (renewsAt + 30 * DAY)) < 5 * 60 * 1000, 'paid ahead extends from the current end');
  });

  /**
   * O prazo sai do plano, e é isto que faz existir plano anual.
   *
   * Antes da migração 0046 o período pago era um `30` dentro de
   * `subscriptionService`: o catálogo sabia dizer por quanto vende e não por
   * quanto tempo. Um ISP que pagasse doze meses de uma vez recebia trinta dias.
   */
  it('um plano anual credita trezentos e sessenta e cinco dias, e não trinta', async () => {
    // Provedor próprio: o beta já pagou duas vezes nos casos acima, e pagar
    // adiantado estende a partir do fim atual — o que é o comportamento certo e
    // tornaria esta conta sobre a data absoluta ilegível.
    const criado = await platform('/tenants', {
      method: 'POST', body: { slug: 'anualista', name: 'Provedor Anualista' }
    });
    assert.equal(criado.status, 201);
    const anualista = criado.body.data.tenant.id;

    const anual = await platform('/plans', {
      method: 'POST',
      body: { code: 'anual', name: 'Anual', priceCents: 199900, currency: 'BRL', periodDays: 365 }
    });
    assert.equal(anual.status, 201, JSON.stringify(anual.body));
    assert.equal(anual.body.data.plan.periodDays, 365);

    await platform(`/tenants/${anualista}/subscription`, {
      method: 'PUT', body: { planId: anual.body.data.plan.id, status: 'past_due' }
    });
    const pago = await platform(`/tenants/${anualista}/payments`, {
      method: 'POST', body: { amountCents: 199900, currency: 'BRL', externalId: 'PIX-ANUAL' }
    });
    assert.equal(pago.status, 201);
    const renova = new Date(pago.body.data.subscription.renewsAt).getTime();
    assert.ok(Math.abs(renova - (Date.now() + 365 * DAY)) < 5 * 60 * 1000,
      `o pagamento comprou ${Math.round((renova - Date.now()) / DAY)} dias`);
  });

  it('e período zero é recusado: seria uma assinatura que vence ao ser paga', async () => {
    const res = await platform('/plans', {
      method: 'POST', body: { code: 'instantaneo', name: 'Zero', periodDays: 0 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /periodDays/);
  });

  /**
   * A mesma referência credita uma vez só.
   *
   * Todo gateway reentrega webhook. Antes disto a segunda entrega de uma
   * referência era aceita sem erro, empurrava o período mais trinta dias e
   * gravava um segundo evento: o extrato tinha a coluna `external_id` mas não
   * o índice único que o seu comentário dizia existir, e ninguém lia a
   * referência antes de creditar.
   */
  it('the same reference credits once: a redelivery answers what already exists', async () => {
    const corpo = { amountCents: 19990, currency: 'BRL', reference: 'PIX-REENTREGA' };
    const first = await platform(`/tenants/${beta}/payments`, { method: 'POST', body: corpo });
    assert.equal(first.status, 201);
    const renewsAt = first.body.data.subscription.renewsAt;
    const trilhaAntes = (await getDb()('platform_audit').where({ tenant_id: beta })).length;

    const again = await platform(`/tenants/${beta}/payments`, { method: 'POST', body: corpo });
    assert.equal(again.status, 200, 'a reentrega não é um erro, e não é um pagamento novo');
    assert.equal(again.body.data.duplicate, true);
    assert.equal(again.body.data.subscription.renewsAt, renewsAt, 'nada pode ter sido creditado');

    const events = await getDb()('billing_events').where({ tenant_id: beta, external_id: 'PIX-REENTREGA' });
    assert.equal(events.length, 1, 'um pagamento, um evento');
    assert.equal((await getDb()('platform_audit').where({ tenant_id: beta })).length, trilhaAntes,
      'a trilha não pode dizer que houve um segundo pagamento');
  });

  /**
   * A corrida: duas entregas iguais ao mesmo tempo passam as duas pela
   * leitura da referência, e é o índice único quem decide. O dublê abaixo faz
   * a leitura não ver nada, que é exatamente o que a segunda entrega vê
   * quando a primeira ainda não foi confirmada.
   */
  it('and the unique index settles two identical deliveries that raced past the read', async () => {
    const { default: BillingEvent } = await import('../src/models/BillingEvent.js');
    const before = await runInTenant(beta, () => SubscriptionService.recordPayment({
      amountCents: 100, externalId: 'PIX-CORRIDA'
    }));
    assert.equal(before.duplicate, false);

    const leituraReal = BillingEvent.findByExternalId;
    BillingEvent.findByExternalId = async () => null;
    try {
      const again = await runInTenant(beta, () => SubscriptionService.recordPayment({
        amountCents: 100, externalId: 'PIX-CORRIDA'
      }));
      assert.equal(again.duplicate, true, 'o índice tem que ter recusado a segunda linha');
      assert.equal(String(again.subscription.renews_at), String(before.subscription.renews_at),
        'e a data não pode ter se movido: o evento vai antes dela, na mesma transação');
    } finally {
      BillingEvent.findByExternalId = leituraReal;
    }
    assert.equal((await getDb()('billing_events').where({ tenant_id: beta, external_id: 'PIX-CORRIDA' })).length, 1);
  });

  it('rejects a payment that is not money', async () => {
    assert.equal((await platform(`/tenants/${beta}/payments`, { method: 'POST', body: { amountCents: 12.5 } })).status, 400);
    assert.equal((await platform(`/tenants/${beta}/payments`, { method: 'POST', body: { amountCents: 100, currency: 'reais' } })).status, 400);
  });

  it('reports usage, with the device count from an ACS that is not there as null', async () => {
    const res = await platform(`/tenants/${beta}/usage`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.usage.operators, 0);
    assert.equal(res.body.data.usage.subscribers, 0);
    assert.equal(res.body.data.usage.devices, null);
    assert.equal(res.body.data.limits.operators, 6);
  });

  it('the provider list carries the plan and the state', async () => {
    const res = await platform('/tenants');
    const row = res.body.data.tenants.find((t) => Number(t.id) === Number(beta));
    assert.equal(row.subscription.planCode, 'pro');
    assert.equal(row.subscription.status, 'active');
    const alfaRow = res.body.data.tenants.find((t) => Number(t.id) === Number(alfa));
    assert.equal(alfaRow.subscription.planCode, 'unlimited');
  });
});

describe('who may', () => {
  it('nobody off the platform roster, and it answers 404 rather than 403', async () => {
    for (const [method, path, body] of [
      ['GET', '/plans'],
      ['POST', '/plans', { code: 'x', name: 'x' }],
      ['GET', `/tenants/${beta}/subscription`],
      ['PUT', `/tenants/${beta}/subscription`, { status: 'active' }],
      ['POST', `/tenants/${beta}/payments`, { amountCents: 1 }],
      ['GET', `/tenants/${beta}/usage`]
    ]) {
      const res = await call(`${panelUrl}/api/platform${path}`, { method, headers: authHeaders(comumToken), body });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });

  it('the console counts the target provider\'s seats, not the administrator\'s own', async () => {
    const plans = (await platform('/plans')).body.data.plans;
    const one = await platform('/plans', { method: 'POST', body: { code: 'um', name: 'Um', maxOperators: 1 } });
    await platform(`/tenants/${beta}/subscription`, { method: 'PUT', body: { planId: one.body.data.plan.id } });
    const first = await platform(`/tenants/${beta}/members`, { method: 'POST', body: { username: 'comum', role: 'viewer' } });
    assert.equal(first.status, 201);
    const second = await platform(`/tenants/${beta}/members`, { method: 'POST', body: { username: 'owner', role: 'viewer' } });
    assert.equal(second.status, 402);
    assert.equal(second.body.code, 'plan_limit_operators');
    assert.ok(plans.length >= 2);
  });
});
