/**
 * A ponte de eventos da Meta, fase B1 (modo sombra).
 *
 * O que esta suíte prende: a assinatura é a credencial (sem ela, 401 e nada é
 * lido nem encaminhado); o que chega ao Evolution é o que a Meta mandou, BYTE A
 * BYTE e com a assinatura original (é isso que faz ligar a ponte não mudar nada
 * que o painel grava); uma entrega que se parte entre destinos é remontada e
 * assinada de novo; o Evolution que recusa, demora ou some vira 500 (a Meta
 * reenvia) e número desconhecido vira 200 (a Meta não desativa o callback); cada
 * provedor só aparece nos metadados do próprio; e a medida nunca guarda o corpo.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'segredo-do-app-da-plataforma-meta-bridge';
const VERIFY = 'verifica-da-ponte';
process.env.META_WA_BRIDGE = '1';
process.env.META_APP_SECRET = SECRET;
process.env.META_WA_VERIFY_TOKEN = VERIFY;
process.env.PUBLIC_BASE_URL = 'https://painel.provedor.test';
process.env.META_WA_BRIDGE_FORWARD_TIMEOUT_MS = '400';

const {
  asTenant, authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { rotearEvolution } = await import('./helpers/evolutionRoute.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { resetPurgeThrottle } = await import('../src/services/metaBridgeService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { setMetaGraphFetcher } = await import('../src/services/metaGraphClient.js');
const { whatsappSignupLimiter } = await import('../src/middleware/rateLimit.js');

const EVO_A = 'https://evo-a.provedor.test';
const EVO_B = 'https://evo-b.provedor.test';
const EVO_DEAD = 'https://evo-morto.provedor.test';
const PHONE_A = '109876543210001';
const PHONE_B = '109876543210002';
const PHONE_BETA = '109876543210003';
const WABA_A = '200000000000001';
const WABA_B = '200000000000002';
const WABA_BETA = '200000000000003';
const META_TOKEN = 'EAAGm0PX4ZCpsBAEmbeddedSignupBusinessToken1234567';
const CLOUD_VERIFY = 'verifica-meta-do-evolution';

let panelUrl;
let userToken;
let userId;
let desfazer;
const stubs = {};
const graphCalls = [];
const graph = { status: 200, body: { success: true } };
const ids = {};

/** Um Evolution de mentira: guarda o que recebe e responde como mandado. */
function startStub(name) {
  const received = [];
  const behavior = { status: 200, delayMs: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      setTimeout(() => {
        res.writeHead(behavior.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success' }));
      }, behavior.delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      stubs[name] = { server, received, behavior, url: `http://127.0.0.1:${server.address().port}` };
      resolve();
    });
  });
}

const sign = (raw) => `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;

/** Um corpo de entrega da Meta com as mudanças dadas: `[wabaId, field, phoneNumberId?, value?]`. */
function delivery(...entries) {
  return {
    object: 'whatsapp_business_account',
    entry: entries.map(([waba, changes]) => ({
      id: waba,
      time: 1_700_000_000,
      changes: changes.map(([field, phone, extra = {}]) => ({
        field,
        value: { messaging_product: 'whatsapp', ...(phone ? { metadata: { display_phone_number: '551199999999', phone_number_id: phone } } : {}), ...extra }
      }))
    }))
  };
}

const textMessage = { messages: [{ from: '5511988887777', id: 'wamid.SEGREDO-DO-TEXTO', type: 'text', text: { body: 'texto do cliente que não pode ser guardado' } }] };

async function post(rawOrObject, { signature, headers = {} } = {}) {
  const raw = Buffer.isBuffer(rawOrObject) ? rawOrObject : Buffer.from(JSON.stringify(rawOrObject), 'utf8');
  const res = await fetch(`${panelUrl}/api/meta-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature ?? sign(raw), ...headers },
    body: raw
  });
  return { status: res.status, body: await res.json().catch(() => null), raw };
}

const events = () => getDb()('wa_meta_events').orderBy('id');

