import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, defaultTenantId, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { setTelegramFetcher } = await import('../src/services/telegramClient.js');
const { resetTelegramChatRateLimit } = await import('../src/services/telegramInboundService.js');
const { default: TelegramLinkTokenService } = await import('../src/services/telegramLinkTokenService.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');

/**
 * O Telegram dos CLIENTES: um segundo bot do provedor, com tabelas, token,
 * segredo e rota próprios.
 *
 * O que estes casos defendem: o webhook só aceita o segredo certo (e só com o
 * bot ligado); o cliente só vira um assinante pelo link de uso único, e o token
 * do link NUNCA entra na conversa; a mesma mensagem entregue duas vezes entra uma
 * vez; quem bloqueia o bot não recebe mais nada; o token do bot não aparece em
 * resposta nenhuma; e um provedor não enxerga a conversa de outro.
 */
const TOKEN = '555666777:AAHcliente-token-do-bot-de-clientes-bem-longo';
const BASE = 'https://painel.exemplo.test';
const USER = { id: 4242, first_name: 'Maria', last_name: 'Silva', username: 'maria_s', is_bot: false };

let panelUrl;
let token;
let tenantId;
let chamadas = [];
let realBase;
let segredo;
let nextMessageId = 100;
let responder;

const api = (path, method = 'GET', body) => call(`${panelUrl}/api/telegram-chat${path}`, { method, headers: authHeaders(token), body });
const hook = (update, secret, tid = tenantId) => call(`${panelUrl}/api/telegram-customer-webhook/${tid}`, {
  method: 'POST',
  headers: secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret },
  body: update
});
let updateId = 1;
const fromCliente = (text, { from = USER, chat = from.id, messageId } = {}) => ({
  update_id: updateId++,
  message: {
    message_id: messageId ?? nextMessageId++,
    date: Math.floor(Date.now() / 1000),
    text,
    from,
    chat: { id: chat, type: 'private' }
  }
});
const enviadas = (metodo) => chamadas.filter((c) => c.url.endsWith(`/${metodo}`));
async function espera(fn) {
  for (let i = 0; i < 100; i += 1) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const conversas = () => getDb()('telegram_conversations').orderBy('id');
const mensagens = () => getDb()('telegram_messages').orderBy('id');

async function ligar() {
  const salvo = await api('/bot', 'PUT', { token: TOKEN });
  assert.equal(salvo.status, 201, JSON.stringify(salvo.body));
  const r = await api('/bot/enable', 'POST');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  segredo = enviadas('setWebhook')[0].body.secret_token;
}

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
    let result = true;
    if (url.endsWith('/getMe')) result = { id: 555666777, is_bot: true, first_name: 'Provedor Bot', username: 'provedor_clientes_bot' };
    if (url.endsWith('/sendMessage')) result = { message_id: nextMessageId++, chat: { id: body.chat_id } };
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
  for (const tabela of ['telegram_messages', 'telegram_link_tokens', 'telegram_conversations', 'telegram_customer_bots']) {
    await getDb()(tabela).del();
  }
  chamadas = [];
  responder = null;
  segredo = undefined;
  resetTelegramChatRateLimit();
});

