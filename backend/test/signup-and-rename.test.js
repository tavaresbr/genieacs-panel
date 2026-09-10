import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Um ISP se cadastrando sozinho, e um provedor mudando o próprio nome.
 *
 * SaaS com subdomínio, porque o cadastro só faz sentido onde há um endereço
 * para entregar: sem `TENANT_BASE_DOMAIN` não existe `slug.painel…` para o
 * provedor novo entrar. Com subdomínio, toda requisição tem que nomear um
 * provedor no `Host`, então o cadastro é servido pelo host do provedor da
 * instalação — o primeiro, que é o da plataforma. `Host` é header proibido no
 * `fetch`, daí o `http.request` cru.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');

let panelUrl;
let ownerToken;
let viewerToken;

function callAs(host, url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const HOME = 'default.painel.test';
const home = (path, options) => callAs(HOME, `${panelUrl}${path}`, options);
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await home('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'owner-senha-1' } });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;
  const hire = await home('/api/users', {
    method: 'POST', headers: bearer(ownerToken),
    body: { username: 'leitor', password: 'leitor-senha-1', role: 'viewer' }
  });
  assert.equal(hire.status, 201);
  const signIn = await home('/api/auth/login', { method: 'POST', body: { username: 'leitor', password: 'leitor-senha-1' } });
  viewerToken = signIn.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('the public profile', () => {
  it('says which edition this is and where a provider lives', async () => {
    const res = await home('/api/tenant/public');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.edition, 'saas');
    assert.equal(res.body.data.panelBaseDomain, 'painel.test');
  });
});

describe('signing up', () => {
  const good = { providerName: 'ISP Nova', slug: 'nova', username: 'dona', password: 'dona-senha-123' };

  it('mints a provider indistinguishable from one the console minted, with its owner and a trial', async () => {
    const res = await home('/api/auth/signup', { method: 'POST', body: good });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.panelUrl, 'https://nova.painel.test');
    assert.equal(res.body.data.tenant.slug, 'nova');
    // Sem token: o painel dela vive em outro host.
    assert.equal(res.body.data.token, undefined);

    const db = getDb();
    const tenant = await db('tenants').where({ slug: 'nova' }).first();
    assert.ok(tenant);
    assert.equal(tenant.name, 'ISP Nova');
    // Seeded like a console-minted one: settings and a subscription in trial.
    assert.ok(await db('settings').where({ tenant_id: tenant.id, key: 'genieAcsUrl' }).first());
    const subscription = await db('subscriptions').where({ tenant_id: tenant.id }).first();
    assert.equal(subscription.status, 'trial');
    // Owner of her provider — and of nothing above it.
    const person = await db('users').where({ username: 'dona' }).first();
    const membership = await db('tenant_users').where({ tenant_id: tenant.id, user_id: person.id }).first();
    assert.equal(membership.role, 'owner');
    assert.equal(await db('platform_admins').where({ user_id: person.id }).first(), undefined,
      'signing up must never grant the control plane');
    const audit = await db('platform_audit').where({ action: 'tenant.created', tenant_id: tenant.id }).first();
    assert.equal(JSON.parse(audit.detail).via, 'signup');
    assert.equal(audit.actor_user_id, null);
  });

  it('and she can sign in at her own address, and nowhere else', async () => {
    const there = await callAs('nova.painel.test', `${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'dona', password: 'dona-senha-123' }
    });
    assert.equal(there.status, 200);
    const token = there.body.data.token;
    const mine = await callAs('nova.painel.test', `${panelUrl}/api/tenant/public`, { headers: bearer(token) });
    assert.equal(mine.body.data.name, 'ISP Nova');
    // The token is bound to her provider: replayed on the platform's host it is refused.
    const elsewhere = await home('/api/users', { headers: bearer(token) });
    assert.equal(elsewhere.status, 403);
  });

  it('refuses a bad subdomain, a taken one, and a taken login — each by name', async () => {
    assert.equal((await home('/api/auth/signup', { method: 'POST', body: { ...good, slug: 'Nova' } })).status, 400);
    assert.equal((await home('/api/auth/signup', { method: 'POST', body: { ...good, slug: 'www' } })).status, 400);
    const taken = await home('/api/auth/signup', { method: 'POST', body: { ...good, username: 'outra' } });
    assert.equal(taken.status, 409);
    const login = await home('/api/auth/signup', { method: 'POST', body: { ...good, slug: 'outra' } });
    assert.equal(login.status, 409);
    assert.notEqual(taken.body.message, login.body.message, 'the two fixes differ, so must the words');
    assert.equal((await home('/api/auth/signup', { method: 'POST', body: { ...good, slug: 'curta', password: 'curta' } })).status, 400);
    // Nothing half-made: no provider named 'outra', no person named 'outra'.
    assert.equal(await getDb()('tenants').where({ slug: 'outra' }).first(), undefined);
    assert.equal(await getDb()('users').where({ username: 'outra' }).first(), undefined);
  });
});

describe('renaming the provider', () => {
  it('changes the name on the row, the public profile reads it, and the trail says who', async () => {
    const res = await home('/api/tenant', { method: 'PATCH', headers: bearer(ownerToken), body: { name: 'Provedor da Casa' } });
    assert.equal(res.status, 200);
    const pub = await home('/api/tenant/public');
    assert.equal(pub.body.data.name, 'Provedor da Casa');
    const line = await getDb()('audit_log').where({ action: 'tenant.renamed' }).first();
    assert.ok(line);
    assert.deepEqual(JSON.parse(line.detail), { from: 'SkyGenPanel', to: 'Provedor da Casa' });
  });

  it('is settings.write: a viewer is refused, and an empty or oversized name too', async () => {
    assert.equal((await home('/api/tenant', { method: 'PATCH', headers: bearer(viewerToken), body: { name: 'X' } })).status, 403);
    assert.equal((await home('/api/tenant', { method: 'PATCH', headers: bearer(ownerToken), body: { name: '   ' } })).status, 400);
    assert.equal((await home('/api/tenant', { method: 'PATCH', headers: bearer(ownerToken), body: { name: 'x'.repeat(129) } })).status, 400);
  });
});

/**
 * O host da própria plataforma: o domínio-base sem provedor na frente.
 *
 * Até aqui uma requisição ali era recusada, e o cadastro era servido pelo
 * host do provedor da instalação — a porta de entrada da plataforma era a
 * porta de um cliente. Agora o apex serve exatamente o que um estranho
 * precisa, e nada que seja de um provedor.
 */
describe('the platform\'s own host', () => {
  const apex = (path, options) => callAs('painel.test', `${panelUrl}${path}`, options);

  it('describes the platform and names no provider', async () => {
    const res = await apex('/api/tenant/public');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { slug: null, name: null, edition: 'saas', panelBaseDomain: 'painel.test' });
  });

  it('answers the same on www', async () => {
    const res = await callAs('www.painel.test', `${panelUrl}/api/tenant/public`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.slug, null);
  });

  it('serves nothing that belongs to a provider', async () => {
    for (const [method, path, body] of [
      ['POST', '/api/auth/login', { username: 'owner', password: 'owner-senha-1' }],
      ['GET', '/api/auth/setup-status'],
      ['GET', '/api/tenant/subscription'],
      ['GET', '/api/devices'],
      ['GET', '/api/settings']
    ]) {
      const res = await apex(path, { method, body, headers: bearer(ownerToken) });
      assert.equal(res.status, 404, `${method} ${path} answered ${res.status}`);
    }
  });

  it('signs a provider up and sends it to its own address', async () => {
    const res = await apex('/api/auth/signup', {
      method: 'POST',
      body: { slug: 'porta', providerName: 'Porta Fibra', username: 'porta-dono', password: 'porta-senha-1' }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.panelUrl, 'https://porta.painel.test');

    const signIn = await callAs('porta.painel.test', `${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'porta-dono', password: 'porta-senha-1' }
    });
    assert.equal(signIn.status, 200);
    const me = await callAs('porta.painel.test', `${panelUrl}/api/tenant/public`, { headers: bearer(signIn.body.data.token) });
    assert.equal(me.body.data.name, 'Porta Fibra');
  });

  it('is nothing at all where subdomains are not what names a provider', async () => {
    // `painel.test` is the panel's base; the portal's base is unset here, so
    // a deeper or unrelated host still names nobody.
    const res = await callAs('outra.coisa.test', `${panelUrl}/api/tenant/public`);
    assert.equal(res.status, 404);
  });
});
