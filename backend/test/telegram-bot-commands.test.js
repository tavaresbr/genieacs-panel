import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, defaultTenantId, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { setTelegramFetcher } = await import('../src/services/telegramClient.js');

/**
 * O bot de comandos do Telegram.
 *
 * O que estes casos defendem: o webhook só aceita o segredo certo (e só com o
 * bot ligado); o Telegram só vira um operador pelo código de uso único, no
 * privado; quem não está vinculado não recebe nada do painel; e o token do bot
 * nunca aparece numa resposta.
 */
const TOKEN = '123456789:AAHdemo-token-do-bot-com-segredo-bem-longo';
const GRUPO = '-1001234567890';
const BASE = 'https://painel.exemplo.test';

let panelUrl;
let token;
let tenantId;
let chamadas = [];
let realDashboard;
let realPage;
let realBase;

const api = (path, method = 'GET', body) => call(`${panelUrl}/api/whatsapp/alerts/telegram/bot${path}`, { method, headers: authHeaders(token), body });
const put = (body) => call(`${panelUrl}/api/whatsapp/alerts/settings`, { method: 'PUT', headers: authHeaders(token), body });
const hook = (update, secret) => call(`${panelUrl}/api/telegram-webhook/${tenantId}`, {
  method: 'POST',
  headers: secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret },
  body: update
});
const msg = (text, { from = 7001, chat = from, type = 'private' } = {}) => ({
  update_id: 1,
  message: { text, from: { id: from, username: `u${from}`, is_bot: false }, chat: { id: chat, type } }
});
const enviadas = (metodo) => chamadas.filter((c) => c.url.endsWith(`/${metodo}`));
/** O bot responde depois do 200: espera a mensagem chegar. */
async function esperaMensagens(n) {
  for (let i = 0; i < 100; i += 1) {
    if (enviadas('sendMessage').length >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
let segredo;

async function ligar() {
  await put({ telegram: { botToken: TOKEN, chatId: GRUPO } });
  const r = await api('/enable', 'POST');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  segredo = enviadas('setWebhook')[0].body.secret_token;
}
async function vincular(from = 7001) {
  const code = (await api('/link-code', 'POST')).body.data.code;
  await hook(msg(`/vincular ${code}`, { from }), segredo);
  await esperaMensagens(1);
  return code;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  tenantId = await defaultTenantId();
  realBase = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = BASE;
  realDashboard = DeviceService.getDashboardData;
  realPage = DeviceService.getDevicesPage;
  DeviceService.getDashboardData = async () => ({ stats: { total: 10, online: 7, offline: 3, new24h: 1 } });
  DeviceService.getDevicesPage = async () => ({
    devices: [{ _id: 'dev-1', SerialNumber: 'ZTEG1', pppoe: 'joao.silva', rxpower: '-21', _lastInform: new Date(Date.now() - 3600_000).toISOString() }],
    page: 1, pageSize: 10, total: 1, totalPages: 1
  });
  setTelegramFetcher(async (url, options) => {
    chamadas.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => {
  setTelegramFetcher(null);
  DeviceService.getDashboardData = realDashboard;
  DeviceService.getDevicesPage = realPage;
  if (realBase === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = realBase;
  WaAlertService.stop();
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('app_state').whereIn('key', ['telegram_bot', 'whatsapp_alert_settings']).del();
  WaAlertService.settingsCache.clear();
  chamadas = [];
  segredo = undefined;
});

describe('ligar o bot', () => {
  it('recusa ligar sem token guardado', async () => {
    const r = await api('/enable', 'POST');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'telegram_not_configured');
  });

  it('recusa ligar sem endereço público HTTPS', async () => {
    await put({ telegram: { botToken: TOKEN, chatId: GRUPO } });
    process.env.PUBLIC_BASE_URL = 'http://painel.local';
    try {
      const r = await api('/enable', 'POST');
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'telegram_no_public_url');
    } finally {
      process.env.PUBLIC_BASE_URL = BASE;
    }
  });

  it('registra o webhook do provedor com um segredo, sem devolver token nem segredo', async () => {
    await ligar();
    const [hookCall] = enviadas('setWebhook');
    assert.equal(hookCall.body.url, `${BASE}/api/telegram-webhook/${tenantId}`);
    assert.match(hookCall.body.secret_token, /^[0-9a-f]{64}$/);
    const status = await api('');
    assert.equal(status.body.data.enabled, true);
    const bruto = JSON.stringify(status.body);
    assert.ok(!bruto.includes(TOKEN) && !bruto.includes(hookCall.body.secret_token));
    const linha = await getDb()('app_state').where({ key: 'telegram_bot' }).first();
    assert.ok(!linha.value.includes(hookCall.body.secret_token), 'o segredo do webhook está em texto no banco');
  });
});

describe('o webhook', () => {
  it('recusa sem segredo, com segredo errado e para provedor inexistente', async () => {
    await ligar();
    assert.equal((await hook(msg('/status'))).status, 401);
    assert.equal((await hook(msg('/status'), 'errado')).status, 401);
    const fora = await call(`${panelUrl}/api/telegram-webhook/999999`, {
      method: 'POST', headers: { 'x-telegram-bot-api-secret-token': segredo }, body: msg('/status')
    });
    assert.equal(fora.status, 401);
  });

  it('com o bot desligado, nem o segredo antigo vale', async () => {
    await ligar();
    const off = await api('/disable', 'POST');
    assert.equal(off.status, 200);
    assert.equal(enviadas('deleteWebhook').length, 1);
    assert.equal((await hook(msg('/status'), segredo)).status, 401);
  });
});

describe('vínculo e comandos', () => {
  it('quem não está vinculado não recebe dados: silêncio no grupo, dica no privado', async () => {
    await ligar();
    assert.equal((await hook(msg('/status', { from: 9, chat: Number(GRUPO), type: 'supergroup' }), segredo)).status, 200);
    assert.equal((await hook(msg('/status', { from: 9 }), segredo)).status, 200);
    await esperaMensagens(1);
    const textos = enviadas('sendMessage').map((c) => c.body.text);
    assert.equal(textos.length, 1, 'o grupo deveria ficar em silêncio');
    assert.match(textos[0], /vincular/);
    assert.ok(!textos[0].includes('Total'));
  });

  it('o código vincula o Telegram, uma vez só, e só no privado', async () => {
    await ligar();
    const { body } = await api('/link-code', 'POST');
    const code = body.data.code;
    await hook(msg(`/vincular ${code}`, { chat: Number(GRUPO), type: 'supergroup' }), segredo);
    await esperaMensagens(1);
    assert.match(enviadas('sendMessage')[0].body.text, /privado/);

    await hook(msg(`/vincular ${code}`), segredo);
    await esperaMensagens(2);
    assert.match(enviadas('sendMessage')[1].body.text, /Vinculado/);

    await hook(msg(`/vincular ${code}`, { from: 7002 }), segredo);
    await esperaMensagens(3);
    assert.match(enviadas('sendMessage')[2].body.text, /inválido/);

    const status = await api('');
    assert.equal(status.body.data.links.length, 1);
    assert.equal(status.body.data.links[0].username, 'operator');
  });

  it('o código vencido não vincula', async () => {
    await ligar();
    const code = (await api('/link-code', 'POST')).body.data.code;
    const row = await getDb()('app_state').where({ key: 'telegram_bot' }).first();
    const state = JSON.parse(row.value);
    state.codes = state.codes.map((c) => ({ ...c, expiresAt: Date.now() - 1000 }));
    await getDb()('app_state').where({ key: 'telegram_bot' }).update({ value: JSON.stringify(state) });
    await hook(msg(`/vincular ${code}`), segredo);
    await esperaMensagens(1);
    assert.match(enviadas('sendMessage')[0].body.text, /inválido/);
  });

  it('vinculado, /status e /cliente respondem com os dados do painel', async () => {
    await ligar();
    await vincular();
    chamadas = [];
    await hook(msg('/status'), segredo);
    await esperaMensagens(1);
    assert.match(enviadas('sendMessage')[0].body.text, /Total: 10[\s\S]*Offline: 3/);
    assert.equal(enviadas('sendMessage')[0].body.parse_mode, 'HTML');

    await hook(msg('/cliente joao'), segredo);
    await esperaMensagens(2);
    assert.match(enviadas('sendMessage')[1].body.text, /joao\.silva/);
  });

  it('o grupo dos alertas pode usar o bot, mas outro grupo não', async () => {
    await ligar();
    await vincular();
    chamadas = [];
    await hook(msg('/status@MeuBot', { chat: Number(GRUPO), type: 'supergroup' }), segredo);
    await hook(msg('/status', { chat: -100777, type: 'supergroup' }), segredo);
    await esperaMensagens(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(enviadas('sendMessage').length, 1);
    assert.equal(String(enviadas('sendMessage')[0].body.chat_id), GRUPO);
  });

  it('desvincular pela API corta o acesso', async () => {
    await ligar();
    await vincular();
    const antes = (await api('')).body.data.links;
    const del = await api(`/links/${antes[0].telegramUserId}`, 'DELETE');
    assert.equal(del.status, 200);
    assert.equal(del.body.data.links.length, 0);
    assert.equal((await api('/links/7001', 'DELETE')).status, 404);
    chamadas = [];
    await hook(msg('/status'), segredo);
    await esperaMensagens(1);
    assert.match(enviadas('sendMessage')[0].body.text, /não está vinculado/);
  });
});
