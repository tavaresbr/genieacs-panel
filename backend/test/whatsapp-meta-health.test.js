/**
 * A saúde do número oficial na Meta (`GET /{phone_number_id}`): a nota de
 * qualidade, o limite diário, o nome verificado e o status, gravados na linha
 * de hora em hora e no botão "Atualizar".
 *
 * O que este arquivo guarda: a consulta pede os campos certos com o token só
 * no cabeçalho, a resposta vai para a linha e para a tela, uma falha grava o
 * erro sem apagar a última leitura boa, o botão não alcança o número de outro
 * provedor nem o número por QR, e a queda de qualidade ou de limite avisa a
 * equipe pelos canais dos alertas técnicos — uma vez, e nunca na primeira
 * consulta.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  asTenant, authHeaders, call, defaultTenantId, getDb, insertReturningId, startTestServers, stopTestServers
} from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { setMetaGraphFetcher, META_GRAPH_VERSION } = await import('../src/services/metaGraphClient.js');
const {
  default: MetaNumberHealthService, degradation, parseNumberHealth
} = await import('../src/services/metaNumberHealthService.js');

const EVO_BASE = 'https://evo-saude.provedor.test';
const META_TOKEN = 'EAAGm0PX4ZCpsBAMetaTokenDaSaude1234567890';
const PHONE_ID = '109876543219999';
const WABA = '123456789019999';

let panelUrl;
let token;
let evoServer;
const desfazer = [];

/** A Graph falsa: a saúde que ela responde e o que recebeu. */
const graph = { status: 200, body: null, throws: false };
const healthCalls = [];
/** O que os alertas teriam mandado. */
const entregues = [];
const deliverOriginal = WaAlertService.deliver;

const SAUDAVEL = {
  id: PHONE_ID,
  quality_rating: 'GREEN',
  messaging_limit_tier: 'TIER_1K',
  throughput: { level: 'STANDARD' },
  verified_name: 'Provedor Fibra',
  display_phone_number: '+55 11 99999-0000',
  name_status: 'APPROVED',
  status: 'CONNECTED'
};

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
          instance: { instanceName: body.instanceName, instanceId: 'cloud-saude-id', integration: body.integration },
          hash: body.token
        });
      }
      if (path.startsWith('/instance/connectionState/')) return send(200, { instance: { state: 'open' } });
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const v2 = await startStub();
  evoServer = v2.server;
  desfazer.push(rotearBase(EVO_BASE, v2.url));

  setMetaGraphFetcher(async (url, init) => {
    // O registro do webhook, na criação do número, sempre aceito.
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    healthCalls.push({ url, init });
    if (graph.throws) throw new Error(`connect ECONNREFUSED ${url}`);
    return new Response(JSON.stringify(graph.body), {
      status: graph.status,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  WaAlertService.deliver = async (_channels, body) => {
    entregues.push(body);
    return 1;
  };

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    rateLimitPerMin: 60,
    cloudVerifyToken: 'verifica-saude'
  }));
  // Alertas ligados com o Telegram: um canal pronto sem número de WhatsApp.
  await asTenant(() => WaAlertService.saveSettings({
    enabled: true,
    telegram: { botToken: `123456:${'a'.repeat(35)}`, chatId: '-100123' }
  }));
});

beforeEach(() => {
  graph.status = 200;
  graph.body = { ...SAUDAVEL };
  graph.throws = false;
  healthCalls.length = 0;
  entregues.length = 0;
});

after(async () => {
  setMetaGraphFetcher(null);
  WaAlertService.deliver = deliverOriginal;
  for (const fn of desfazer) fn?.();
  await new Promise((resolve) => evoServer.close(resolve));
  await stopTestServers();
});

