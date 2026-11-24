import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { asTenant, authHeaders, call, defaultTenantId, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { setTelegramFetcher } = await import('../src/services/telegramClient.js');
const { resetTelegramChatRateLimit } = await import('../src/services/telegramInboundService.js');
const { default: TelegramConversation } = await import('../src/models/TelegramConversation.js');
const { default: WaBotService } = await import('../src/services/waBotService.js');
const { default: TelegramCustomerBot } = await import('../src/models/TelegramCustomerBot.js');
const { encryptBotToken } = await import('../src/services/telegramCustomerBotService.js');

/**
 * O bot de CLIENTES do Telegram: responde fatura, conexão e menu a quem está
 * vinculado a um contrato.
 *
 * Os construtores de resposta são os do bot do WhatsApp (já cobertos por
 * `whatsapp-bot.test.js`): aqui eles são trocados por falsos para provar o que
 * é DESTE canal — quando o bot responde e quando fica calado, a ordem das
 * partes da fatura, a pausa do atendente, o teto por hora, e que quem não está
 * vinculado não recebe dado de contrato.
 */
const TOKEN = '555666777:AAHcliente-token-do-bot-de-clientes-bem-longo';
const BASE = 'https://painel.exemplo.test';
const CONTRATO = 'CONTRATO-BOT-1';
const USER = { id: 6601, first_name: 'Maria', is_bot: false };

let panelUrl;
let token;
let tenantId;
let chamadas = [];
let segredo;
let nextMessageId = 900;
let realBase;
let responder;
let chamadasConstrutor;
const reais = {};

const api = (path, method = 'GET', body) => call(`${panelUrl}/api/telegram-chat${path}`, { method, headers: authHeaders(token), body });
const hook = (update, secret) => call(`${panelUrl}/api/telegram-customer-webhook/${tenantId}`, {
  method: 'POST', headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : {}, body: update
});
let msgSeq = 1;
const fala = (text, from = USER) => ({
  update_id: msgSeq,
  message: { message_id: msgSeq++, date: Math.floor(Date.now() / 1000), text, from, chat: { id: from.id, type: 'private' } }
});
const enviadas = () => chamadas.filter((c) => c.url.endsWith('/sendMessage'));
const textos = () => enviadas().map((c) => c.body.text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function espera(fn, ms = 2000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(20);
  }
  return false;
}
const conversa = () => getDb()('telegram_conversations').first();

/** Manda uma mensagem e espera as respostas do bot (`n` mensagens) ou, com 0, o silêncio. */
async function diz(text, n = 1, from = USER) {
  const antes = enviadas().length;
  await hook(fala(text, from), segredo);
  if (n === 0) {
    await sleep(250);
    assert.equal(enviadas().length, antes, `o bot respondeu a "${text}"`);
    return [];
  }
  assert.ok(await espera(() => enviadas().length >= antes + n), `o bot não respondeu a "${text}"`);
  await sleep(60);
  return textos().slice(antes);
}

/**
 * O bot pronto, direto no banco (o painel limita as chamadas administrativas a
 * 60 por minuto, e cada caso precisaria de três): o token cifrado, o hash do
 * segredo do webhook e `auto_reply`. A tela de ligar tem os seus próprios casos.
 */
async function preparar({ autoReply = true, vincular = true } = {}) {
  segredo = 'segredo-do-webhook-de-teste';
  await asTenant(() => TelegramCustomerBot.create({
    bot_username: 'provedor_clientes_bot',
    token: encryptBotToken(TOKEN),
    enabled: true,
    auto_reply: autoReply,
    webhook_secret_hash: crypto.createHash('sha256').update(segredo).digest('hex')
  }));
  // A primeira mensagem cria a conversa; o "/start" sozinho responde a saudação da etapa 1.
  await hook(fala('/start'), segredo);
  await espera(async () => Boolean(await conversa()));
  await espera(() => enviadas().length >= 1);
  if (vincular) {
    const c = await conversa();
    await asTenant(() => TelegramConversation.update(c.id, { contract: CONTRATO, bound_via: 'operator' }));
  }
  chamadas = [];
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  tenantId = await defaultTenantId();
  realBase = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = BASE;
  for (const nome of ['partesFatura', 'textoSinal', 'textoQueda', 'textoManutencao', 'textoPortal', 'textoLiberacao']) reais[nome] = WaBotService[nome];
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
  await insertReturningId('sgp_links', { device_id: 'ONT-BOT-1', contract: CONTRATO, client_name: 'Maria Silva', state: 'active' });
});

