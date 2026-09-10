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
    assert.ok(Math.abs(renewsAt - (Date.now() + 30 * DAY)) < 5 * 60 * 1000);

    const second = await platform(`/tenants/${beta}/payments`, { method: 'POST', body: { amountCents: 19990, currency: 'BRL' } });
    const stacked = new Date(second.body.data.subscription.renewsAt).getTime();
    assert.ok(Math.abs(stacked - (renewsAt + 30 * DAY)) < 5 * 60 * 1000, 'paid ahead extends from the current end');
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
