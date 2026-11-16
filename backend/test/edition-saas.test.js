import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The SaaS edition has to be chosen before app.js is imported, because the
// route table is built at module load. Static imports are hoisted above every
// statement in the file, so the harness has to be pulled in dynamically for the
// assignment below to be visible to it — the same reason harness.js itself
// imports the application dynamically. `node --test` gives each file its own
// process, so this does not leak into the other suites.
process.env.EDITION = 'saas';

const { call, startTestServers, stopTestServers } = await import('./helpers/harness.js');

let panelUrl;

before(async () => {
  ({ panelUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
});

describe('saas edition', () => {
  // Switching databases wipes the target before copying into it. On a shared
  // deployment that would destroy every tenant, so the route must not exist at
  // all rather than merely being harder to reach.
  it('does not mount the database management routes', async () => {
    for (const [method, path] of [
      ['GET', '/api/database/config'],
      ['POST', '/api/database/test'],
      ['POST', '/api/database/switch']
    ]) {
      const { status } = await call(`${panelUrl}${path}`, { method });
      assert.equal(status, 404, `${method} ${path} should not be routed`);
    }
  });

  it('still serves the rest of the API', async () => {
    const { status } = await call(`${panelUrl}/api/health`);
    assert.equal(status, 200);
  });

  // A 401 here rather than a 404 is what proves the 404s above come from the
  // edition gate and not from every authenticated route being unreachable.
  it('leaves authenticated routes reachable and merely unauthorized', async () => {
    const { status } = await call(`${panelUrl}/api/settings`);
    assert.equal(status, 401);
  });
});

// Na edição hospedada a primeira conta ganha o plano de controle de todos os
// provedores. Em produção, sem `SETUP_TOKEN`, a instalação pela tela não
// existe — a primeira conta nasce no servidor (`grant-platform-admin.js`).
describe('saas edition, first-run setup in production', () => {
  async function emProducao(env, fn) {
    const antes = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV, SETUP_TOKEN: process.env.SETUP_TOKEN };
    process.env.APP_ENV = 'production';
    process.env.NODE_ENV = 'production';
    if (env.SETUP_TOKEN === undefined) delete process.env.SETUP_TOKEN;
    else process.env.SETUP_TOKEN = env.SETUP_TOKEN;
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(antes)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  const conta = { username: 'primeira', password: 'senha-da-primeira-1', email: 'primeira@exemplo.test' };

  it('without SETUP_TOKEN the setup route answers as nonexistent', async () => {
    await emProducao({}, async () => {
      const { status } = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: conta });
      assert.equal(status, 404);
      const estado = await call(`${panelUrl}/api/auth/setup-status`);
      assert.equal(estado.status, 200);
      assert.equal(estado.body.data.needsSetup, false, 'the screen must not offer the setup');
    });
  });

  it('with SETUP_TOKEN the code is required', async () => {
    await emProducao({ SETUP_TOKEN: 'x'.repeat(32) }, async () => {
      const { status } = await call(`${panelUrl}/api/auth/setup`, {
        method: 'POST', body: { ...conta, setupToken: 'errado' }
      });
      assert.equal(status, 403);
    });
  });
});
