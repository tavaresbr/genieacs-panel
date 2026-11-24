import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, defaultTenantId, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { setTelegramFetcher } = await import('../src/services/telegramClient.js');
const { resetTelegramChatRateLimit } = await import('../src/services/telegramInboundService.js');
const { default: SubscriberNoticeService } = await import('../src/services/subscriberNoticeService.js');
const { default: TelegramOutboxWorker } = await import('../src/services/telegramOutboxWorker.js');
const { default: TelegramCustomerBot } = await import('../src/models/TelegramCustomerBot.js');
const { default: TelegramConversation } = await import('../src/models/TelegramConversation.js');
const { encryptBotToken } = await import('../src/services/telegramCustomerBotService.js');
const { MAX_ATTEMPTS } = await import('../src/utils/telegram/telegramBackoff.js');

/**
 * Os avisos aos clientes pelo Telegram, AO LADO do WhatsApp.
 *
 * O que estes casos defendem: o aviso só vai a quem vinculou o Telegram a um
 * contrato, não bloqueou o bot e não mandou `/parar`; cada (tipo, referência)
 * sai uma vez por conversa; o ajuste por tipo manda (cobrança e campanha
 * desligadas por padrão); o fechamento só vai a quem recebeu o aviso; e a fila
 * envia com recuo, trata o 403 (bloqueio) e respeita o `retry_after` do 429.
 */
const TOKEN = '555666777:AAHcliente-token-do-bot-de-clientes-bem-longo';
const BASE = 'https://painel.exemplo.test';

let panelUrl;
let token;
let tenantId;
let chamadas = [];
let responder;
let nextMessageId = 500;
let realBase;

const api = (path, method = 'GET', body) => call(`${panelUrl}/api/telegram-chat${path}`, { method, headers: authHeaders(token), body });
const hook = (update, secret) => call(`${panelUrl}/api/telegram-customer-webhook/${tenantId}`, {
  method: 'POST', headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : {}, body: update
});
const enviadas = () => chamadas.filter((c) => c.url.endsWith('/sendMessage'));
const mensagens = () => getDb()('telegram_messages').orderBy('id');
const avisos = () => getDb()('telegram_notices').orderBy('id');
const tick = () => asTenant(() => TelegramOutboxWorker.tickForTenant());

async function ligarBot() {
  await asTenant(() => TelegramCustomerBot.create({
    bot_username: 'provedor_bot', token: encryptBotToken(TOKEN), enabled: true
  }));
}
let chatSeq = 1000;
async function conversa({ contract = null, blocked = false, noticesOff = false } = {}) {
  const bot = await getDb()('telegram_customer_bots').first();
  return asTenant(async () => {
    const c = await TelegramConversation.ensure({ botRowId: bot.id, chatId: String(chatSeq += 1), name: `Pessoa ${chatSeq}` });
    return TelegramConversation.update(c.id, {
      contract,
      blocked_at: blocked ? new Date() : null,
      notices_off_at: noticesOff ? new Date() : null
    });
  });
}
const avisar = (extra = {}) => asTenant(() => SubscriberNoticeService.notifyTelegram({
  contracts: ['C1', 'C2', 'C3', 'C4'], kind: 'outage', refKey: 'incidente:1', body: 'Queda no ODP Centro', ...extra
}));