after(async () => {
  Object.assign(WaBotService, reais);
  setTelegramFetcher(null);
  if (realBase === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = realBase;
  WaAlertService.stop();
  await stopTestServers();
});

beforeEach(async () => {
  for (const tabela of ['telegram_notices', 'telegram_messages', 'telegram_link_tokens', 'telegram_conversations', 'telegram_customer_bots']) {
    await getDb()(tabela).del();
  }
  chamadas = [];
  responder = null;
  segredo = undefined;
  resetTelegramChatRateLimit();
  chamadasConstrutor = [];
  // Construtores falsos: gravam como foram chamados e devolvem textos reconhecíveis.
  WaBotService.partesFatura = async (link) => { chamadasConstrutor.push(['fatura', link]); return ['FATURA valor e vencimento', 'PIX-123', 'LINHA-456']; };
  WaBotService.textoSinal = async (link) => { chamadasConstrutor.push(['sinal', link]); return 'SINAL ok -22 dBm'; };
  WaBotService.textoQueda = async () => { chamadasConstrutor.push(['queda']); return null; };
  WaBotService.textoManutencao = async () => { chamadasConstrutor.push(['manutencao']); return null; };
  WaBotService.textoPortal = async () => { chamadasConstrutor.push(['portal']); return 'DICA do portal'; };
  WaBotService.textoLiberacao = async () => { chamadasConstrutor.push(['liberacao']); return 'LIBERADO'; };
});

describe('ligar as respostas automáticas', () => {
  it('vem desligado: o cliente vinculado escreve e o bot fica calado', async () => {
    await preparar({ autoReply: false });
    await diz('fatura', 0);
    assert.deepEqual(chamadasConstrutor, []);
  });

  it('só liga com o bot guardado, só com booleano, e vai para a trilha', async () => {
    assert.equal((await api('/bot/auto-reply', 'POST', { enabled: true })).status, 409);
    assert.equal((await api('/bot', 'PUT', { token: TOKEN })).status, 201);
    assert.equal((await api('/bot/auto-reply', 'POST', { enabled: 'sim' })).body.code, 'invalid_body');
    const ligado = await api('/bot/auto-reply', 'POST', { enabled: true });
    assert.equal(ligado.status, 200, JSON.stringify(ligado.body));
    assert.equal(ligado.body.data.autoReply, true);
    assert.equal((await api('/bot')).body.data.autoReply, true);
    const trilha = await getDb()('audit_log').where({ action: 'telegram_chat_bot.changed' }).orderBy('id', 'desc').first();
    assert.deepEqual(JSON.parse(trilha.detail), { change: 'autoReply', enabled: true });
    assert.equal((await api('/bot/auto-reply', 'POST', { enabled: false })).body.data.autoReply, false);
  });
});

describe('o que o bot responde a quem está vinculado', () => {
  it('"oi" traz o menu, e a resposta é do bot (conta no teto)', async () => {
    await preparar();
    const [menu] = await diz('oi');
    assert.match(menu, /boleto/i);
    assert.ok(!/libera/i.test(menu), 'o menu ofereceu a liberação, que não existe no Telegram');
    const saida = (await getDb()('telegram_messages').where({ direction: 'out' }).orderBy('id')).at(-1);
    assert.equal(saida.source, 'bot');
  });

  it('fatura sai em partes, na ordem, com o contrato do cliente', async () => {
    await preparar();
    const partes = await diz('segunda via do boleto', 3);
    assert.deepEqual(partes, ['FATURA valor e vencimento', 'PIX-123', 'LINHA-456']);
    assert.deepEqual(chamadasConstrutor[0], ['fatura', { contract: CONTRATO, device_id: 'ONT-BOT-1' }]);
  });

  it('"1" é a fatura e "2" é a conexão (o menu numerado)', async () => {
    await preparar();
    assert.equal((await diz('1', 3)).at(0), 'FATURA valor e vencimento');
    assert.deepEqual(await diz('2'), ['SINAL ok -22 dBm']);
  });

  it('conexão: a manutenção do nó vence a queda, que vence o sinal', async () => {
    await preparar();
    WaBotService.textoManutencao = async () => 'MANUTENCAO no seu nó';
    assert.deepEqual(await diz('estou sem internet'), ['MANUTENCAO no seu nó']);
    WaBotService.textoManutencao = async () => null;
    WaBotService.textoQueda = async () => 'QUEDA na região';
    assert.deepEqual(await diz('caiu a internet'), ['QUEDA na região']);
    WaBotService.textoQueda = async () => null;
    assert.deepEqual(await diz('sem sinal'), ['SINAL ok -22 dBm']);
  });

  it('o bot não passa o telefone do WhatsApp: o Telegram não tem', async () => {
    await preparar();
    let recebido;
    WaBotService.textoQueda = async (link, quem) => { recebido = quem; return null; };
    await diz('sem internet');
    assert.equal(recebido.wa_phone_e164, null);
    assert.ok(Number.isInteger(recebido.id));
  });

  it('senha, Wi-Fi e reiniciar recebem só a dica do portal, sem consultar fatura nem sinal', async () => {
    await preparar();
    assert.deepEqual(await diz('qual a senha do wifi?'), ['DICA do portal']);
    assert.deepEqual(chamadasConstrutor.map((c) => c[0]), ['portal']);
  });

  it('"quero liberar" recebe a FATURA: a liberação em confiança não é oferecida no Telegram', async () => {
    await preparar();
    const partes = await diz('quero liberar', 3);
    assert.equal(partes[0], 'FATURA valor e vencimento');
    assert.ok(!chamadasConstrutor.some((c) => c[0] === 'liberacao'), 'pediu a liberação ao SGP pelo Telegram');
  });

  it('uma falha ao montar a resposta passa para um atendente, e não é silêncio', async () => {
    await preparar();
    WaBotService.partesFatura = async () => { throw new Error('SGP fora do ar'); };
    const [passagem] = await diz('boleto');
    assert.ok(passagem && !/SGP fora/.test(passagem), 'o erro vazou para o cliente');
  });

  it('um anexo (sem texto) não é respondido pelo bot', async () => {
    await preparar();
    const foto = fala(undefined);
    delete foto.message.text;
    foto.message.photo = [{ file_id: 'x' }];
    await hook(foto, segredo);
    await sleep(250);
    assert.equal(enviadas().length, 0);
  });
});

describe('quem não está vinculado', () => {
  it('não recebe dado nenhum: só a orientação para pedir o link', async () => {
    await preparar({ vincular: false });
    const [orientacao] = await diz('quero minha fatura');
    assert.match(orientacao, /link do Telegram/);
    assert.deepEqual(chamadasConstrutor, [], 'consultou dado de contrato de um chat não vinculado');
  });

  it('pedir um atendente vale mesmo sem vínculo, e pausa o bot', async () => {
    await preparar({ vincular: false });
    assert.equal((await diz('atendente')).length, 1);
    assert.ok((await conversa()).bot_paused_until);
    await diz('fatura', 0);
  });
});

describe('as travas', () => {
  it('um atendente que respondeu pelo painel cala o bot por 30 minutos', async () => {
    await preparar();
    const c = await conversa();
    assert.equal((await api(`/conversations/${c.id}/messages`, 'POST', { text: 'Oi Maria, sou o João' })).status, 201);
    chamadas = [];
    await diz('fatura', 0);
    // Passados os 30 minutos, volta.
    await getDb()('telegram_messages').where({ source: 'operator' }).update({ created_at: new Date(Date.now() - 31 * 60_000) });
    assert.equal((await diz('fatura', 3)).length, 3);
  });

  it('"atendente" cala o bot por 4 horas; só o cliente pedindo o menu o traz de volta', async () => {
    await preparar();
    await diz('quero falar com um atendente');
    const pausado = new Date((await conversa()).bot_paused_until).getTime();
    assert.ok(pausado - Date.now() > 3.9 * 3600_000 && pausado - Date.now() <= 4 * 3600_000 + 1000);
    await diz('obrigado', 0);
    await diz('fatura', 0);
    const [menu] = await diz('menu');
    assert.match(menu, /boleto/i);
    assert.equal((await conversa()).bot_paused_until, null);
    assert.equal((await diz('fatura', 3)).length, 3);
  });

  it('no máximo 6 respostas do bot por hora (o laço de dois robôs)', async () => {
    await preparar();
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await diz('sinal');
    }
    await diz('sinal', 0);
    // A hora passou: volta.
    await getDb()('telegram_messages').where({ source: 'bot' }).update({ created_at: new Date(Date.now() - 61 * 60_000) });
    assert.equal((await diz('sinal')).length, 1);
  });

  it('aviso e confirmação do vínculo não gastam o teto do bot', async () => {
    await preparar();
    const c = await conversa();
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await getDb()('telegram_messages').insert({
        tenant_id: tenantId, conversation_id: c.id, direction: 'out', body: `aviso ${i}`,
        source: i % 2 ? 'notice' : 'system', delivery_status: 'sent', external_id: `${c.chat_id}:${7000 + i}`
      });
    }
    assert.equal((await diz('sinal')).length, 1);
  });

  it('"sair" solto não vira menu', async () => {
    await preparar();
    await diz('sair', 0);
  });

  it('as palavras de "não recebo avisos" (/parar) continuam sendo do bot de avisos', async () => {
    await preparar();
    const [resposta] = await diz('/parar');
    assert.match(resposta, /não vai mais receber avisos/);
    assert.equal(chamadasConstrutor.length, 0);
  });

  it('cliente que bloqueou o bot: a resposta não derruba o webhook nem trava a conversa', async () => {
    await preparar();
    responder = (url) => (url.endsWith('/sendMessage')
      ? { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } }
      : null);
    const r = await hook(fala('fatura'), segredo);
    assert.equal(r.status, 200);
    await espera(async () => (await conversa()).blocked_at);
    assert.ok((await conversa()).blocked_at);
  });
});
