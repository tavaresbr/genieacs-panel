import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

process.env.META_APP_SECRET = 'segredo-do-app-meta';
process.env.MESSENGER_VERIFY_TOKEN = 'token-de-verificacao';
process.env.META_APP_ID = '1234567890';

const { setMetaGraphFetcher } = await import('../src/services/metaGraphClient.js');
const { decryptPageToken, encryptPageToken } = await import('../src/services/messengerPageService.js');

let panelUrl;
let token;
let alfa;
const api = (p, options = {}) => call(`${panelUrl}/api/messenger${p}`, { headers: authHeaders(token), ...options });
const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
const calls = [];

/** A Graph falsa: troca de token, lista de Páginas e o que a conexão já usa. */
function graph({ exchange = () => ok({ access_token: 'LONGA' }), accounts } = {}) {
  setMetaGraphFetcher(async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method, auth: init?.headers?.Authorization });
    if (u.includes('/oauth/access_token')) return exchange(u);
    if (u.includes('/me/accounts')) return ok(accounts ?? {
      data: [
        { id: '7000000007', name: 'Página Sete', access_token: 'PT-SETE' },
        { id: '7000000008', name: 'Página Oito', access_token: 'PT-OITO' },
        { id: '7000000009', name: 'Já conectada', access_token: 'PT-NOVE' }
      ]
    });
    if (/\/v[\d.]+\/me\?/.test(u)) return ok({ id: '5550001' });
    if (u.includes('/subscribed_apps')) return ok({ success: true });
    const id = u.match(/\/v[\d.]+\/(\d+)/)?.[1];
    return ok({ id, name: `Página ${id}` });
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  await getDb()('messenger_pages').insert({
    tenant_id: alfa, page_id: '7000000009', page_name: 'Já conectada', page_token: encryptPageToken('x'), status: 'connected'
  });
});
after(async () => {
  setMetaGraphFetcher(null);
  await stopTestServers();
});

describe('login do Facebook', () => {
  it('o status diz que o login está pronto e qual é o app', async () => {
    const res = await api('/status');
    assert.deepEqual(res.body.data.facebookLogin, { available: true, appId: '1234567890' });
  });

  it('lista as Páginas do usuário sem nenhum token, marcando a que já está conectada', async () => {
    calls.length = 0;
    graph();
    const res = await api('/facebook/pages', { method: 'POST', body: { userToken: 'CURTA' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, [
      { id: '7000000007', name: 'Página Sete', connected: false },
      { id: '7000000008', name: 'Página Oito', connected: false },
      { id: '7000000009', name: 'Já conectada', connected: true }
    ]);
    const text = JSON.stringify(res.body);
    for (const secret of ['PT-SETE', 'PT-OITO', 'LONGA', 'CURTA']) assert.ok(!text.includes(secret));
    const exchange = calls.find((c) => c.url.includes('/oauth/access_token'));
    assert.match(exchange.url, /grant_type=fb_exchange_token/);
    assert.match(exchange.url, /client_id=1234567890/);
    assert.match(exchange.url, /fb_exchange_token=CURTA/);
    // As Páginas são lidas com o token de longa duração.
    assert.equal(calls.find((c) => c.url.includes('/me/accounts')).auth, 'Bearer LONGA');
  });

  it('conecta a escolhida com o token que a Meta deu para a Página', async () => {
    graph();
    const res = await api('/facebook/connect', { method: 'POST', body: { userToken: 'CURTA', pageId: '7000000007' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'connected');
    assert.equal(res.body.data.pageName, 'Página 7000000007');
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('PT-SETE') && !text.includes('LONGA'));
    const row = await getDb()('messenger_pages').where({ page_id: '7000000007' }).first();
    assert.equal(decryptPageToken(row.page_token), 'PT-SETE');
    assert.ok(row.subscribed_at);
    assert.equal(row.facebook_user_id, '5550001', 'guarda quem conectou, para os avisos da Meta');
  });

  it('não conecta Página que o usuário não administra', async () => {
    graph();
    const res = await api('/facebook/connect', { method: 'POST', body: { userToken: 'CURTA', pageId: '7999999999' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'page_not_administered');
    assert.equal(await getDb()('messenger_pages').where({ page_id: '7999999999' }).first(), undefined);
  });

  it('recusa Página já conectada', async () => {
    graph();
    const res = await api('/facebook/connect', { method: 'POST', body: { userToken: 'CURTA', pageId: '7000000009' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'page_already_connected');
  });

  it('confere o token e o id antes de falar com a Meta', async () => {
    calls.length = 0;
    graph();
    assert.equal((await api('/facebook/pages', { method: 'POST', body: {} })).body.code, 'missing_token');
    assert.equal((await api('/facebook/pages', { method: 'POST', body: { userToken: 'com espaço' } })).body.code, 'invalid_token');
    assert.equal((await api('/facebook/pages', { method: 'POST', body: { userToken: 'x'.repeat(2000) } })).body.code, 'invalid_token');
    assert.equal((await api('/facebook/connect', { method: 'POST', body: { userToken: 'CURTA', pageId: 'abc' } })).body.code, 'invalid_page_id');
    assert.equal(calls.length, 0);
  });

  it('devolve a recusa da Meta na troca do token', async () => {
    graph({ exchange: () => new Response(JSON.stringify({ error: { code: 190, message: 'expirou' } }), { status: 400 }) });
    const res = await api('/facebook/pages', { method: 'POST', body: { userToken: 'VELHA' } });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'meta_refused');
  });

  it('sem META_APP_ID o login fica indisponível', async () => {
    const saved = process.env.META_APP_ID;
    delete process.env.META_APP_ID;
    try {
      calls.length = 0;
      graph();
      assert.deepEqual((await api('/status')).body.data.facebookLogin, { available: false, appId: '' });
      const res = await api('/facebook/pages', { method: 'POST', body: { userToken: 'CURTA' } });
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'facebook_login_unconfigured');
      assert.equal(calls.length, 0);
    } finally {
      process.env.META_APP_ID = saved;
    }
  });
});
