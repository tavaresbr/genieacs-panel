import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * O app do provedor (PWA) e as notificações push (0130).
 *
 * Um build de mentira com `sw.js`, para provar o cabeçalho de cache; o
 * serviço de push trocado por um gravador (`PushService.transport`), para
 * provar o que SAI — a quem, com que corpo — sem falar com o Google. O que
 * importa:
 *
 * 1. O manifest é servido com o nome, os ícones e `no-cache`; o `sw.js`
 *    também nunca fica uma hora no cache.
 * 2. Inscrever, desinscrever e testar valem só para a pessoa logada, no
 *    provedor da sessão; o endpoint só é aceito em serviço de push conhecido.
 * 3. A preferência desligada não recebe; o papel sem a capacidade não recebe.
 * 4. Um provedor nunca avisa aparelho do outro.
 * 5. 404/410 apaga a inscrição; outro erro recua.
 * 6. O corpo não leva dado de assinante.
 */
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygenpanel-pwa-'));
fs.writeFileSync(path.join(buildDir, 'index.html'), '<html><head><!--seo-head--></head><body><!--seo-body-->painel</body></html>');
fs.writeFileSync(path.join(buildDir, 'portal.html'), '<html><body>portal</body></html>');
fs.writeFileSync(path.join(buildDir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
fs.writeFileSync(path.join(buildDir, 'pwa-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
process.env.FRONTEND_DIR = buildDir;

const {
  authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { generateTokens, PANEL_AUDIENCE } = await import('../src/middleware/auth.js');
const { default: RefreshToken } = await import('../src/models/RefreshToken.js');
const {
  default: PushService, buildPayload, endpointHash, isAllowedEndpoint, preferencesOf, VAPID_KEY
} = await import('../src/services/pushService.js');
const { buildManifest, DEFAULT_ICONS } = await import('../src/services/pwaManifest.js');
const { default: WaAlertService } = await import('../src/services/waAlertService.js');

let panelUrl;
let alfa;
let beta;
const pessoas = {};
let enviados = [];
let resposta = () => undefined;

const endpointDe = (nome) => `https://fcm.googleapis.com/fcm/send/${nome}-dispositivo`;
const inscricao = (nome) => ({
  endpoint: endpointDe(nome),
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
});

async function pessoa(nome, tenantId, role) {
  const id = await insertReturningId('users', {
    username: `${nome}-push`, password: 'x', role: 'admin', email: `${nome}@push.test`
  });
  await getDb()('tenant_users').insert({ tenant_id: tenantId, user_id: id, role });
  const user = await getDb()('users').where({ id }).first();
  // Uma sessão de verdade (0129): o token de acesso carrega o `sid` da
  // família, e a família tem que estar viva a cada requisição.
  const { familyId } = await RefreshToken.startFamily({ user, audience: PANEL_AUDIENCE, tenantId });
  const { accessToken } = generateTokens(user, { tenant_id: tenantId, role }, { sessionId: familyId });
  pessoas[nome] = { id, tenantId, role, token: accessToken, sid: familyId };
  return pessoas[nome];
}

const api = (nome, caminho, { method = 'GET', body, headers = {} } = {}) => call(`${panelUrl}/api/push${caminho}`, {
  method, headers: { ...authHeaders(pessoas[nome].token), ...headers }, ...(body === undefined ? {} : { body })
});

const inscrever = (nome, extra = {}) => api(nome, '/subscribe', {
  method: 'POST', body: { subscription: { ...inscricao(nome), ...extra } }
});

const linhas = () => getDb()('push_subscriptions').orderBy('id', 'asc');

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta-push', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta-push' }).first()).id;

  await pessoa('dona', alfa, 'owner');
  await pessoa('tecnico', alfa, 'tech');
  await pessoa('leitor', alfa, 'viewer');
  await pessoa('vizinho', beta, 'owner');

  PushService.transport = async (subscription, payload, options) => {
    enviados.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
    const r = resposta(subscription);
    if (r) throw r;
  };
});