describe('ligar o bot de clientes', () => {
  it('recusa um token fora do formato, sem chamar o Telegram', async () => {
    const r = await api('/bot', 'PUT', { token: 'isso-nao-e-token' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_token');
    assert.equal(chamadas.length, 0);
  });

  it('recusa um token que o Telegram rejeita', async () => {
    responder = () => ({ status: 401, body: { ok: false, description: 'Unauthorized' } });
    const r = await api('/bot', 'PUT', { token: TOKEN });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_token');
  });

  it('guarda o token cifrado e nunca o devolve; liga com segredo novo e só o hash fica', async () => {
    await ligar();
    const [hookCall] = enviadas('setWebhook');
    assert.equal(hookCall.body.url, `${BASE}/api/telegram-customer-webhook/${tenantId}`);
    assert.match(hookCall.body.secret_token, /^[0-9a-f]{64}$/);
    const status = await api('/bot');
    assert.deepEqual(status.body.data, {
      configured: true, enabled: true, autoReply: false, botUsername: 'provedor_clientes_bot', botName: 'Provedor Bot', webhookError: null
    });
    const bruto = JSON.stringify(status.body);
    assert.ok(!bruto.includes(TOKEN) && !bruto.includes(hookCall.body.secret_token));
    const linha = await getDb()('telegram_customer_bots').first();
    assert.ok(!linha.token.includes(TOKEN), 'o token está em texto no banco');
    assert.ok(!JSON.stringify(linha).includes(hookCall.body.secret_token), 'o segredo do webhook está guardado');
  });

  it('ligar sem endereço público HTTPS é recusado', async () => {
    await api('/bot', 'PUT', { token: TOKEN });
    process.env.PUBLIC_BASE_URL = 'http://painel.local';
    try {
      const r = await api('/bot/enable', 'POST');
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'no_public_url');
    } finally {
      process.env.PUBLIC_BASE_URL = BASE;
    }
  });

  it('ligar sem token guardado é recusado', async () => {
    const r = await api('/bot/enable', 'POST');
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'bot_not_configured');
  });

  it('desligar tira o webhook e invalida o segredo; remover esquece o token e guarda as conversas', async () => {
    await ligar();
    await hook(fromCliente('oi'), segredo);
    await espera(async () => (await conversas()).length === 1);
    assert.equal((await api('/bot/disable', 'POST')).status, 200);
    assert.equal(enviadas('deleteWebhook').length, 1);
    assert.equal((await hook(fromCliente('oi de novo'), segredo)).status, 401);
    assert.equal((await api('/bot/disconnect', 'POST')).status, 200);
    assert.equal((await getDb()('telegram_customer_bots').first()).token, null);
    assert.equal((await conversas()).length, 1, 'remover o bot apagou as conversas');
  });
});

describe('o webhook de clientes', () => {
  it('recusa sem segredo, com segredo errado e para provedor inexistente', async () => {
    await ligar();
    assert.equal((await hook(fromCliente('oi'))).status, 401);
    assert.equal((await hook(fromCliente('oi'), 'errado')).status, 401);
    assert.equal((await hook(fromCliente('oi'), segredo, 999999)).status, 401);
    assert.equal((await conversas()).length, 0);
  });

  it('o segredo do bot da EQUIPE não vale aqui (são webhooks separados)', async () => {
    await ligar();
    const equipe = await call(`${panelUrl}/api/telegram-webhook/${tenantId}`, {
      method: 'POST', headers: { 'x-telegram-bot-api-secret-token': segredo }, body: fromCliente('oi')
    });
    assert.equal(equipe.status, 401);
  });

  it('uma mensagem cria a conversa e conta como não lida; entregue duas vezes entra uma', async () => {
    await ligar();
    const update = fromCliente('Estou sem internet', { messageId: 7 });
    assert.equal((await hook(update, segredo)).status, 200);
    await espera(async () => (await mensagens()).length === 1);
    assert.equal((await hook(update, segredo)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [conversa] = await conversas();
    assert.equal(conversa.chat_id, String(USER.id));
    assert.equal(conversa.name, 'Maria Silva');
    assert.equal(conversa.username, 'maria_s');
    assert.equal(conversa.unread_count, 1);
    const lista = await mensagens();
    assert.equal(lista.length, 1);
    assert.equal(lista[0].external_id, `${USER.id}:7`);
    assert.equal(lista[0].source, 'customer');
  });

  it('grupos e bots são ignorados', async () => {
    await ligar();
    const grupo = fromCliente('oi', { chat: -1001 });
    grupo.message.chat.type = 'supergroup';
    await hook(grupo, segredo);
    await hook(fromCliente('oi', { from: { ...USER, id: 9, is_bot: true } }), segredo);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await conversas()).length, 0);
  });

  it('mensagem sem texto entra com um marcador, sem perder a conversa', async () => {
    await ligar();
    const foto = fromCliente(undefined);
    delete foto.message.text;
    foto.message.photo = [{ file_id: 'x' }];
    await hook(foto, segredo);
    await espera(async () => (await mensagens()).length === 1);
    assert.match((await mensagens())[0].body, /não suportado/);
  });

  it('limita um chat que escreve demais (o resto é ignorado)', async () => {
    await ligar();
    for (let i = 0; i < 35; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await hook(fromCliente(`msg ${i}`), segredo);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await mensagens()).length, 30);
  });
});