async function seedAccount({ tenantId = null, name, phone, waba, base, embedded = true, bridge = false, integration = 'cloud' }) {
  const create = () => WhatsAppAccount.create({
    name,
    purpose: 'support',
    flavor: 'v2',
    integration,
    meta_phone_number_id: integration === 'cloud' ? phone : null,
    meta_waba_id: integration === 'cloud' ? waba : null,
    meta_onboarding: embedded ? 'embedded' : 'manual',
    meta_bridge: bridge,
    base_url: base,
    status: 'connected',
    is_default: false,
    ...WhatsAppConfigService.encryptInstanceToken(META_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken(`webhook-${name}`)
  });
  return tenantId ? runInTenant(tenantId, create) : asTenant(create);
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  await Promise.all(['a', 'b'].map(startStub));
  desfazer = rotearEvolution((url) => {
    const target = { [new URL(EVO_A).origin]: 'a', [new URL(EVO_B).origin]: 'b' }[url.origin];
    return target ? `${stubs[target].url}${url.pathname}${url.search}` : null;
  });
  setMetaGraphFetcher(async (url, init) => {
    graphCalls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(graph.body), { status: graph.status, headers: { 'Content-Type': 'application/json' } });
  });

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  userToken = setup.body.data.token;
  userId = setup.body.data.user.id;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    rateLimitPerMin: 60,
    cloudVerifyToken: CLOUD_VERIFY
  }));

  ids.a = (await seedAccount({ name: 'skygp_bridge_a', phone: PHONE_A, waba: WABA_A, base: EVO_A })).id;
  ids.b = (await seedAccount({ name: 'skygp_bridge_b', phone: PHONE_B, waba: WABA_B, base: EVO_B })).id;
  ids.manual = (await seedAccount({ name: 'skygp_bridge_manual', phone: '109876543210009', waba: '200000000000009', base: EVO_A, embedded: false })).id;
  ids.qr = (await seedAccount({ name: 'skygp_bridge_qr', base: EVO_A, integration: 'baileys' })).id;

  const beta = await insertReturningId('tenants', { slug: 'beta-bridge', name: 'Provedor Beta', status: 'active' });
  ids.betaTenant = beta;
  ids.beta = (await seedAccount({ tenantId: beta, name: 'skygp_bridge_beta', phone: PHONE_BETA, waba: WABA_BETA, base: EVO_A })).id;
});

beforeEach(async () => {
  for (const stub of Object.values(stubs)) {
    stub.received.length = 0;
    stub.behavior.status = 200;
    stub.behavior.delayMs = 0;
  }
  graphCalls.length = 0;
  graph.status = 200;
  graph.body = { success: true };
  process.env.META_WA_BRIDGE = '1';
  whatsappSignupLimiter.resetKey(`user:${userId}`);
  await getDb()('wa_meta_events').del();
});

after(async () => {
  setMetaGraphFetcher(null);
  desfazer?.();
  for (const stub of Object.values(stubs)) await new Promise((resolve) => stub.server.close(resolve));
  await stopTestServers();
});