async function createCloud(label) {
  const r = await call(`${panelUrl}/api/whatsapp/accounts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: {
      kind: 'cloud',
      baseUrl: EVO_BASE,
      adminKey: 'chave-global',
      label,
      metaToken: META_TOKEN,
      phoneNumberId: PHONE_ID,
      wabaId: WABA
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.account;
}

const atualizar = (id) => call(`${panelUrl}/api/whatsapp/accounts/${id}/meta-health`, {
  method: 'POST', headers: authHeaders(token)
});

describe('consultar a saúde do número', () => {
  it('pede os campos certos, com o token só no cabeçalho, e grava na linha', async () => {
    const account = await createCloud('Saúde');
    const r = await atualizar(account.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(healthCalls.length, 1);
    const [chamada] = healthCalls;
    const url = new URL(chamada.url);
    assert.equal(`${url.origin}${url.pathname}`, `https://graph.facebook.com/${META_GRAPH_VERSION}/${PHONE_ID}`);
    assert.equal(
      url.searchParams.get('fields'),
      'quality_rating,messaging_limit_tier,throughput,verified_name,display_phone_number,name_status,status'
    );
    assert.equal(chamada.init.method, 'GET');
    assert.equal(chamada.init.headers.Authorization, `Bearer ${META_TOKEN}`);
    assert.ok(!chamada.url.includes(META_TOKEN), 'o token não vai na URL');

    const pub = r.body.data.account;
    assert.equal(pub.metaQualityRating, 'GREEN');
    assert.equal(pub.metaMessagingLimit, 'TIER_1K');
    assert.equal(pub.metaVerifiedName, 'Provedor Fibra');
    assert.equal(pub.metaDisplayPhone, '+55 11 99999-0000');
    assert.equal(pub.metaNameStatus, 'APPROVED');
    assert.equal(pub.metaNumberStatus, 'CONNECTED');
    assert.equal(pub.metaThroughput, 'STANDARD');
    assert.equal(pub.metaHealthError, null);
    assert.ok(pub.metaHealthAt);
    // A primeira leitura não é queda de nada.
    assert.equal(entregues.length, 0);
  });

  it('recusa da Meta é 502 e grava o erro sem apagar a última leitura boa', async () => {
    const account = await createCloud('Recusa');
    await atualizar(account.id);
    graph.status = 400;
    graph.body = { error: { message: 'Invalid OAuth access token', code: 190 } };
    const r = await atualizar(account.id);
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'meta_health_failed');
    const row = await asTenant(() => WhatsAppAccount.getById(account.id));
    assert.equal(row.meta_health_error, '(190) Invalid OAuth access token');
    assert.equal(row.meta_quality_rating, 'GREEN');
    assert.equal(row.meta_messaging_limit, 'TIER_1K');
  });

  it('Meta fora do ar vira meta_unreachable, sem a exceção do fetch', async () => {
    const account = await createCloud('Sem rede');
    graph.throws = true;
    const r = await atualizar(account.id);
    assert.equal(r.status, 502);
    const row = await asTenant(() => WhatsAppAccount.getById(account.id));
    assert.equal(row.meta_health_error, 'meta_unreachable');
    assert.ok(!JSON.stringify(r.body).includes('graph.facebook.com'));
    assert.ok(!JSON.stringify(r.body).includes(META_TOKEN));
  });

  it('número por QR é 409 not_cloud, sem falar com a Meta', async () => {
    const id = await asTenant(async () => (await WhatsAppAccount.create({
      name: 'skygp_qr_saude', purpose: 'general', flavor: 'v2', base_url: EVO_BASE, status: 'connected'
    })).id);
    const r = await atualizar(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'not_cloud');
    assert.equal(healthCalls.length, 0);
  });

  it('o número oficial de outro provedor é 404, e a Meta não é chamada', async () => {
    const beta = await insertReturningId('tenants', { slug: 'beta-saude', name: 'Beta', status: 'active' });
    assert.notEqual(beta, await defaultTenantId());
    const alheio = await insertReturningId('whatsapp_accounts', {
      tenant_id: beta,
      name: 'skygp_beta_saude',
      purpose: 'general',
      flavor: 'v2',
      integration: 'cloud',
      meta_phone_number_id: '109876543210001',
      meta_waba_id: '999999999999001',
      base_url: EVO_BASE,
      status: 'connected'
    });
    const r = await atualizar(alheio);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'account_not_found');
    assert.equal(healthCalls.length, 0);
    const row = await getDb()('whatsapp_accounts').where({ id: alheio }).first();
    assert.equal(row.meta_health_at, null);
  });
});