after(async () => {
  await stopTestServers();
  fs.rmSync(buildDir, { recursive: true, force: true });
});

beforeEach(async () => {
  enviados = [];
  resposta = () => undefined;
  PushService.recent.clear();
  await getDb()('push_subscriptions').del();
  await getDb()('push_preferences').del();
});

describe('o app instalável', () => {
  it('serve o manifest com nome, ícones, tela cheia e sem cache', async () => {
    const r = await call(`${panelUrl}/manifest.webmanifest`);
    assert.equal(r.status, 200);
    assert.match(r.response.headers.get('content-type'), /^application\/manifest\+json/);
    assert.equal(r.response.headers.get('cache-control'), 'no-cache');
    assert.equal(r.body.start_url, '/');
    assert.equal(r.body.scope, '/');
    assert.equal(r.body.display, 'standalone');
    assert.ok(r.body.name);
    assert.ok(r.body.short_name.length <= 24);
    assert.match(r.body.theme_color, /^#[0-9a-f]{6}$/);
    assert.match(r.body.background_color, /^#[0-9a-f]{6}$/);
    const tamanhos = r.body.icons.map((i) => `${i.sizes}:${i.purpose}`);
    assert.deepEqual(tamanhos, ['192x192:any', '512x512:any', '512x512:maskable']);
  });

  it('usa o ícone enviado pelo console quando ele é instalável, e só ele', async () => {
    const comMarca = await buildManifest({ host: 'x' }, {
      readProfile: async () => ({ values: { tradeName: 'Fibra Total' } }),
      readBranding: async () => ({ icon: { mime: 'image/png', updatedAt: '2026-01-01T00:00:00.000Z' } }),
      provider: async () => null
    });
    assert.equal(comMarca.name, 'Fibra Total');
    assert.deepEqual(comMarca.icons.map((i) => i.src), ['/api/tenant/brand/icon?v=2026-01-01T00%3A00%3A00.000Z']);

    const jpeg = await buildManifest({}, {
      readProfile: async () => null,
      readBranding: async () => ({ icon: { mime: 'image/jpeg', updatedAt: 'x' } }),
      provider: async () => null
    });
    assert.deepEqual(jpeg.icons.map((i) => i.src), DEFAULT_ICONS.map((i) => i.src));
  });

  it('leva o nome do provedor no endereço dele', async () => {
    const m = await buildManifest({ host: 'alfa.painel.test' }, {
      readProfile: async () => null, readBranding: async () => null, provider: async () => 'Provedor Alfa'
    });
    assert.match(m.name, /^Provedor Alfa · /);
    assert.equal(m.short_name, 'Provedor Alfa');
  });

  it('nunca deixa o service worker uma hora no cache', async () => {
    const sw = await call(`${panelUrl}/sw.js`);
    assert.equal(sw.status, 200);
    assert.equal(sw.response.headers.get('cache-control'), 'no-cache');
    const png = await call(`${panelUrl}/pwa-192.png`);
    assert.equal(png.status, 200);
    assert.notEqual(png.response.headers.get('cache-control'), 'no-cache');
  });
});

describe('a inscrição do aparelho', () => {
  it('entrega a chave pública VAPID, gerada uma vez e guardada cifrada', async () => {
    const a = await api('dona', '/vapid-public-key');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await api('tecnico', '/vapid-public-key');
    assert.equal(a.body.data.publicKey, b.body.data.publicKey);
    assert.match(a.body.data.publicKey, /^[A-Za-z0-9_-]{80,}$/);

    const guardado = await getDb()('app_state').where({ tenant_id: alfa, key: VAPID_KEY }).first();
    const blob = JSON.parse(guardado.value);
    assert.equal(blob.publicKey, a.body.data.publicKey);
    assert.equal(typeof blob.privateKey, 'object');
    assert.ok(blob.privateKey.password_ciphertext);
    assert.ok(!guardado.value.includes(`"privateKey":"`), 'a chave privada não pode ficar em claro');

    // Cada provedor com o seu par.
    const v = await api('vizinho', '/vapid-public-key');
    assert.notEqual(v.body.data.publicKey, a.body.data.publicKey);
  });

  it('inscreve, guarda o endpoint cifrado e desinscreve só o da própria pessoa', async () => {
    const r = await inscrever('dona');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.devices, 1);
    const [linha] = await linhas();
    assert.equal(Number(linha.tenant_id), alfa);
    assert.equal(Number(linha.user_id), pessoas.dona.id);
    assert.equal(linha.endpoint_hash, endpointHash(endpointDe('dona')));
    // Nenhuma coluna guarda o endpoint, nem um endereço do mesmo serviço de push.
    const endpoint = endpointDe('dona');
    const hostDoPush = new URL(endpoint).host;
    for (const [coluna, valor] of Object.entries(linha)) {
      if (typeof valor !== 'string') continue;
      assert.notEqual(valor, endpoint, `o endpoint ficou em claro em ${coluna}`);
      let host = null;
      try {
        host = new URL(valor).host;
      } catch {
        host = null;
      }
      assert.notEqual(host, hostDoPush, `o endpoint ficou em claro em ${coluna}`);
      assert.equal(valor.indexOf(endpoint), -1, `o endpoint ficou em claro em ${coluna}`);
    }

    // Outra pessoa tentando tirar o aparelho da dona: nada sai.
    const alheio = await api('tecnico', '/unsubscribe', { method: 'POST', body: { endpoint: endpointDe('dona') } });
    assert.equal(alheio.status, 200);
    assert.equal(alheio.body.data.removed, 0);
    assert.equal((await linhas()).length, 1);

    const meu = await api('dona', '/unsubscribe', { method: 'POST', body: { endpoint: endpointDe('dona') } });
    assert.equal(meu.body.data.removed, 1);
    assert.equal((await linhas()).length, 0);
  });

  it('o mesmo aparelho inscrito de novo é uma linha só, do último dono', async () => {
    await inscrever('dona');
    await inscrever('dona');
    assert.equal((await linhas()).length, 1);
    // O celular passou para o técnico: a dona deixa de receber nele.
    const r = await api('tecnico', '/subscribe', { method: 'POST', body: { subscription: inscricao('dona') } });
    assert.equal(r.status, 201);
    const todas = await linhas();
    assert.equal(todas.length, 1);
    assert.equal(Number(todas[0].user_id), pessoas.tecnico.id);
  });

  it('recusa endpoint fora dos serviços de push conhecidos', async () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1/push',
      'https://fcm.googleapis.com.evil.test/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x'
    ]) {
      assert.equal(isAllowedEndpoint(endpoint), false, endpoint);
      const r = await api('dona', '/subscribe', { method: 'POST', body: { subscription: { ...inscricao('dona'), endpoint } } });
      assert.equal(r.status, 400, endpoint);
      assert.equal(r.body.code, 'push_endpoint_invalid');
    }
    assert.ok(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'));
    assert.ok(isAllowedEndpoint('https://web.push.apple.com/QGx'));
    assert.ok(isAllowedEndpoint('https://wns2-by3p.notify.windows.com/w/?token=x'));
    const semChave = await api('dona', '/subscribe', { method: 'POST', body: { subscription: { endpoint: endpointDe('dona'), keys: {} } } });
    assert.equal(semChave.body.code, 'push_keys_invalid');
    assert.equal((await linhas()).length, 0);
  });

  it('recusa a sessão sem token', async () => {
    const r = await call(`${panelUrl}/api/push/subscribe`, { method: 'POST', body: { subscription: inscricao('x') } });
    assert.equal(r.status, 401);
  });
});