describe('a caixa de atendimento', () => {
  async function conversaAberta() {
    await ligar();
    await hook(fromCliente('Estou sem internet'), segredo);
    await espera(async () => (await conversas()).length === 1);
    return (await conversas())[0];
  }

  it('lista com prévia; abrir zera o não lido e lê as mensagens', async () => {
    const conversa = await conversaAberta();
    const lista = await api('/conversations');
    assert.equal(lista.body.data.length, 1);
    assert.equal(lista.body.data[0].unreadCount, 1);
    assert.equal(lista.body.data[0].lastMessage.text, 'Estou sem internet');
    assert.equal(lista.body.data[0].linked, false);
    const aberta = await api(`/conversations/${conversa.id}/messages`);
    assert.equal(aberta.body.data.messages.length, 1);
    assert.equal((await conversas())[0].unread_count, 0);
  });

  it('responder envia ao Telegram, grava com o message_id e devolve 201', async () => {
    const conversa = await conversaAberta();
    chamadas = [];
    const r = await api(`/conversations/${conversa.id}/messages`, 'POST', { text: 'Já estamos vendo, um momento.' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const [enviada] = enviadas('sendMessage');
    assert.equal(String(enviada.body.chat_id), String(USER.id));
    assert.equal(enviada.body.text, 'Já estamos vendo, um momento.');
    assert.equal(r.body.data.deliveryStatus, 'sent');
    const saida = (await mensagens()).find((m) => m.direction === 'out');
    assert.match(saida.external_id, new RegExp(`^${USER.id}:\\d+$`));
    assert.equal(saida.source, 'operator');
  });

  it('texto vazio ou longo não grava nada', async () => {
    const conversa = await conversaAberta();
    const antes = (await mensagens()).length;
    assert.equal((await api(`/conversations/${conversa.id}/messages`, 'POST', { text: '   ' })).body.code, 'empty_message');
    assert.equal((await api(`/conversations/${conversa.id}/messages`, 'POST', { text: 'x'.repeat(4001) })).body.code, 'message_too_long');
    assert.equal((await mensagens()).length, antes);
  });

  it('o cliente bloqueou o bot (403): a conversa fica bloqueada, nada mais sai, e quem escreve de novo desbloqueia', async () => {
    const conversa = await conversaAberta();
    responder = (url) => (url.endsWith('/sendMessage')
      ? { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } }
      : null);
    const r = await api(`/conversations/${conversa.id}/messages`, 'POST', { text: 'Olá?' });
    assert.equal(r.status, 502);
    assert.equal(r.body.data.deliveryStatus, 'failed');
    assert.ok((await conversas())[0].blocked_at);
    responder = null;
    chamadas = [];
    const segunda = await api(`/conversations/${conversa.id}/messages`, 'POST', { text: 'De novo' });
    assert.equal(segunda.status, 409);
    assert.equal(segunda.body.code, 'chat_blocked');
    assert.equal(enviadas('sendMessage').length, 0, 'enviou a um chat bloqueado');
    await hook(fromCliente('voltei'), segredo);
    await espera(async () => !(await conversas())[0].blocked_at);
    assert.equal((await conversas())[0].blocked_at, null);
  });

  it('com o bot desligado não envia', async () => {
    const conversa = await conversaAberta();
    await api('/bot/disable', 'POST');
    const r = await api(`/conversations/${conversa.id}/messages`, 'POST', { text: 'oi' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'bot_unavailable');
  });

  it('arquiva e reabre; escrever de novo reabre', async () => {
    const conversa = await conversaAberta();
    assert.equal((await api(`/conversations/${conversa.id}/closed`, 'POST', { closed: true })).status, 200);
    assert.equal((await api('/conversations?status=open')).body.data.length, 0);
    assert.equal((await api('/conversations?status=closed')).body.data.length, 1);
    await hook(fromCliente('ainda aí?'), segredo);
    await espera(async () => !(await conversas())[0].closed_at);
    assert.equal((await conversas())[0].closed_at, null);
  });
});

describe('o vínculo do cliente ao contrato', () => {
  const CONTRATO = 'CONTRATO-TG-1';
  before(async () => {
    await runInTenant(await defaultTenantId(), () => SgpLink.upsert?.({ device_id: 'ONT-TG-1', contract: CONTRATO, client_name: 'Maria Silva', state: 'active' }))
      .catch(() => null);
    const existe = await getDb()('sgp_links').where({ contract: CONTRATO }).first();
    if (!existe) {
      await insertReturningId('sgp_links', {
        tenant_id: await defaultTenantId(), device_id: 'ONT-TG-1', contract: CONTRATO, client_name: 'Maria Silva', state: 'active'
      });
    }
  });

  const emitir = () => api('/links', 'POST', { contract: CONTRATO });

  it('a equipe emite um link t.me do bot; contrato inexistente é 404', async () => {
    await ligar();
    const r = await emitir();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.data.url, /^https:\/\/t\.me\/provedor_clientes_bot\?start=[A-Za-z0-9_-]{22}$/);
    const nada = await api('/links', 'POST', { contract: 'NAO-EXISTE' });
    assert.equal(nada.status, 404);
    assert.equal(nada.body.code, 'subscriber_not_found');
  });

  it('sem o bot ligado não há link', async () => {
    const r = await emitir();
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'no_bot');
  });

  it('abrir o link vincula, uma vez só, e o token nunca entra na conversa nem no banco em texto', async () => {
    await ligar();
    const { url } = (await emitir()).body.data;
    const codigo = url.split('start=')[1];
    chamadas = [];
    await hook(fromCliente(`/start ${codigo}`), segredo);
    await espera(async () => (await conversas())[0]?.contract === CONTRATO);
    const [conversa] = await conversas();
    assert.equal(conversa.contract, CONTRATO);
    assert.equal(conversa.bound_via, 'link');
    const textos = (await mensagens()).map((m) => m.body).join('\n');
    assert.ok(!textos.includes(codigo), 'o token do link entrou na conversa');
    assert.match((await mensagens()).find((m) => m.direction === 'in').body, /^\/start$/);
    await espera(async () => enviadas('sendMessage').length >= 1);
    assert.match(enviadas('sendMessage')[0].body.text, /vinculado/);
    const guardado = JSON.stringify(await getDb()('telegram_link_tokens'));
    assert.ok(!guardado.includes(codigo), 'o token está em texto no banco');

    // O mesmo link, aberto por outra pessoa: não vincula de novo.
    const outro = { id: 777, first_name: 'Outro', is_bot: false };
    await hook(fromCliente(`/start ${codigo}`, { from: outro }), segredo);
    await espera(async () => (await conversas()).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const segunda = (await conversas()).find((c) => c.chat_id === '777');
    assert.equal(segunda.contract, null);
  });

  it('um link vencido ou inventado não vincula, e o cliente é avisado', async () => {
    await ligar();
    await emitir();
    await getDb()('telegram_link_tokens').update({ expires_at: new Date(Date.now() - 1000) });
    const { url } = (await emitir()).body.data;
    const vencido = url.split('start=')[1];
    await getDb()('telegram_link_tokens').update({ expires_at: new Date(Date.now() - 1000) });
    chamadas = [];
    await hook(fromCliente(`/start ${vencido}`), segredo);
    await hook(fromCliente('/start tokeninventadotokeninventado', { from: { ...USER, id: 31 } }), segredo);
    await espera(async () => enviadas('sendMessage').length >= 2);
    assert.equal((await conversas()).some((c) => c.contract), false);
    assert.ok(enviadas('sendMessage').every((c) => /não vale mais/.test(c.body.text)));
  });

  it('a equipe vincula e desvincula; o vínculo do atendente vale mais que o de um link', async () => {
    await ligar();
    await hook(fromCliente('oi'), segredo);
    await espera(async () => (await conversas()).length === 1);
    const [conversa] = await conversas();
    const vinculada = await api(`/conversations/${conversa.id}/subscriber`, 'POST', { contract: CONTRATO });
    assert.equal(vinculada.status, 200, JSON.stringify(vinculada.body));
    assert.equal(vinculada.body.data.linked, true);
    assert.equal(vinculada.body.data.clientName, 'Maria Silva');
    assert.equal((await conversas())[0].bound_via, 'operator');
    const { url } = (await emitir()).body.data;
    await hook(fromCliente(`/start ${url.split('start=')[1]}`), segredo);
    await espera(async () => enviadas('sendMessage').some((c) => /já está vinculado/.test(c.body.text)));
    const desvinculada = await api(`/conversations/${conversa.id}/subscriber`, 'DELETE');
    assert.equal(desvinculada.body.data.linked, false);
  });

  it('o serviço emite link também para a conta do portal sem contrato: 404', async () => {
    await ligar();
    await assert.rejects(
      runInTenant(tenantId, () => TelegramLinkTokenService.createForPortalCustomer({ id: 1, device_id: 'SEM-LINK' })),
      (error) => error.code === 'subscriber_not_found'
    );
  });
});

describe('isolamento e segredo', () => {
  it('um provedor não vê a conversa de outro', async () => {
    await ligar();
    await hook(fromCliente('oi'), segredo);
    await espera(async () => (await conversas()).length === 1);
    const outro = await insertReturningId('tenants', { slug: `outro-${Date.now()}`, name: 'Outro Provedor', status: 'active', kind: 'provider' });
    const visto = await runInTenant(outro, async () => {
      const { default: TelegramConversation } = await import('../src/models/TelegramConversation.js');
      return TelegramConversation.listRecent();
    });
    assert.deepEqual(visto, []);
    // E o segredo deste provedor não abre o webhook do outro.
    assert.equal((await hook(fromCliente('oi'), segredo, outro)).status, 401);
  });

  it('o token do bot nunca aparece numa falha de envio nem no log', async () => {
    const avisos = [];
    const realWarn = console.warn;
    const realError = console.error;
    console.warn = (...a) => avisos.push(a.join(' '));
    console.error = (...a) => avisos.push(a.join(' '));
    try {
      await ligar();
      await hook(fromCliente('oi'), segredo);
      await espera(async () => (await conversas()).length === 1);
      const [conversa] = await conversas();
      setTelegramFetcher(async () => { throw new Error(`falha em https://api.telegram.org/bot${TOKEN}/sendMessage`); });
      const r = await api(`/conversations/${conversa.id}/messages`, 'POST', { text: 'oi' });
      assert.equal(r.status, 502);
      assert.ok(!JSON.stringify(r.body).includes(TOKEN));
    } finally {
      console.warn = realWarn;
      console.error = realError;
      setTelegramFetcher(async (url, options) => {
        const body = JSON.parse(options.body);
        chamadas.push({ url, body });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    }
    assert.ok(!avisos.join('\n').includes(TOKEN), 'o token foi parar no log');
  });
});
