import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The base domains are read once, at module load, because they are deployment
// configuration rather than per-request state. Static imports are hoisted above
// every statement, so the harness has to be pulled in dynamically for these
// assignments to be visible to it — the same reason `edition-saas.test.js`
// does it. `node --test` gives each file its own process, so this does not
// leak into the other suites, which is exactly what keeps them exercising the
// no-subdomain path.
process.env.TENANT_BASE_DOMAIN = 'painel.exemplo.com';
process.env.PORTAL_BASE_DOMAIN = 'portal.exemplo.com';

const { call, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { tenantSlugFromHost } = await import('../src/middleware/tenantResolver.js');

/**
 * A request with a chosen `Host`.
 *
 * `fetch` will not do this: `Host` is a forbidden header there, and undici
 * replaces it with the real one silently — a test written with `fetch` would
 * pass while proving nothing. The raw client is the only way to say which
 * provider the caller is asking for.
 */
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
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
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

let panelUrl;
let portalUrl;
let alfaToken;
let betaToken;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  const db = getDb();

  // The install's own provider becomes `alfa`; `beta` is the second one, which
  // is the entire point of the slice.
  const first = await db('tenants').orderBy('id', 'asc').first();
  await db('tenants').where({ id: first.id }).update({ slug: 'alfa', name: 'Provedor Alfa' });
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  await db('tenants').insert({ slug: 'parada', name: 'Provedor Parado', status: 'suspended' });

  const setup = await callAs('alfa.painel.exemplo.com', `${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
  });
  alfaToken = setup.body?.data?.token;

  // Beta's operator is created directly, because the setup route only ever
  // mints the first administrator of a provider that has none. The membership
  // is the part that matters and the part that is easy to forget: a person
  // with no row in `tenant_users` cannot sign in at all, and the token this
  // fixture is here to produce would come back undefined.
  const beta = await db('tenants').where({ slug: 'beta' }).first();
  const { default: User } = await import('../src/models/User.js');
  const { default: TenantUser } = await import('../src/models/TenantUser.js');
  const { runInTenant } = await import('../src/config/tenantContext.js');
  const betaUserId = await runInTenant(beta.id, async () => {
    const bcrypt = (await import('bcryptjs')).default;
    return User.create({
      username: 'operador-beta',
      password: await bcrypt.hash('senha-do-beta-1', 10),
      role: 'admin'
    });
  });
  await runInTenant(beta.id, () => TenantUser.create({
    tenantId: beta.id, userId: betaUserId, role: 'admin'
  }));
  const login = await callAs('beta.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
    method: 'POST',
    body: { username: 'operador-beta', password: 'senha-do-beta-1' }
  });
  betaToken = login.body?.data?.token;
  // Asserted here, once, rather than in each test that uses it: a fixture that
  // silently produced nothing would make `Bearer undefined` answer 403 for the
  // wrong reason, and every assertion below expects exactly 403.
  assert.ok(alfaToken, 'alfa precisa de um token');
  assert.ok(betaToken, 'beta precisa de um token');
});

after(async () => {
  await stopTestServers();
});

describe('reading a provider out of the host', () => {
  const cases = [
    ['alfa.painel.exemplo.com', 'alfa', 'the panel subdomain'],
    ['alfa.portal.exemplo.com', 'alfa', 'the portal subdomain'],
    ['ALFA.PAINEL.EXEMPLO.COM'.toLowerCase(), 'alfa', 'a host the client upcased'],
    ['painel.exemplo.com', null, 'the deployment\'s own name is not a provider'],
    ['a.b.painel.exemplo.com', null, 'two labels deep is refused rather than guessed'],
    ['alfa.painel.outro.com', null, 'another deployment entirely'],
    ['127.0.0.1', null, 'an address names nobody'],
    ['', null, 'no host at all']
  ];

  for (const [host, expected, why] of cases) {
    it(`${why}: ${host || '(vazio)'}`, () => {
      assert.equal(tenantSlugFromHost(host), expected);
    });
  }
});

describe('a host that names a provider', () => {
  it('serves that provider, not the first row', async () => {
    const alfa = await callAs('alfa.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
    });
    assert.equal(alfa.status, 200);

    // The same credentials on the other provider's host are nobody's.
    const beta = await callAs('beta.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
    });
    assert.equal(beta.status, 401);
  });

  // 404 and not 403: a 403 would confirm the slug exists, and the slug list is
  // the customer list.
  it('answers 404 for a slug nobody has', async () => {
    // Not `/api/health`: that one is mounted AHEAD of the resolver on purpose,
    // so that an unreachable database can still say what is down. It would
    // answer 200 here and prove nothing.
    const { status } = await callAs('gama.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
    });
    assert.equal(status, 404);
  });

  it('answers 404 for a provider that is not active', async () => {
    const { status } = await callAs('parada.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'x', password: 'y' }
    });
    assert.equal(status, 404);
  });

  // Where subdomains are configured, naming the provider is how the deployment
  // works. Falling back to the first row here would answer with one provider's
  // data for a request that asked for nobody.
  it('refuses a host that names no provider at all', async () => {
    const { status } = await callAs('painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
    });
    assert.equal(status, 404);
  });
});

describe('a token replayed on another provider\'s host', () => {
  it('works on the host it was minted for', async () => {
    const { status } = await callAs('alfa.painel.exemplo.com', `${panelUrl}/api/users`, {
      headers: { Authorization: `Bearer ${alfaToken}` }
    });
    assert.equal(status, 200);
  });

  it('is refused on the other provider\'s host', async () => {
    const { status, body } = await callAs('beta.painel.exemplo.com', `${panelUrl}/api/users`, {
      headers: { Authorization: `Bearer ${alfaToken}` }
    });
    assert.equal(status, 403);
    assert.equal(body.code, 'tenant_mismatch');
  });

  it('is refused in the other direction too', async () => {
    const { status } = await callAs('alfa.painel.exemplo.com', `${panelUrl}/api/users`, {
      headers: { Authorization: `Bearer ${betaToken}` }
    });
    assert.equal(status, 403);
  });
});

describe('the subscriber portal on a provider\'s host', () => {
  it('refuses a portal host that names nobody', async () => {
    const { status } = await callAs('portal.exemplo.com', `${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'CSG-0000000-000000', password: 'x' }
    });
    assert.equal(status, 404);
  });

  it('reaches the provider its host names', async () => {
    const { status } = await callAs('alfa.portal.exemplo.com', `${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'CSG-0000000-000000', password: 'errada' }
    });
    // 401 rather than 404: the provider resolved, the credentials did not.
    assert.equal(status, 401);
  });
});

describe('the deployment without subdomains', () => {
  // Every other suite in this repo is this case, and they are what prove it:
  // no base domain, no host names a provider, and the first row answers. The
  // assertion here is only that `call` — which cannot set Host — still works
  // against a server that HAS base domains configured, because 127.0.0.1
  // names nobody and this deployment does.
  it('refuses a request with no provider in its host', async () => {
    const { status } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
    });
    assert.equal(status, 404);
  });
});