describe('o teste e as preferências', () => {
  it('o teste vai só para os aparelhos de quem pediu', async () => {
    await inscrever('dona');
    await inscrever('tecnico');
    const r = await api('dona', '/test', { method: 'POST', body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(enviados.map((e) => e.endpoint), [endpointDe('dona')]);
    assert.equal(enviados[0].payload.event, 'test');
    assert.ok(enviados[0].options.vapidDetails.publicKey);
    assert.ok(enviados[0].options.TTL > 0);

    const sem = await api('leitor', '/test', { method: 'POST', body: {} });
    assert.equal(sem.status, 409);
    assert.equal(sem.body.code, 'push_no_device');
  });

  it('lê e grava as preferências, com os eventos que o papel permite', async () => {
    const lido = await api('tecnico', '/preferences');
    assert.equal(lido.status, 200);
    assert.deepEqual(lido.body.data.events, preferencesOf({}));
    // O técnico não lê a configuração: fatura não está entre os dele.
    assert.ok(!lido.body.data.available.includes('invoice'));
    assert.ok(lido.body.data.available.includes('ont_offline'));
    const dona = await api('dona', '/preferences');
    assert.ok(dona.body.data.available.includes('invoice'));

    const salvo = await api('tecnico', '/preferences', { method: 'PUT', body: { events: { mass_outage: false } } });
    assert.equal(salvo.status, 200);
    assert.equal(salvo.body.data.events.mass_outage, false);
    assert.equal((await api('tecnico', '/preferences')).body.data.events.mass_outage, false);
    // A da dona não mudou.
    assert.equal((await api('dona', '/preferences')).body.data.events.mass_outage, true);

    const ruim = await api('tecnico', '/preferences', { method: 'PUT', body: { events: { hack: true } } });
    assert.equal(ruim.status, 400);
  });
});

describe('quem recebe', () => {
  it('respeita a capacidade do papel e a preferência de cada um', async () => {
    await inscrever('dona');
    await inscrever('tecnico');
    await inscrever('leitor');

    // Fatura: só quem lê a configuração (dona), nunca o técnico nem o leitor.
    await runInTenant(alfa, () => PushService.notifyInvoice({ step: 'due', dueAt: '2026-12-10' }));
    assert.deepEqual(enviados.map((e) => e.endpoint), [endpointDe('dona')]);
    assert.match(enviados[0].payload.body, /2026-12-10/);

    // Queda em massa: quem lê a frota — os três; o técnico desliga e sai.
    enviados = [];
    await api('tecnico', '/preferences', { method: 'PUT', body: { events: { mass_outage: false } } });
    await runInTenant(alfa, () => PushService.notifyAlert({ rule: 'mass_outage', vars: { count: 12, node: 'Rua das Flores 10' } }));
    assert.deepEqual(enviados.map((e) => e.endpoint).sort(), [endpointDe('dona'), endpointDe('leitor')].sort());

    // WhatsApp: o leitor não lê o WhatsApp.
    enviados = [];
    await runInTenant(alfa, () => PushService.notifyAlert({ rule: 'wa_disconnected', vars: { account: 'Atendimento (+5511999998888)' } }));
    assert.deepEqual(enviados.map((e) => e.endpoint).sort(), [endpointDe('dona'), endpointDe('tecnico')].sort());

    // ONT offline vem desligado por padrão.
    enviados = [];
    await runInTenant(alfa, () => PushService.notifyAlert({ rule: 'ont_offline', vars: { device: 'ZTEG-CPF-12345678900', minutes: 31 } }));
    assert.equal(enviados.length, 0);

    // Regra que não vira push.
    await runInTenant(alfa, () => PushService.notifyAlert({ rule: 'rx_power_low', vars: {} }));
    assert.equal(enviados.length, 0);
  });

  it('a mensagem nova avisa o atendente da conversa, ou quem atende quando espera gente', async () => {
    await inscrever('dona');
    await inscrever('tecnico');
    await inscrever('leitor');
    await runInTenant(alfa, () => PushService.notifyInboundMessage({
      conversation: { id: 7, assigned_user_id: pessoas.tecnico.id }, needsHuman: false
    }));
    assert.deepEqual(enviados.map((e) => e.endpoint), [endpointDe('tecnico')]);
    assert.equal(enviados[0].payload.url, '/whatsapp?conversation=7');
    assert.equal(enviados[0].payload.tag, 'wa-conv-7');

    // A segunda mensagem da mesma conversa logo depois não toca de novo.
    enviados = [];
    await runInTenant(alfa, () => PushService.notifyInboundMessage({
      conversation: { id: 7, assigned_user_id: pessoas.tecnico.id }, needsHuman: false
    }));
    assert.equal(enviados.length, 0);

    // Sem atendente, esperando gente: quem lê o WhatsApp (dona e técnico).
    await runInTenant(alfa, () => PushService.notifyInboundMessage({ conversation: { id: 8 }, needsHuman: true }));
    assert.deepEqual(enviados.map((e) => e.endpoint).sort(), [endpointDe('dona'), endpointDe('tecnico')].sort());

    // Com o bot atendendo: ninguém.
    enviados = [];
    await runInTenant(alfa, () => PushService.notifyInboundMessage({ conversation: { id: 9 }, needsHuman: false }));
    assert.equal(enviados.length, 0);
  });

  it('um provedor nunca avisa o aparelho do outro', async () => {
    await inscrever('dona');
    await inscrever('vizinho');
    await runInTenant(beta, () => PushService.notifyAlert({ rule: 'mass_outage', vars: { count: 3 } }));
    assert.deepEqual(enviados.map((e) => e.endpoint), [endpointDe('vizinho')]);

    enviados = [];
    await runInTenant(alfa, () => PushService.notifyInvoice({ step: 'after', expired: true, dueAt: '2026-12-01' }));
    assert.deepEqual(enviados.map((e) => e.endpoint), [endpointDe('dona')]);

    // O atendente "do outro provedor" numa conversa daqui não recebe nada.
    enviados = [];
    await runInTenant(alfa, () => PushService.notifyInboundMessage({
      conversation: { id: 11, assigned_user_id: pessoas.vizinho.id }, needsHuman: false
    }));
    assert.equal(enviados.length, 0);

    // E a preferência gravada no beta mora no beta.
    await api('vizinho', '/preferences', { method: 'PUT', body: { events: { invoice: false } } });
    const prefs = await getDb()('push_preferences');
    assert.deepEqual(prefs.map((p) => [Number(p.tenant_id), Number(p.user_id)]), [[beta, pessoas.vizinho.id]]);
    assert.equal((await runInTenant(alfa, () => PushService.getPreferences(pessoas.vizinho.id))).invoice, true);
  });

  it('o mesmo aparelho reinscrito no outro provedor deixa de receber deste', async () => {
    await inscrever('dona');
    const r = await api('vizinho', '/subscribe', { method: 'POST', body: { subscription: inscricao('dona') } });
    assert.equal(r.status, 201);
    const todas = await linhas();
    assert.equal(todas.length, 1);
    assert.equal(Number(todas[0].tenant_id), beta);
    await runInTenant(alfa, () => PushService.notifyInvoice({ step: 'due', dueAt: '2026-12-10' }));
    assert.equal(enviados.length, 0);
  });
});

describe('a limpeza e o recuo', () => {
  it('apaga a inscrição que o serviço de push dá por morta (410 e 404)', async () => {
    await inscrever('dona');
    await inscrever('tecnico');
    resposta = (sub) => (sub.endpoint === endpointDe('dona')
      ? Object.assign(new Error('gone'), { statusCode: 410 })
      : Object.assign(new Error('not found'), { statusCode: 404 }));
    const r = await runInTenant(alfa, () => PushService.notifyAlert({ rule: 'wa_disconnected' }));
    assert.equal(r.removed, 2);
    assert.equal((await linhas()).length, 0);
  });

  it('noutro erro soma a falha e adia a próxima tentativa', async () => {
    await inscrever('dona');
    resposta = () => Object.assign(new Error('boom'), { statusCode: 500 });
    await runInTenant(alfa, () => PushService.sendTest(pessoas.dona.id));
    const [linha] = await linhas();
    assert.equal(Number(linha.failures), 1);
    assert.ok(new Date(linha.next_attempt_at).getTime() > Date.now());

    // Dentro do recuo, nem tenta.
    enviados = [];
    resposta = () => undefined;
    await runInTenant(alfa, () => PushService.sendTest(pessoas.dona.id));
    assert.equal(enviados.length, 0);

    // Passado o recuo, entrega e zera.
    await getDb()('push_subscriptions').update({ next_attempt_at: new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000) });
    await runInTenant(alfa, () => PushService.sendTest(pessoas.dona.id));
    assert.equal(enviados.length, 1);
    const [depois] = await linhas();
    assert.equal(Number(depois.failures), 0);
    assert.ok(depois.last_ok_at);
  });
});

describe('o corpo do aviso', () => {
  it('não leva dado de assinante, nem do alerta nem da mensagem', async () => {
    await inscrever('dona');
    await api('dona', '/preferences', { method: 'PUT', body: { events: { ont_offline: true } } });
    await runInTenant(alfa, () => PushService.notifyAlert({
      rule: 'ont_offline', vars: { device: 'ZTEG-12345678900', minutes: 45, node: 'Rua Fulano 123', account: '+5511988887777' }
    }));
    await runInTenant(alfa, () => PushService.notifyAlert({ rule: 'mass_outage', vars: { node: 'Casa do João Silva', count: 4 } }));
    await runInTenant(alfa, () => PushService.notifyInboundMessage({ conversation: { id: 5, push_name: 'Maria Souza', wa_phone_e164: '5511977776666', contract: '123.456.789-00' }, needsHuman: true }));
    assert.equal(enviados.length, 3);
    for (const { payload } of enviados) {
      assert.deepEqual(Object.keys(payload).sort(), ['body', 'event', 'tag', 'title', 'url']);
      const texto = JSON.stringify(payload);
      for (const proibido of ['12345678900', 'ZTEG', 'Fulano', 'João', 'Maria', '5511', '123.456.789-00']) {
        assert.ok(!texto.includes(proibido), `${proibido} vazou em ${texto}`);
      }
      assert.ok(payload.url.startsWith('/'));
    }
    assert.match(enviados[0].payload.body, /45/);
  });

  it('só passa números e datas para o texto, e o link nunca sai do painel', () => {
    const p = buildPayload({
      event: 'x', titleKey: 'push.massOutage.title', bodyKey: 'push.massOutage.body',
      vars: { count: 'Fulano de Tal' }, url: '//evil.test/x', locale: 'en'
    });
    assert.ok(!p.body.includes('Fulano'));
    assert.equal(p.url, '/');
    assert.equal(p.title, 'Mass outage');
  });

  it('sai no idioma do aparelho', async () => {
    await api('dona', '/subscribe', { method: 'POST', body: { subscription: inscricao('dona') }, headers: { 'Accept-Language': 'en-US' } });
    await runInTenant(alfa, () => PushService.notifyAlert({ rule: 'wa_disconnected' }));
    assert.equal(enviados[0].payload.title, 'WhatsApp disconnected');
  });
});

describe('os ganchos nos canais de sempre', () => {
  it('o alerta da varredura leva o push junto, sem mudar a conta das cópias', async () => {
    await inscrever('dona');
    const canais = { whatsapp: null, email: null, telegram: null };
    const enviadosPelosCanais = await runInTenant(alfa, () => WaAlertService.notify({
      channels: canais,
      condition: { rule: 'mass_outage', subject: 'cto-1', vars: { node: 'CTO 1', count: 5, total: 8, minutes: 3, link: '' } },
      cleared: false
    }));
    assert.equal(enviadosPelosCanais, 0, 'o push não conta como cópia entregue');
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].payload.event, 'mass_outage');
  });
});