describe('o aviso quando o número piora', () => {
  it('qualidade e limite em queda avisam a equipe, uma vez', async () => {
    const account = await createCloud('Queda');
    await atualizar(account.id);
    assert.equal(entregues.length, 0);

    graph.body = { ...SAUDAVEL, quality_rating: 'YELLOW', messaging_limit_tier: 'TIER_250' };
    const r = await atualizar(account.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(entregues.length, 1);
    assert.match(entregues[0], /Queda/);
    assert.match(entregues[0], /GREEN → YELLOW/);
    assert.match(entregues[0], /TIER_1K → TIER_250/);

    // A mesma leitura de novo não é queda nova.
    await atualizar(account.id);
    assert.equal(entregues.length, 1);
  });

  it('número que passa a FLAGGED avisa; melhora não avisa', async () => {
    const account = await createCloud('Sinalizado');
    await atualizar(account.id);
    graph.body = { ...SAUDAVEL, status: 'FLAGGED' };
    await atualizar(account.id);
    assert.equal(entregues.length, 1);
    assert.match(entregues[0], /FLAGGED/);

    graph.body = { ...SAUDAVEL, messaging_limit_tier: 'TIER_10K' };
    await atualizar(account.id);
    assert.equal(entregues.length, 1);
  });

  it('com os alertas desligados, a queda fica só na tela', async () => {
    const account = await createCloud('Calado');
    await atualizar(account.id);
    await asTenant(() => WaAlertService.saveSettings({ enabled: false }));
    try {
      graph.body = { ...SAUDAVEL, quality_rating: 'RED' };
      const r = await atualizar(account.id);
      assert.equal(r.body.data.account.metaQualityRating, 'RED');
      assert.equal(entregues.length, 0);
    } finally {
      await asTenant(() => WaAlertService.saveSettings({ enabled: true }));
    }
  });
});

describe('a passada de hora em hora', () => {
  it('consulta só os números oficiais do provedor', async () => {
    await createCloud('Passada');
    const oficiais = (await asTenant(() => WhatsAppAccount.getAll())).filter((row) => row.integration === 'cloud');
    const [resumo] = await MetaNumberHealthService.tick();
    assert.equal(resumo.checked, oficiais.length);
    assert.equal(healthCalls.length, oficiais.length);
  });
});

describe('as regras da queda', () => {
  it('normaliza a resposta e ignora o que não é rótulo', () => {
    const h = parseNumberHealth({ quality_rating: 'weird', messaging_limit_tier: 'tier_2k', throughput: 'x y' });
    assert.equal(h.meta_quality_rating, 'UNKNOWN');
    assert.equal(h.meta_messaging_limit, 'TIER_2K');
    assert.equal(h.meta_throughput, null);
  });

  it('UNKNOWN e primeira leitura não contam como queda', () => {
    const base = parseNumberHealth(SAUDAVEL);
    assert.deepEqual(degradation(null, base), []);
    assert.deepEqual(degradation(base, { ...base, meta_quality_rating: 'UNKNOWN' }), []);
    assert.deepEqual(degradation({ ...base, meta_number_status: 'FLAGGED' }, { ...base, meta_number_status: 'FLAGGED' }), []);
    assert.deepEqual(
      degradation({ ...base, meta_quality_rating: 'YELLOW' }, { ...base, meta_quality_rating: 'RED' }).map((c) => c.kind),
      ['quality']
    );
  });
});