before(async () => {
  ({ panelUrl } = await startTestServers());
  tenantId = await defaultTenantId();
  realBase = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = BASE;
  setTelegramFetcher(async (url, options) => {
    const body = JSON.parse(options.body);
    chamadas.push({ url, body });
    const custom = responder?.(url, body);
    if (custom) return new Response(JSON.stringify(custom.body), { status: custom.status, headers: { 'Content-Type': 'application/json' } });
    const result = url.endsWith('/sendMessage') ? { message_id: nextMessageId++, chat: { id: body.chat_id } } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => {
  setTelegramFetcher(null);
  if (realBase === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = realBase;
  WaAlertService.stop();
  await stopTestServers();
});

beforeEach(async () => {
  for (const tabela of ['telegram_notices', 'telegram_messages', 'telegram_link_tokens', 'telegram_conversations', 'telegram_customer_bots']) {
    await getDb()(tabela).del();
  }
  await getDb()('app_state').where({ key: 'telegram_customer_notices' }).del();
  chamadas = [];
  responder = null;
  resetTelegramChatRateLimit();
});

describe('quem recebe o aviso', () => {
  it('só quem vinculou o contrato, sem bloqueio e sem /parar', async () => {
    await ligarBot();
    const a = await conversa({ contract: 'C1' });
    await conversa({ contract: 'C2', blocked: true });
    await conversa({ contract: 'C3', noticesOff: true });
    await conversa({ contract: null });
    await conversa({ contract: 'OUTRO' });
    const r = await avisar();
    assert.equal(r.queued, 1);
    const [msg] = await mensagens();
    assert.equal(msg.conversation_id, a.id);
    assert.equal(msg.direction, 'out');
    assert.equal(msg.source, 'notice');
    assert.equal(msg.delivery_status, 'queued');
    assert.equal(msg.body, 'Queda no ODP Centro');
    assert.equal((await avisos()).length, 1);
  });

  it('sem o bot ligado não enfileira nada', async () => {
    await ligarBot();
    await conversa({ contract: 'C1' });
    await getDb()('telegram_customer_bots').update({ enabled: false });
    assert.equal((await avisar()).queued, 0);
    assert.equal((await mensagens()).length, 0);
  });

  it('o mesmo aviso sai uma vez por conversa; outra referência sai de novo', async () => {
    await ligarBot();
    await conversa({ contract: 'C1' });
    assert.equal((await avisar()).queued, 1);
    assert.equal((await avisar()).queued, 0, 'o "Avisar de novo" repetiu o aviso');
    assert.equal((await avisar({ refKey: 'incidente:2' })).queued, 1);
    assert.equal((await mensagens()).length, 2);
  });

  it('duas conversas no mesmo contrato recebem as duas', async () => {
    await ligarBot();
    await conversa({ contract: 'C1' });
    await conversa({ contract: 'C1' });
    assert.equal((await avisar()).queued, 2);
  });

  it('uma lista de textos entra na ordem (a fatura e depois o código)', async () => {
    await ligarBot();
    await conversa({ contract: 'C1' });
    await avisar({ kind: 'outage', body: ['texto', 'PIX-123'] });
    assert.deepEqual((await mensagens()).map((m) => m.body), ['texto', 'PIX-123']);
  });

  it('o fechamento só vai a quem recebeu o aviso, e uma vez', async () => {
    await ligarBot();
    await conversa({ contract: 'C1' });
    await conversa({ contract: 'C9' });
    await avisar();
    const fim = () => asTenant(() => SubscriberNoticeService.notifyFollowUp({
      kind: 'outage', fromRefKey: 'incidente:1', refKey: 'incidente:1:fim', body: 'Normalizado'
    }));
    assert.equal((await fim()).queued, 1);
    assert.equal((await fim()).queued, 0);
    assert.deepEqual((await mensagens()).map((m) => m.body), ['Queda no ODP Centro', 'Normalizado']);
  });

  it('o fechamento não vai a quem bloqueou o bot nem mandou /parar depois do aviso', async () => {
    await ligarBot();
    const a = await conversa({ contract: 'C1' });
    await avisar();
    await asTenant(() => TelegramConversation.update(a.id, { notices_off_at: new Date() }));
    const r = await asTenant(() => SubscriberNoticeService.notifyFollowUp({
      kind: 'outage', fromRefKey: 'incidente:1', refKey: 'incidente:1:fim', body: 'Normalizado'
    }));
    assert.equal(r.queued, 0);
  });
});

describe('o ajuste por tipo', () => {
  it('queda e manutenção saem por padrão; cobrança e campanha, não', async () => {
    await ligarBot();
    await conversa({ contract: 'C1' });
    const padrao = await api('/notices');
    assert.deepEqual(padrao.body.data, { billing: false, outage: true, maintenance: true, campaign: false });
    assert.equal((await avisar({ kind: 'billing', refKey: 'C1:f1:3' })).queued, 0);
    assert.equal((await avisar({ kind: 'campaign', refKey: 'campanha:1' })).queued, 0);
    assert.equal((await avisar({ kind: 'maintenance', refKey: 'manutencao:1:aviso' })).queued, 1);
  });

  it('ligar a cobrança pela tela faz a cobrança sair, e vai para a trilha', async () => {
    await ligarBot();
    await conversa({ contract: 'C1' });
    const salvo = await api('/notices', 'PUT', { billing: true, outage: false });
    assert.equal(salvo.status, 200, JSON.stringify(salvo.body));
    assert.deepEqual(salvo.body.data, { billing: true, outage: false, maintenance: true, campaign: false });
    assert.equal((await avisar({ kind: 'billing', refKey: 'C1:f1:3' })).queued, 1);
    assert.equal((await avisar({ kind: 'outage', refKey: 'incidente:7' })).queued, 0);
    const trilha = await getDb()('audit_log').where({ action: 'telegram_chat_notices.changed' }).first();
    assert.deepEqual(JSON.parse(trilha.detail), { billing: true, outage: false });
  });

  it('valor que não é booleano e tipo desconhecido são ignorados', async () => {
    const r = await api('/notices', 'PUT', { billing: 'sim', inventado: true, outage: false });
    assert.deepEqual(r.body.data, { billing: false, outage: false, maintenance: true, campaign: false });
  });

  it('sem a capacidade de configurar, o ajuste é recusado (403)', async () => {
    const r = await call(`${panelUrl}/api/telegram-chat/notices`, { method: 'PUT', headers: {}, body: { billing: true } });
    assert.ok([401, 403].includes(r.status));
  });
});

describe('a fila de envio', () => {
  it('envia o que está na fila, grava o message_id e fecha como enviado', async () => {
    await ligarBot();
    const a = await conversa({ contract: 'C1' });
    await avisar();
    const r = await tick();
    assert.deepEqual(r, { sent: 1, failed: 0, retry: 0 });
    const [enviada] = enviadas();
    assert.equal(String(enviada.body.chat_id), a.chat_id);
    assert.equal(enviada.body.text, 'Queda no ODP Centro');
    const [msg] = await mensagens();
    assert.equal(msg.delivery_status, 'sent');
    assert.match(msg.external_id, new RegExp(`^${a.chat_id}:\\d+$`));
    assert.equal(msg.attempts, 1);
    assert.equal((await tick()).sent, 0, 'enviou de novo o que já saiu');
  });

  it('a resposta da equipe (já enviada) não entra na fila', async () => {
    await ligarBot();
    await conversa({ contract: 'C1' });
    await getDb()('telegram_messages').insert({
      tenant_id: tenantId, conversation_id: (await getDb()('telegram_conversations').first()).id,
      direction: 'out', body: 'oi', source: 'operator', delivery_status: 'sent', external_id: '1:1'
    });
    assert.equal((await tick()).sent, 0);
    assert.equal(enviadas().length, 0);
  });

  it('403: o cliente bloqueou o bot — a conversa fica bloqueada e a mensagem falha de vez', async () => {
    await ligarBot();
    const a = await conversa({ contract: 'C1' });
    await avisar();
    responder = (url) => (url.endsWith('/sendMessage')
      ? { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } }
      : null);
    assert.deepEqual(await tick(), { sent: 0, failed: 1, retry: 0 });
    const [msg] = await mensagens();
    assert.equal(msg.delivery_status, 'failed');
    assert.equal(msg.next_attempt_at, null);
    assert.ok((await getDb()('telegram_conversations').where({ id: a.id }).first()).blocked_at);
    responder = null;
    chamadas = [];
    assert.equal((await avisar({ refKey: 'incidente:2' })).queued, 0, 'avisou um chat bloqueado');
  });

  it('429: respeita o retry_after e tenta de novo depois', async () => {
    await ligarBot();
    await conversa({ contract: 'C1' });
    await avisar();
    responder = (url) => (url.endsWith('/sendMessage')
      ? { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 120 } } }
      : null);
    assert.deepEqual(await tick(), { sent: 0, failed: 0, retry: 1 });
    const [msg] = await mensagens();
    assert.equal(msg.delivery_status, 'queued');
    const espera = new Date(msg.next_attempt_at).getTime() - Date.now();
    assert.ok(espera > 100_000 && espera <= 121_000, `esperou ${espera} ms`);
    // Ainda não venceu: a passada seguinte não tenta.
    responder = null;
    chamadas = [];
    assert.equal((await tick()).sent, 0);
    assert.equal(enviadas().length, 0);
    // Venceu: sai.
    await getDb()('telegram_messages').update({ next_attempt_at: new Date(Date.now() - 1000) });
    assert.equal((await tick()).sent, 1);
  });

  it('erro passageiro volta para a fila com recuo e desiste na sétima tentativa', async () => {
    await ligarBot();
    await conversa({ contract: 'C1' });
    await avisar();
    responder = (url) => (url.endsWith('/sendMessage') ? { status: 500, body: { ok: false, description: 'boom' } } : null);
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await tick()).retry, 1, `tentativa ${i}`);
      // eslint-disable-next-line no-await-in-loop
      await getDb()('telegram_messages').update({ next_attempt_at: new Date(Date.now() - 1000) });
    }
    assert.equal((await tick()).failed, 1);
    const [msg] = await mensagens();
    assert.equal(msg.delivery_status, 'failed');
    assert.equal(msg.attempts, MAX_ATTEMPTS);
  });

  it('/parar entre o enfileirar e o envio: o aviso falha sem chamar o Telegram', async () => {
    await ligarBot();
    const a = await conversa({ contract: 'C1' });
    await avisar();
    await asTenant(() => TelegramConversation.update(a.id, { notices_off_at: new Date() }));
    assert.equal((await tick()).failed, 1);
    assert.equal(enviadas().length, 0);
  });

  it('o token do bot não aparece no que ficou gravado nem no log', async () => {
    const logs = [];
    const realWarn = console.warn;
    console.warn = (...a) => logs.push(a.join(' '));
    try {
      await ligarBot();
      await conversa({ contract: 'C1' });
      await avisar();
      setTelegramFetcher(async () => { throw new Error(`falha em https://api.telegram.org/bot${TOKEN}/sendMessage`); });
      await tick();
    } finally {
      console.warn = realWarn;
      setTelegramFetcher(async (url, options) => {
        chamadas.push({ url, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    }
    assert.ok(!logs.join('\n').includes(TOKEN));
    assert.ok(!JSON.stringify(await mensagens()).includes(TOKEN));
  });
});

describe('/parar e /receber', () => {
  const USER = { id: 8801, first_name: 'Maria', is_bot: false };
  const fala = (text) => ({ update_id: 1, message: { message_id: Math.floor(Math.random() * 1e6), date: Math.floor(Date.now() / 1000), text, from: USER, chat: { id: USER.id, type: 'private' } } });

  async function ligarPeloPainel() {
    assert.equal((await api('/bot', 'PUT', { token: TOKEN })).status, 201);
    assert.equal((await api('/bot/enable', 'POST')).status, 200);
    return chamadas.find((c) => c.url.endsWith('/setWebhook')).body.secret_token;
  }
  const espera = async (fn) => { for (let i = 0; i < 100; i += 1) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); } };

  it('/parar corta os avisos, confirma, e a conversa continua; /receber volta', async () => {
    const segredo = await ligarPeloPainel();
    await hook(fala('oi'), segredo);
    await espera(async () => (await getDb()('telegram_conversations').first()));
    const conv = await getDb()('telegram_conversations').first();
    await asTenant(() => TelegramConversation.update(conv.id, { contract: 'C1' }));
    chamadas = [];

    await hook(fala('/parar'), segredo);
    await espera(async () => (await getDb()('telegram_conversations').first()).notices_off_at);
    assert.ok((await getDb()('telegram_conversations').first()).notices_off_at);
    await espera(async () => enviadas().length >= 1);
    assert.match(enviadas().at(-1).body.text, /não vai mais receber avisos/);
    assert.equal((await avisar()).queued, 0);
    assert.equal((await api('/conversations')).body.data[0].noticesOff, true);

    await hook(fala('/receber'), segredo);
    await espera(async () => !(await getDb()('telegram_conversations').first()).notices_off_at);
    assert.equal((await getDb()('telegram_conversations').first()).notices_off_at, null);
    assert.equal((await avisar({ refKey: 'incidente:5' })).queued, 1);
  });
});
