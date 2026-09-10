import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A porta da assinatura: o que cada estado deixa passar, provado por HTTP.
 *
 * SaaS, porque a porta só é montada nessa edição — e é a edição em que um
 * provedor pode estar devendo. O que se prova aqui é o contrato de
 * `SubscriptionService.decide` visto de fora: `trial` e `active` passam,
 * `past_due` passa só para ler, `suspended`/`canceled` respondem 402 — e as
 * três portas que ficam de fora (login, o nome do provedor, o console)
 * continuam abertas num provedor bloqueado, porque são o que permite sair do
 * bloqueio.
 *
 * Os estados são escritos direto na linha da assinatura do provedor da
 * instalação e o cache do gate é invalidado à mão: o que está sob teste é a
 * leitura, não o console que muda o estado (esse tem a própria suíte).
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: SubscriptionService, GATE_CODES } = await import('../src/services/subscriptionService.js');
const { default: Subscription } = await import('../src/models/Subscription.js');

let panelUrl;
let portalUrl;
let alfa;
let ownerToken;
let ownerId;

const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  alfa = await defaultTenantId();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'owner', password: 'owner-senha-1' }
  });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;
  ownerId = setup.body.data.user.id;
  if (!(await getDb()('platform_admins').where({ user_id: ownerId }).first())) {
    await getDb()('platform_admins').insert({ user_id: ownerId });
  }
});

after(async () => {
  await stopTestServers();
});

/** Põe o provedor da instalação no estado pedido, e faz o gate ler de novo. */
async function setState(patch) {
  await Subscription.upsertForTenant(alfa, {
    status: 'active', trial_ends_at: null, renews_at: null, canceled_at: null, ...patch
  });
  await SubscriptionService.invalidate(alfa);
}

afterEach(async () => {
  await setState({ status: 'active' });
});

const read = () => call(`${panelUrl}/api/users`, { headers: authHeaders(ownerToken) });
const write = () => call(`${panelUrl}/api/users`, {
  method: 'POST',
  headers: authHeaders(ownerToken),
  body: { username: 'alguem', password: 'senha-de-alguem-1', role: 'viewer' }
});

describe('the states that pass', () => {
  it('active: reads and writes', async () => {
    await setState({ status: 'active' });
    assert.equal((await read()).status, 200);
    const created = await write();
    assert.equal(created.status, 201);
    await getDb()('tenant_users').where({ user_id: created.body.data.user.id }).del();
    await getDb()('users').where({ id: created.body.data.user.id }).del();
  });

  it('trial, while it lasts: reads and writes', async () => {
    await setState({ status: 'trial', trial_ends_at: new Date(Date.now() + 3 * DAY) });
    assert.equal((await read()).status, 200);
    const attempt = await write();
    assert.notEqual(attempt.status, 402);
    if (attempt.status === 201) {
      await getDb()('tenant_users').where({ user_id: attempt.body.data.user.id }).del();
      await getDb()('users').where({ id: attempt.body.data.user.id }).del();
    }
  });
});

describe('past due: look, but do not touch', () => {
  it('lets a read through and refuses a write with the code the screen expects', async () => {
    await setState({ status: 'past_due' });
    assert.equal((await read()).status, 200);
    const refused = await write();
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, GATE_CODES.PAST_DUE);
    // A placa que o muro mostra: o estado vem junto, para a tela não ter que
    // perguntar de novo a uma rota que talvez também responda 402.
    assert.equal(refused.body.subscription.status, 'past_due');
    assert.ok(refused.body.message);
  });

  it('a trial whose date passed is past due from that second, without any job running', async () => {
    await setState({ status: 'trial', trial_ends_at: new Date(Date.now() - 1000) });
    assert.equal((await read()).status, 200);
    const refused = await write();
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, GATE_CODES.TRIAL_EXPIRED);
    assert.equal(refused.body.subscription.status, 'past_due');
    assert.equal(refused.body.subscription.storedStatus, 'trial');
  });

  it('lets an inbound webhook through: the ERP event is not the operator writing', async () => {
    await setState({ status: 'past_due' });
    const delivery = await call(`${panelUrl}/api/sgp/events/webhook`, { method: 'POST', body: {} });
    // O que o webhook responde com a integração desligada não importa aqui;
    // o que importa é que a resposta não veio da porta da assinatura.
    assert.notEqual(delivery.status, 402);
  });

  it('keeps the subscriber portal fully up: the subscriber is not the one who owes', async () => {
    await setState({ status: 'past_due' });
    const attempt = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'NAO-EXISTE', password: 'ABCDEF' }
    });
    assert.notEqual(attempt.status, 402);
  });
});

