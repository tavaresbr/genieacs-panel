/**
 * O cadastro guiado do número oficial (Embedded Signup): `start` e `complete`.
 *
 * O que esta suíte prende: o `state` é de uso único e vale só para quem o
 * pediu; o `code` é trocado NO SERVIDOR e os ids que vieram do navegador são
 * reconferidos na Graph; número que não é da WABA ou que é de outro provedor é
 * recusado sem criar nada; a coexistência pede cada sincronização UMA vez, grava
 * o `request_id` a cada passo e nunca chama `/register`; e nenhum segredo (token,
 * `code`, segredo do app) volta ao navegador.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  asTenant, authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { setMetaGraphFetcher } = await import('../src/services/metaGraphClient.js');
const { whatsappSignupLimiter } = await import('../src/middleware/rateLimit.js');

const EVO_BASE = 'https://evo-signup.provedor.test';
const META_TOKEN = 'EAAGm0PX4ZCpsBAEmbeddedSignupBusinessToken1234567';
const VERIFY = 'verifica-meta-do-servidor';
const WABA = '123456789012345';
const PHONE = '109876543210987';
const OUTRA_WABA = '222222222222222';
const APP_SECRET = 'segredo-do-app-que-nunca-sai-do-servidor';
const ORIGIN = 'https://painel.provedor.test';
const COEXISTENCIA = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';

let panelUrl;
let token;
let userId;
let evoServer;
const desfazer = [];

/** A Graph falsa: roteia por caminho e guarda o que recebeu. */
const graph = {};
const graphCalls = [];

function resetGraph() {
  graph.exchange = { status: 200, body: { access_token: META_TOKEN, token_type: 'bearer' } };
  graph.phones = { status: 200, body: { data: [{ id: PHONE }] } };
  graph.subscribe = { status: 200, body: { success: true } };
  // `smb_app_data` responde por `sync_type`, para um passo poder falhar sozinho.
  graph.sync = {
    smb_app_state_sync: { status: 200, body: { success: true, request_id: 'req-contatos-1' } },
    history: { status: 200, body: { success: true, request_id: 'req-historico-1' } }
  };
}

function fakeGraph(url, init) {
  const parsed = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  graphCalls.push({
    path: parsed.pathname.replace(/^\/v[\d.]+/, ''),
    query: Object.fromEntries(parsed.searchParams),
    method: init.method,
    auth: init.headers?.Authorization,
    body
  });
  const path = parsed.pathname.replace(/^\/v[\d.]+/, '');
  let reply = { status: 404, body: { error: { message: 'not found', code: 100 } } };
  if (path === '/oauth/access_token') reply = graph.exchange;
  else if (path.endsWith('/phone_numbers')) reply = graph.phones;
  else if (path.endsWith('/subscribed_apps')) reply = graph.subscribe;
  else if (path.endsWith('/smb_app_data')) reply = graph.sync[body?.sync_type];
  else if (/^\/\d+$/.test(path)) reply = { status: 200, body: { id: path.slice(1), quality_rating: 'GREEN' } };
  else if (path.endsWith('/message_templates')) reply = { status: 200, body: { data: [] } };
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function startStub() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const path = req.url.split('?')[0];
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && path === '/') return send(200, { version: '2.3.0' });
      if (path === '/instance/create') {
        return send(201, {
          instance: { instanceName: body.instanceName, instanceId: 'cloud-instance-id', integration: body.integration },
          hash: body.token
        });
      }
      if (path.startsWith('/instance/connectionState/')) return send(200, { instance: { state: 'open' } });
      if (path.startsWith('/instance/delete/')) return send(200, { status: 'SUCCESS' });
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

before(async () => {
  process.env.META_APP_ID = '2151827142378177';
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_WA_CONFIG_ID = '1477066904263675';
  ({ panelUrl } = await startTestServers());
  const v2 = await startStub();
  evoServer = v2.server;
  desfazer.push(rotearBase(EVO_BASE, v2.url));
  setMetaGraphFetcher(async (url, init) => fakeGraph(url, init));

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  userId = setup.body.data.user.id;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    rateLimitPerMin: 60,
    cloudVerifyToken: VERIFY
  }));
});

beforeEach(async () => {
  // O teto é do ato real; cada caso começa com o balde vazio.
  whatsappSignupLimiter.resetKey(`user:${userId}`);
  resetGraph();
  graphCalls.length = 0;
  await asTenant(async () => {
    for (const row of await WhatsAppAccount.getAll()) await WhatsAppAccount.remove(row.id);
  });
});