describe('GET /api/meta-webhook (verificação do callback)', () => {
  const verify = (query) => fetch(`${panelUrl}/api/meta-webhook?${new URLSearchParams(query)}`);

  it('devolve o desafio numérico quando o token da ponte bate', async () => {
    const res = await verify({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1158201444' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '1158201444');
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
  });

  it('recusa token errado e o token do Evolution, que não é o desta rota', async () => {
    for (const token of ['errado', CLOUD_VERIFY, '']) {
      const res = await verify({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '1' });
      assert.equal(res.status, 403, token);
    }
  });

  it('não reflete um desafio que não é número', async () => {
    const res = await verify({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '<script>alert(1)</script>' });
    assert.equal(res.status, 400);
    assert.ok(!(await res.text()).includes('<script>'));
  });

  it('desligada, responde 404 como se a rota não existisse', async () => {
    process.env.META_WA_BRIDGE = '0';
    const res = await verify({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1' });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/meta-webhook — autenticação', () => {
  it('sem assinatura ou com assinatura de outro corpo: 401, nada encaminhado, nada gravado', async () => {
    const body = delivery([WABA_A, [['messages', PHONE_A, textMessage]]]);
    const raw = Buffer.from(JSON.stringify(body));
    for (const signature of ['', 'sha256=' + '0'.repeat(64), sign(Buffer.from('{}')), 'lixo']) {
      const res = await post(raw, { signature });
      assert.equal(res.status, 401, signature);
    }
    assert.equal(stubs.a.received.length, 0);
    assert.equal((await events()).length, 0);
  });

  it('assinatura boa mas desligada ou sem segredo: 404', async () => {
    process.env.META_WA_BRIDGE = '0';
    const res = await post(delivery([WABA_A, [['messages', PHONE_A, textMessage]]]));
    assert.equal(res.status, 404);
    assert.equal(stubs.a.received.length, 0);
  });
});

describe('POST /api/meta-webhook — o encaminhamento (modo sombra)', () => {
  it('entrega ao Evolution do número o corpo ORIGINAL, byte a byte, com a assinatura original', async () => {
    // Espaços e ordem de chaves esquisitos de propósito: reserializar mudaria os bytes.
    const raw = Buffer.from(
      `{ "object":"whatsapp_business_account",\n "entry":[ {"id":"${WABA_A}","changes":[ {"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"${PHONE_A}"},"messages":[{"id":"wamid.X","from":"5511988887777","type":"text","text":{"body":"oi"}}]}} ]} ] }`,
      'utf8'
    );
    const res = await post(raw);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.forwarded, 1);

    assert.equal(stubs.a.received.length, 1);
    const [got] = stubs.a.received;
    assert.equal(got.method, 'POST');
    assert.equal(got.url, '/webhook/meta');
    assert.ok(got.body.equals(raw), 'os bytes são os mesmos');
    assert.equal(got.headers['x-hub-signature-256'], sign(raw), 'a assinatura é a original');
    assert.match(got.headers['content-type'], /application\/json/);
    assert.equal(stubs.b.received.length, 0, 'o Evolution do outro número não recebe nada');
  });

  it('em modo sombra os campos que o painel ainda não trata também vão ao Evolution, como hoje', async () => {
    const body = delivery([WABA_A, [
      ['smb_message_echoes', PHONE_A, { message_echoes: [{ from: PHONE_A, to: '5511988887777', id: 'wamid.E', type: 'text', text: { body: 'x' } }] }],
      ['history', PHONE_A, { history: [] }],
      ['smb_app_state_sync', PHONE_A, { state_sync: [] }]
    ]]);
    const res = await post(body);
    assert.equal(res.status, 200);
    assert.ok(stubs.a.received[0].body.equals(res.raw));
    const [event] = await events();
    assert.equal(event.fields, 'smb_message_echoes,history,smb_app_state_sync');
    assert.equal(event.changes, 3);
  });

  it('account_update não traz o número: o provedor sai da WABA da entrada', async () => {
    const res = await post(delivery([WABA_A, [['account_update', null, { event: 'ACCOUNT_OFFBOARDED' }]]]));
    assert.equal(res.status, 200);
    assert.equal(stubs.a.received.length, 1);
    assert.equal(stubs.b.received.length, 0);
  });

  it('uma entrega que se parte entre dois Evolutions é remontada, e cada parte leva só o seu e é assinada de novo', async () => {
    const body = delivery(
      [WABA_A, [['messages', PHONE_A, textMessage]]],
      [WABA_B, [['messages', PHONE_B, textMessage], ['statuses', PHONE_B, { statuses: [] }]]]
    );
    const res = await post(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.forwarded, 2);

    const partA = stubs.a.received[0];
    const partB = stubs.b.received[0];
    const jsonA = JSON.parse(partA.body.toString());
    const jsonB = JSON.parse(partB.body.toString());
    assert.equal(jsonA.object, 'whatsapp_business_account');
    assert.deepEqual(jsonA.entry.map((e) => e.id), [WABA_A]);
    assert.deepEqual(jsonB.entry.map((e) => e.id), [WABA_B]);
    assert.equal(jsonB.entry[0].changes.length, 2);
    // A assinatura da Meta cobria o corpo inteiro; o remontado só vale se for assinado de novo.
    assert.equal(partA.headers['x-hub-signature-256'], sign(partA.body));
    assert.equal(partB.headers['x-hub-signature-256'], sign(partB.body));
    assert.notEqual(partA.headers['x-hub-signature-256'], sign(res.raw));
    assert.equal((await events()).length, 2);
  });

  it('número desconhecido: 200 e nada encaminhado (a Meta não pode desativar o callback)', async () => {
    const res = await post(delivery(['299999999999999', [['messages', '109999999999999', textMessage]]]));
    assert.equal(res.status, 200);
    assert.equal(res.body.skipped, 'unknown_account');
    assert.equal(stubs.a.received.length + stubs.b.received.length, 0);
    assert.equal((await events()).length, 0);
  });

  it('conhecido e desconhecido na mesma entrega: só o conhecido é entregue, e a resposta conta o outro', async () => {
    const res = await post(delivery(
      [WABA_A, [['messages', PHONE_A, textMessage]]],
      ['299999999999999', [['messages', '109999999999999', textMessage]]]
    ));
    assert.equal(res.status, 200);
    assert.equal(res.body.unknown, 1);
    const sent = JSON.parse(stubs.a.received[0].body.toString());
    assert.deepEqual(sent.entry.map((e) => e.id), [WABA_A]);
    assert.equal(stubs.a.received[0].headers['x-hub-signature-256'], sign(stubs.a.received[0].body));
  });

  it('corpo assinado que não é JSON, ou não é de uma conta do WhatsApp Business: 200 e nada a fazer', async () => {
    assert.deepEqual((await post(Buffer.from('isto não é json'))).body, { success: true, skipped: 'invalid_json' });
    assert.equal((await post({ object: 'page', entry: [] })).body.skipped, 'no_changes');
    assert.equal((await post({ object: 'whatsapp_business_account', entry: [{ id: WABA_A }] })).body.skipped, 'no_changes');
    assert.equal(stubs.a.received.length, 0);
  });
});

describe('POST /api/meta-webhook — quando o Evolution não aceita', () => {
  it('recusa (5xx): 500, para a Meta reenviar, e a falha fica nos metadados', async () => {
    stubs.a.behavior.status = 502;
    const res = await post(delivery([WABA_A, [['messages', PHONE_A, textMessage]]]));
    assert.equal(res.status, 500);
    assert.equal(res.body.failed, 1);
    const [event] = await events();
    assert.equal(event.forward_status, 'failed');
    assert.equal(event.forward_http, 502);
    assert.equal(event.forward_error, 'http_502');
  });

  it('demora além do prazo: 500 com motivo timeout', async () => {
    stubs.a.behavior.delayMs = 1500;
    const started = Date.now();
    const res = await post(delivery([WABA_A, [['messages', PHONE_A, textMessage]]]));
    assert.equal(res.status, 500);
    assert.ok(Date.now() - started < 1400, 'não esperou a resposta lenta');
    assert.equal((await events())[0].forward_error, 'timeout');
  });

  it('endereço do Evolution que o painel não pode usar (http, sem TLS): 500 com o motivo fixo, sem chamar ninguém', async () => {
    await asTenant(() => WhatsAppAccount.update(ids.a, { base_url: 'http://evo-a.provedor.test' }));
    try {
      const res = await post(delivery([WABA_A, [['messages', PHONE_A, textMessage]]]));
      assert.equal(res.status, 500);
      assert.equal((await events())[0].forward_error, 'insecure_base_url');
      assert.equal(stubs.a.received.length, 0);
    } finally {
      await asTenant(() => WhatsAppAccount.update(ids.a, { base_url: EVO_A }));
    }
  });

  it('uma das duas partes falha: 500 (a Meta reenvia o corpo todo), e a que deu certo fica registrada', async () => {
    stubs.b.behavior.status = 500;
    const res = await post(delivery(
      [WABA_A, [['messages', PHONE_A, textMessage]]],
      [WABA_B, [['messages', PHONE_B, textMessage]]]
    ));
    assert.equal(res.status, 500);
    assert.equal(res.body.forwarded, 1);
    assert.equal(res.body.failed, 1);
    assert.deepEqual((await events()).map((e) => e.forward_status).sort(), ['failed', 'ok']);
  });
});

describe('os metadados da ponte', () => {
  it('guardam quando, que campos, quanto e o resultado — e NUNCA o texto nem o telefone', async () => {
    const res = await post(delivery([WABA_A, [['messages', PHONE_A, textMessage]]]));
    assert.equal(res.status, 200);
    const [event] = await events();
    assert.equal(event.account_id, ids.a);
    assert.equal(event.fields, 'messages');
    assert.equal(event.changes, 1);
    assert.equal(event.bytes, res.raw.length);
    assert.equal(event.forward_status, 'ok');
    assert.equal(event.forward_http, 200);
    assert.ok(event.forward_ms >= 0);
    const dump = JSON.stringify(event);
    for (const segredo of ['texto do cliente', '5511988887777', 'wamid.SEGREDO']) {
      assert.ok(!dump.includes(segredo), `a linha não guarda "${segredo}"`);
    }
  });

  it('cada provedor aparece só nos metadados do próprio', async () => {
    // A conta do Beta aponta para o mesmo Evolution de teste; o que importa é o tenant da linha.
    const res = await post(delivery([WABA_BETA, [['messages', PHONE_BETA, textMessage]]]));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [event] = await events();
    assert.equal(event.tenant_id, ids.betaTenant);
    assert.equal(event.account_id, ids.beta);
    const mine = await asTenant(() => getDb()('wa_meta_events').where({ tenant_id: 1 }));
    assert.equal(mine.length, 0, 'o provedor #1 não tem linha desta entrega');
  });

  it('apaga o que passou de 14 dias na próxima gravação', async () => {
    resetPurgeThrottle(); // a poda vale uma vez por hora por provedor; este teste a quer agora
    const old = new Date(Date.now() - 20 * 86_400_000);
    await getDb()('wa_meta_events').insert({
      tenant_id: ids.betaTenant, account_id: ids.beta, fields: 'messages', changes: 1, bytes: 10, forward_status: 'ok', received_at: old
    });
    await post(delivery([WABA_BETA, [['messages', PHONE_BETA, textMessage]]]));
    const rows = await events();
    assert.equal(rows.length, 1, 'só a recente ficou');
    assert.ok(new Date(rows[0].received_at) > old);
  });

  it('a saúde mostra, por número ligado, a última entrega e quantas o Evolution aceitou ou recusou', async () => {
    await asTenant(() => WhatsAppAccount.update(ids.a, { meta_bridge: true }));
    try {
      await post(delivery([WABA_A, [['messages', PHONE_A, textMessage]]]));
      await post(delivery([WABA_A, [['messages', PHONE_A, textMessage]]]));
      stubs.a.behavior.status = 500;
      await post(delivery([WABA_A, [['messages', PHONE_A, textMessage]]]));

      const { status, body } = await call(`${panelUrl}/api/whatsapp/health`, { headers: authHeaders(userToken) });
      assert.equal(status, 200);
      const bridge = body.data.metaBridge;
      assert.equal(bridge.enabled, 1);
      assert.equal(bridge.ok24h, 2);
      assert.equal(bridge.failed24h, 1);
      assert.ok(bridge.lastEventAt);
      assert.deepEqual(bridge.accounts.map((a) => [a.id, a.ok, a.failed]), [[ids.a, 2, 1]]);
    } finally {
      await asTenant(() => WhatsAppAccount.update(ids.a, { meta_bridge: false }));
    }
  });

  it('sem número ligado, a saúde diz zero', async () => {
    const { body } = await call(`${panelUrl}/api/whatsapp/health`, { headers: authHeaders(userToken) });
    assert.deepEqual(body.data.metaBridge, { enabled: 0, ok24h: 0, failed24h: 0, lastEventAt: null, accounts: [] });
  });
});

describe('POST /api/whatsapp/accounts/:id/meta-bridge (liga e desliga por número)', () => {
  const toggle = (id, body) => call(`${panelUrl}/api/whatsapp/accounts/${id}/meta-bridge`, {
    method: 'POST', headers: authHeaders(userToken), body
  });
  const subscribe = () => graphCalls.filter((c) => c.url.endsWith('/subscribed_apps'));

  it('ligar registra na Meta o callback DO PAINEL e o token da ponte, e marca o número', async () => {
    const res = await toggle(ids.a, { enabled: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.account.metaBridge, true);
    assert.ok(res.body.data.account.metaBridgeAt);
    assert.equal(res.body.data.account.metaWebhookStatus, 'ok');
    assert.equal(subscribe().length, 1);
    assert.equal(subscribe()[0].url.includes(`/${WABA_A}/subscribed_apps`), true);
    assert.deepEqual(subscribe()[0].body, {
      override_callback_uri: 'https://painel.provedor.test/api/meta-webhook',
      verify_token: VERIFY
    });
    assert.equal(subscribe()[0].init.headers.Authorization, `Bearer ${META_TOKEN}`);
    assert.ok(!JSON.stringify(res.body).includes(VERIFY), 'o token da ponte não sai para a tela');
  });

  it('"registrar de novo" respeita a escolha: um número ligado continua apontando para o painel', async () => {
    await toggle(ids.a, { enabled: true });
    graphCalls.length = 0;
    const again = await call(`${panelUrl}/api/whatsapp/accounts/${ids.a}/meta-webhook`, { method: 'POST', headers: authHeaders(userToken) });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(subscribe()[0].body.override_callback_uri, 'https://painel.provedor.test/api/meta-webhook');
  });

  it('desligar devolve o callback ao Evolution, com o token de verificação dele', async () => {
    await toggle(ids.a, { enabled: true });
    graphCalls.length = 0;
    const res = await toggle(ids.a, { enabled: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.account.metaBridge, false);
    assert.deepEqual(subscribe()[0].body, { override_callback_uri: `${EVO_A}/webhook/meta`, verify_token: CLOUD_VERIFY });
  });

  it('a Meta recusando o registro: 502, e o número NÃO muda de lado', async () => {
    graph.status = 400;
    graph.body = { error: { message: 'Callback verification failed', code: 2200 } };
    const res = await toggle(ids.b, { enabled: true });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'meta_webhook_failed');
    const row = await asTenant(() => WhatsAppAccount.getById(ids.b));
    assert.equal(Boolean(row.meta_bridge), false);
  });

  it('recusas que não falam com a Meta: número por QR, cadastro manual, ponte sem configuração, corpo inválido', async () => {
    assert.equal((await toggle(ids.qr, { enabled: true })).body.code, 'not_cloud');
    const manual = await toggle(ids.manual, { enabled: true });
    assert.equal(manual.status, 409);
    assert.equal(manual.body.code, 'meta_bridge_requires_embedded');

    process.env.META_WA_BRIDGE = '0';
    const off = await toggle(ids.a, { enabled: true });
    assert.equal(off.status, 409);
    assert.equal(off.body.code, 'meta_bridge_unconfigured');
    process.env.META_WA_BRIDGE = '1';

    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, []]) {
      const bad = await toggle(ids.a, body);
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal(bad.body.code, 'meta_bridge_invalid');
    }
    assert.equal(graphCalls.length, 0, 'nenhuma recusa chegou à Meta');
  });

  it('o número de outro provedor é 404, e exige whatsapp.config', async () => {
    assert.equal((await toggle(ids.beta, { enabled: true })).status, 404);
    const anon = await call(`${panelUrl}/api/whatsapp/accounts/${ids.a}/meta-bridge`, { method: 'POST', body: { enabled: true } });
    assert.equal(anon.status, 401);
  });
});