describe('suspended and canceled: a wall', () => {
  for (const [status, code] of [['suspended', GATE_CODES.SUSPENDED], ['canceled', GATE_CODES.CANCELED]]) {
    it(`${status}: refuses even a read, with its own code`, async () => {
      await setState({ status });
      const refused = await read();
      assert.equal(refused.status, 402);
      assert.equal(refused.body.code, code);
    });

    it(`${status}: takes the subscriber portal down too`, async () => {
      await setState({ status });
      const attempt = await call(`${portalUrl}/api/customer/login`, {
        method: 'POST',
        body: { customerId: 'NAO-EXISTE', password: 'ABCDEF' }
      });
      assert.equal(attempt.status, 402);
    });
  }

  it('a provider with no subscription at all is refused, not let through', async () => {
    const saved = await Subscription.forTenant(alfa);
    await getDb()('subscriptions').where({ tenant_id: alfa }).del();
    await SubscriptionService.invalidate(alfa);
    try {
      const refused = await read();
      assert.equal(refused.status, 402);
      assert.equal(refused.body.code, GATE_CODES.MISSING);
    } finally {
      const { id, ...row } = saved;
      await getDb()('subscriptions').insert(row);
      await SubscriptionService.invalidate(alfa);
    }
  });
});

describe('what stays open on a blocked provider', () => {
  it('signing in, the provider name, the subscription itself and the console', async () => {
    await setState({ status: 'suspended' });

    const signIn = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'owner', password: 'owner-senha-1' }
    });
    assert.equal(signIn.status, 200, 'entrar é como se vê o aviso');

    const name = await call(`${panelUrl}/api/tenant/public`);
    assert.equal(name.status, 200);

    const mine = await call(`${panelUrl}/api/tenant/subscription`, { headers: authHeaders(ownerToken) });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.subscription.status, 'suspended');

    const console_ = await call(`${panelUrl}/api/platform/tenants`, { headers: authHeaders(ownerToken) });
    assert.equal(console_.status, 200, 'o console é como se sai do bloqueio');
    const row = console_.body.data.tenants.find((t) => Number(t.id) === Number(alfa));
    assert.equal(row.subscription.status, 'suspended');
  });
});

describe('the cache', () => {
  it('reads the change once the console has invalidated it, and not before', async () => {
    await setState({ status: 'active' });
    assert.equal((await read()).status, 200);
    // Escrito na linha sem invalidar: o gate continua confiando na leitura
    // anterior — é o custo aceito para não ler a assinatura a cada request.
    await Subscription.upsertForTenant(alfa, { status: 'suspended' });
    assert.equal((await read()).status, 200);
    await SubscriptionService.invalidate(alfa);
    assert.equal((await read()).status, 402);
  });

  it('every change the service makes invalidates on its own', async () => {
    await setState({ status: 'active' });
    assert.equal((await read()).status, 200);
    await runInTenant(alfa, () => SubscriptionService.setStatus({ status: 'suspended' }));
    assert.equal((await read()).status, 402);
    await runInTenant(alfa, () => SubscriptionService.setStatus({ status: 'active' }));
    assert.equal((await read()).status, 200);
  });
});