after(async () => {
  setMetaGraphFetcher(null);
  for (const fn of desfazer) fn?.();
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_WA_CONFIG_ID;
  await new Promise((resolve) => evoServer.close(resolve));
  await stopTestServers();
});

const post = (path, body, headers = authHeaders(token)) => call(`${panelUrl}/api/whatsapp${path}`, {
  method: 'POST', headers, body
});

async function iniciar() {
  const { status, body } = await post('/accounts/embedded-signup/start', { returnOrigin: ORIGIN });
  assert.equal(status, 200, JSON.stringify(body));
  return body.data;
}

async function concluir(over = {}) {
  const { state } = over.state ? { state: over.state } : await iniciar();
  return post('/accounts/embedded-signup/complete', {
    state,
    code: 'codigo-da-meta-30s',
    wabaId: WABA,
    phoneNumberId: PHONE,
    event: 'FINISH',
    baseUrl: EVO_BASE,
    adminKey: 'chave-global',
    label: 'Atendimento',
    ...over
  });
}

describe('start', () => {
  it('entrega appId, configId e um state de uso único, sem o segredo do app', async () => {
    const data = await iniciar();
    assert.equal(data.available, true);
    assert.equal(data.appId, '2151827142378177');
    assert.equal(data.configId, '1477066904263675');
    assert.match(data.state, /^[a-f0-9]{64}$/);
    assert.equal(data.returnOrigin, ORIGIN);
    assert.equal(data.signupUrl, 'https://tr69.com.br/whatsapp-signup.html');
    assert.ok(!JSON.stringify(data).includes(APP_SECRET));
  });

  it('sem o app da Meta configurado responde available:false, e não erro', async () => {
    const guardado = process.env.META_WA_CONFIG_ID;
    delete process.env.META_WA_CONFIG_ID;
    try {
      const { status, body } = await post('/accounts/embedded-signup/start', { returnOrigin: ORIGIN });
      assert.equal(status, 200);
      assert.deepEqual(body.data, { available: false });
    } finally {
      process.env.META_WA_CONFIG_ID = guardado;
    }
  });

  it('recusa origem que não é https (o postMessage não pode ir para "*")', async () => {
    for (const returnOrigin of ['*', 'http://painel.provedor.test', 'javascript:alert(1)', '', undefined]) {
      const { status, body } = await post('/accounts/embedded-signup/start', { returnOrigin });
      assert.equal(status, 400, String(returnOrigin));
      assert.equal(body.code, 'signup_return_origin_invalid');
    }
  });

  it('tem teto por usuário: o 13º pedido no minuto é recusado', async () => {
    let ultimo;
    for (let i = 0; i < 13; i += 1) ultimo = await post('/accounts/embedded-signup/start', { returnOrigin: ORIGIN });
    assert.equal(ultimo.status, 429);
    assert.equal(ultimo.body.code, 'rate_limited');
  });

  it('exige a permissão whatsapp.config', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/accounts/embedded-signup/start`, {
      method: 'POST', body: { returnOrigin: ORIGIN }
    });
    assert.equal(status, 401);
  });
});

describe('complete — número novo', () => {
  it('troca o code no servidor, confere a WABA e cria o número oficial', async () => {
    const { status, body } = await concluir();
    assert.equal(status, 201, JSON.stringify(body));
    const { account } = body.data;
    assert.equal(account.integration, 'cloud');
    assert.equal(account.metaPhoneNumberId, PHONE);
    assert.equal(account.metaWabaId, WABA);
    assert.equal(account.metaOnboarding, 'embedded');
    assert.equal(account.metaCoexistence, false);
    assert.equal(account.metaWebhookStatus, 'ok');

    const troca = graphCalls.find((c) => c.path === '/oauth/access_token');
    assert.equal(troca.query.code, 'codigo-da-meta-30s');
    assert.equal(troca.query.client_secret, APP_SECRET);
    assert.equal(troca.query.client_id, '2151827142378177');
    assert.ok(graphCalls.some((c) => c.path === `/${WABA}/phone_numbers`), 'reconfere o número na WABA');
    assert.ok(graphCalls.every((c) => c.path !== `/${PHONE}/smb_app_data`), 'número novo não sincroniza');

    const row = await asTenant(() => WhatsAppAccount.getById(account.id));
    assert.ok(row.token_ciphertext, 'o token da Meta fica cifrado');
    const texto = JSON.stringify(body);
    for (const segredo of [META_TOKEN, APP_SECRET, 'codigo-da-meta-30s']) {
      assert.ok(!texto.includes(segredo), 'nenhum segredo volta ao navegador');
    }
  });

  it('o state é de uso único', async () => {
    const { state } = await iniciar();
    assert.equal((await concluir({ state })).status, 201);
    const segunda = await concluir({ state });
    assert.equal(segunda.status, 400);
    assert.equal(segunda.body.code, 'signup_state_invalid');
  });

  it('state inventado, malformado ou vencido é recusado antes de falar com a Meta', async () => {
    for (const state of ['', 'abc', 'f'.repeat(64)]) {
      const { status, body } = await concluir({ state: state || undefined });
      assert.equal(status, 400);
      assert.equal(body.code, 'signup_state_invalid');
    }
    const { state } = await iniciar();
    const db = getDb();
    await db('app_state').where('key', 'like', 'wa_signup:%').update({
      value: JSON.stringify({ userId: null, origin: ORIGIN, expiresAt: Date.now() - 1000 })
    });
    const vencido = await concluir({ state });
    assert.equal(vencido.body.code, 'signup_state_invalid');
    assert.equal(graphCalls.length, 0, 'nenhuma chamada à Meta com state ruim');
  });

  it('state de outro usuário não vale', async () => {
    const { state } = await iniciar();
    await getDb()('app_state').where('key', 'like', 'wa_signup:%').update({
      value: JSON.stringify({ userId: '999999', origin: ORIGIN, expiresAt: Date.now() + 60_000 })
    });
    const { status, body } = await concluir({ state });
    assert.equal(status, 400);
    assert.equal(body.code, 'signup_state_invalid');
  });

  it('ids malformados ou evento sem número não chegam à Meta', async () => {
    const casos = [
      { wabaId: '12' }, { phoneNumberId: 'abc' }, { code: 'tem espaco' }, { event: 'FINISH_ONLY_WABA' }, { event: 'CANCEL' }
    ];
    for (const caso of casos) {
      const { status, body } = await concluir(caso);
      assert.equal(status, 400, JSON.stringify(caso));
      assert.equal(body.code, 'invalid_meta_credentials');
    }
    assert.equal(graphCalls.length, 0);
  });

  it('code vencido na Meta vira signup_code_expired e não cria nada', async () => {
    graph.exchange = { status: 400, body: { error: { message: 'Invalid verification code format.', code: 100 } } };
    const { status, body } = await concluir();
    assert.equal(status, 400);
    assert.equal(body.code, 'signup_code_expired');
    assert.equal((await asTenant(() => WhatsAppAccount.getAll())).length, 0);
  });

  it('número que não é da WABA devolvida é recusado, sem criar nada', async () => {
    graph.phones = { status: 200, body: { data: [{ id: '999999999999999' }] } };
    const { status, body } = await concluir({ wabaId: OUTRA_WABA });
    assert.equal(status, 409);
    assert.equal(body.code, 'meta_phone_waba_mismatch');
    assert.equal((await asTenant(() => WhatsAppAccount.getAll())).length, 0);
  });

  it('o mesmo número outra vez reaproveita a conta (token novo), sem duplicar', async () => {
    const primeira = await concluir();
    assert.equal(primeira.status, 201, JSON.stringify(primeira.body));
    const segunda = await concluir();
    assert.equal(segunda.status, 200, JSON.stringify(segunda.body));
    assert.equal(segunda.body.data.reused, true);
    assert.equal(segunda.body.data.account.id, primeira.body.data.account.id);
    assert.equal((await asTenant(() => WhatsAppAccount.getAll())).length, 1);
  });

  it('número já ligado a outro provedor é recusado, e a conta dele não é tocada', async () => {
    const beta = await insertReturningId('tenants', { slug: 'beta-signup', name: 'Provedor Beta', status: 'active' });
    await runInTenant(beta, () => WhatsAppAccount.create({
      name: 'skygp_beta_1',
      purpose: 'support',
      flavor: 'v2',
      integration: 'cloud',
      meta_phone_number_id: PHONE,
      meta_waba_id: WABA,
      base_url: 'https://evo.beta.com.br',
      status: 'connected',
      is_default: true,
      ...WhatsAppConfigService.encryptInstanceToken('token-beta'),
      ...WhatsAppConfigService.encryptWebhookToken('webhook-beta')
    }));
    try {
      const { status, body } = await concluir();
      assert.equal(status, 409, JSON.stringify(body));
      assert.equal(body.code, 'meta_number_in_use');
      assert.equal((await asTenant(() => WhatsAppAccount.getAll())).length, 0, 'nada criado neste provedor');
      const doBeta = await runInTenant(beta, () => WhatsAppAccount.getAll());
      assert.equal(doBeta.length, 1);
      assert.equal(doBeta[0].name, 'skygp_beta_1');
    } finally {
      await runInTenant(beta, async () => {
        for (const row of await WhatsAppAccount.getAll()) await WhatsAppAccount.remove(row.id);
      });
    }
  });
});

describe('complete — coexistência', () => {
  const syncs = () => graphCalls.filter((c) => c.path === `/${PHONE}/smb_app_data`);

  it('pede contatos e depois histórico, uma vez cada, e grava os request_id', async () => {
    const { status, body } = await concluir({ event: COEXISTENCIA });
    assert.equal(status, 201, JSON.stringify(body));
    const { account } = body.data;
    assert.equal(account.metaCoexistence, true);
    assert.equal(account.metaSyncState, 'ok');
    assert.ok(account.metaCoexistenceDeadlineAt);
    assert.deepEqual(syncs().map((c) => c.body.sync_type), ['smb_app_state_sync', 'history']);
    assert.ok(syncs().every((c) => c.body.messaging_product === 'whatsapp'));
    assert.ok(graphCalls.every((c) => !c.path.endsWith('/register')), 'nunca registra: derruba a coexistência');
    assert.ok(!JSON.stringify(body).includes('req-contatos-1'), 'request_id não sai para a tela');

    const row = await asTenant(() => WhatsAppAccount.getById(account.id));
    assert.deepEqual(JSON.parse(row.meta_sync_request_ids), {
      smb_app_state_sync: 'req-contatos-1', history: 'req-historico-1'
    });
  });

  it('recusa no histórico guarda o erro, e "tentar de novo" pede só o que faltou', async () => {
    graph.sync.history = { status: 400, body: { error: { message: 'Throttled', code: 80008 } } };
    const { body } = await concluir({ event: COEXISTENCIA });
    const { account } = body.data;
    assert.equal(account.metaSyncState, 'error');
    assert.match(account.metaSyncError, /^history: \(80008\)/);
    assert.equal(syncs().length, 2);

    graphCalls.length = 0;
    graph.sync.history = { status: 200, body: { success: true, request_id: 'req-historico-2' } };
    const retry = await post(`/accounts/${account.id}/coexistence-sync`, {});
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.data.account.metaSyncState, 'ok');
    assert.deepEqual(syncs().map((c) => c.body.sync_type), ['history'], 'contatos não são pedidos de novo');
  });

  it('já sincronizado, "tentar de novo" não chama a Meta', async () => {
    const { body } = await concluir({ event: COEXISTENCIA });
    graphCalls.length = 0;
    const retry = await post(`/accounts/${body.data.account.id}/coexistence-sync`, {});
    assert.equal(retry.status, 200);
    assert.equal(syncs().length, 0);
  });

  it('passado o prazo de 24 h não pede nada', async () => {
    graph.sync.history = { status: 400, body: { error: { message: 'x', code: 1 } } };
    const { body } = await concluir({ event: COEXISTENCIA });
    const id = body.data.account.id;
    await getDb()('whatsapp_accounts').where({ id }).update({
      meta_coexistence_deadline_at: new Date(Date.now() - 60_000)
    });
    graphCalls.length = 0;
    const retry = await post(`/accounts/${id}/coexistence-sync`, {});
    assert.equal(retry.body.data.account.metaSyncState, 'error');
    assert.equal(retry.body.data.account.metaSyncError, 'coexistence_deadline_passed');
    assert.equal(syncs().length, 0);
  });

  it('número que não é de coexistência responde 409 not_coexistence', async () => {
    const { body } = await concluir();
    const retry = await post(`/accounts/${body.data.account.id}/coexistence-sync`, {});
    assert.equal(retry.status, 409);
    assert.equal(retry.body.code, 'not_coexistence');
  });
});
