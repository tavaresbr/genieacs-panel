import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.META_APP_SECRET = 'segredo-do-app-meta';
process.env.MESSENGER_VERIFY_TOKEN = 'token-de-verificacao';

const { authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { setMetaGraphFetcher } = await import('../src/services/metaGraphClient.js');
const { encryptPageToken } = await import('../src/services/messengerPageService.js');
const { default: MessengerOutboxWorker } = await import('../src/services/messengerOutboxWorker.js');
const { default: MessengerMessage, RECLAIM_MS } = await import('../src/models/MessengerMessage.js');
const { MAX_ATTEMPTS, retryDelayMs, retryScheduleMs } = await import('../src/utils/messenger/messengerBackoff.js');
const { classifyGraphFailure } = await import('../src/utils/messenger/messengerSendFailure.js');
const { retryScheduleMs: retryScheduleWhatsApp, MAX_ATTEMPTS: MAX_ATTEMPTS_WHATSAPP } = await import('../src/services/waOutboxWorker.js');

/**
 * A fila de saída do Messenger: o envio tenta já, e o que a Meta ou a rede não
 * aguentaram espera nova tentativa com recuo — sem se perder, sem sair duas
 * vezes, sem passar na frente da irmã mais antiga e sem desrespeitar a janela.
 */
let panelUrl;
let token;
let alfa;
let beta;
const calls = [];
let responder = null; // (call) => Response | null ; null = sucesso

const ok = () => new Response(JSON.stringify({ message_id: `m.out.${crypto.randomUUID()}` }), { status: 200 });
const refused = (status, code, message = 'recusado') => new Response(JSON.stringify({ error: { code, message } }), { status });
const down = () => new Response('{}', { status: 503 });

const api = (p, options = {}) => call(`${panelUrl}/api/messenger${p}`, { headers: authHeaders(token), ...options });
const db = () => getDb();
const row = (id) => db()('messenger_messages').where({ id }).first();

async function newConversation(tenant, psid, { inboundAgoMs = 60_000 } = {}) {
  const page = await db()('messenger_pages').where({ tenant_id: tenant }).first();
  const [id] = await db()('messenger_conversations').insert({
    tenant_id: tenant, page_row_id: page.id, psid, last_inbound_at: new Date(Date.now() - inboundAgoMs)
  }).returning('id');
  return typeof id === 'object' ? id.id : id;
}
const send = (conversationId, text) => api(`/conversations/${conversationId}/messages`, { method: 'POST', body: { text } });
/** Faz a mensagem vencer agora, como se o recuo tivesse passado. */
const makeDue = (id) => db()('messenger_messages').where({ id }).update({ next_attempt_at: new Date(Date.now() - 1000) });

before(async () => {
  ({ panelUrl } = await startTestServers());
  setMetaGraphFetcher(async (url, init) => {
    const entry = { url: String(url), token: String(init.headers.Authorization).replace('Bearer ', ''), body: JSON.parse(init.body) };
    calls.push(entry);
    return (responder && responder(entry)) || ok();
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
  alfa = (await db()('tenants').orderBy('id', 'asc').first()).id;
  await db()('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db()('tenants').where({ slug: 'beta' }).first()).id;
  await db()('messenger_pages').insert({ tenant_id: alfa, page_id: '1000000001', page_name: 'A', page_token: encryptPageToken('tok-alfa'), status: 'connected' });
  await db()('messenger_pages').insert({ tenant_id: beta, page_id: '2000000002', page_name: 'B', page_token: encryptPageToken('tok-beta'), status: 'connected' });
});
after(async () => {
  setMetaGraphFetcher(null);
  await stopTestServers();
});

describe('as regras puras da fila', () => {
  it('a curva de recuo é a mesma da fila do WhatsApp', () => {
    assert.equal(MAX_ATTEMPTS, MAX_ATTEMPTS_WHATSAPP);
    assert.deepEqual(retryScheduleMs(), retryScheduleWhatsApp());
    assert.deepEqual(retryScheduleMs(), [30_000, 60_000, 120_000, 240_000, 480_000, 960_000]);
    assert.equal(retryDelayMs(50), 30 * 60_000, 'o teto de meia hora');
  });

  it('classifica a falha: transporte e cota passam; recusa nomeada pela Meta não', () => {
    const r = (status, code) => classifyGraphFailure({ status, data: code ? { error: { code } } : null });
    for (const passageira of [r(0), r(503), r(500), r(429), r(400, 4), r(400, 17), r(400, 32), r(400, 613), r(400, 2), r(400, 1)]) {
      assert.equal(passageira.permanent, false);
    }
    for (const permanente of [r(400, 10), r(400, 100), r(400, 200), r(400, 551), r(403, 10), r(400)]) {
      assert.equal(permanente.permanent, true);
      assert.equal(permanente.tokenInvalid, false);
    }
    assert.deepEqual(r(400, 190), { permanent: true, tokenInvalid: true });
    assert.deepEqual(r(401), { permanent: true, tokenInvalid: true });
  });
});

describe('o envio tenta já e só o que não aguentou espera', () => {
  it('o caso comum sai na hora: 201, enviada, com o mid, e a conversa avança', async () => {
    const conv = await newConversation(alfa, 'psid-ok');
    responder = null;
    const res = await send(conv, 'Olá');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.deliveryStatus, 'sent');
    const msg = await row(res.body.data.id);
    assert.match(msg.external_id, /^m\.out\./);
    assert.equal(msg.attempts, 1);
    assert.equal(msg.next_attempt_at, null);
    assert.ok((await db()('messenger_conversations').where({ id: conv }).first()).last_message_at);
  });

  it('falha passageira: 202, fica na fila com a tentativa e o motivo, e a hora da próxima', async () => {
    const conv = await newConversation(alfa, 'psid-down');
    responder = down;
    const antes = Date.now();
    const res = await send(conv, 'Segura aí');
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.data.deliveryStatus, 'queued');
    assert.equal(res.body.data.attempts, 1);
    const msg = await row(res.body.data.id);
    assert.equal(msg.external_id, null);
    const espera = new Date(msg.next_attempt_at).getTime() - antes;
    assert.ok(espera >= 29_000 && espera <= 32_000, `a primeira espera é de ~30 s: ${espera}`);
  });

  it('recusa permanente da Meta: 502, failed na primeira, sem fila', async () => {
    const conv = await newConversation(alfa, 'psid-refused');
    responder = () => refused(400, 100, 'parâmetro inválido');
    const res = await send(conv, 'x');
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'send_refused');
    assert.equal(res.body.data.deliveryStatus, 'failed');
    assert.match(res.body.data.deliveryError, /parâmetro inválido/);
    const msg = await row(res.body.data.id);
    assert.equal(msg.attempts, 1);
    assert.equal(msg.next_attempt_at, null);
  });
});

describe('o laço de fundo', () => {
  let convId;
  let msgId;
  before(async () => {
    convId = await newConversation(alfa, 'psid-loop');
    responder = down;
    msgId = (await send(convId, 'Tente de novo')).body.data.id;
  });

  it('antes de vencer a espera, a passada não toca na mensagem', async () => {
    calls.length = 0;
    await MessengerOutboxWorker.tick();
    assert.equal(calls.filter((c) => c.body.message.text === 'Tente de novo').length, 0);
    assert.equal((await row(msgId)).attempts, 1);
  });

  it('vencida a espera, a passada reenvia e a mensagem sai UMA vez', async () => {
    await makeDue(msgId);
    responder = null;
    calls.length = 0;
    const summary = await MessengerOutboxWorker.tick();
    assert.ok(summary.sent >= 1);
    const msg = await row(msgId);
    assert.equal(msg.delivery_status, 'sent');
    assert.equal(msg.attempts, 2);
    assert.match(msg.external_id, /^m\.out\./);
    assert.equal(calls.filter((c) => c.body.message.text === 'Tente de novo').length, 1);
    // Rodar de novo não reenvia o que já saiu.
    calls.length = 0;
    await MessengerOutboxWorker.tick();
    assert.equal(calls.filter((c) => c.body.message.text === 'Tente de novo').length, 0);
  });

  it('esgotadas as sete tentativas, vira failed com o último motivo', async () => {
    const conv = await newConversation(alfa, 'psid-exhaust');
    responder = down;
    const id = (await send(conv, 'Nunca chega')).body.data.id;
    for (let tentativa = 2; tentativa <= MAX_ATTEMPTS; tentativa += 1) {
      assert.equal((await row(id)).delivery_status, 'queued', `antes da tentativa ${tentativa}`);
      // eslint-disable-next-line no-await-in-loop -- uma tentativa por vez é o que se testa
      await makeDue(id);
      // eslint-disable-next-line no-await-in-loop
      await MessengerOutboxWorker.tick();
    }
    const msg = await row(id);
    assert.equal(msg.delivery_status, 'failed');
    assert.equal(msg.attempts, MAX_ATTEMPTS);
    assert.equal(msg.next_attempt_at, null);
    assert.ok(msg.delivery_error);
    await makeDue(id);
    calls.length = 0;
    await MessengerOutboxWorker.tick();
    assert.equal(calls.filter((c) => c.body.message.text === 'Nunca chega').length, 0, 'failed não volta à fila');
  });

  it('o recuo cresce a cada falha seguida', async () => {
    const conv = await newConversation(alfa, 'psid-backoff');
    responder = down;
    const id = (await send(conv, 'Recuo')).body.data.id;
    const esperas = [];
    for (let i = 0; i < 3; i += 1) {
      const msg = await row(id);
      esperas.push(new Date(msg.next_attempt_at).getTime() - Date.now());
      // eslint-disable-next-line no-await-in-loop
      await makeDue(id);
      // eslint-disable-next-line no-await-in-loop
      await MessengerOutboxWorker.tick();
    }
    assert.ok(esperas[1] > esperas[0] * 1.5 && esperas[2] > esperas[1] * 1.5, `dobra a cada vez: ${esperas}`);
  });
});

describe('o que a fila nunca faz', () => {
  it('a janela fechou enquanto esperava: falha permanente, SEM chamar a Meta', async () => {
    const conv = await newConversation(alfa, 'psid-window');
    responder = down;
    const id = (await send(conv, 'Tarde demais')).body.data.id;
    await db()('messenger_conversations').where({ id: conv }).update({ last_inbound_at: new Date(Date.now() - 25 * 3600_000) });
    await makeDue(id);
    responder = null;
    calls.length = 0;
    await MessengerOutboxWorker.tick();
    const msg = await row(id);
    assert.equal(msg.delivery_status, 'failed');
    assert.match(msg.delivery_error, /24-hour/);
    assert.equal(calls.filter((c) => c.body.message.text === 'Tarde demais').length, 0);
  });

  it('token inválido: a mensagem falha e a Página passa a "requer atenção"', async () => {
    const conv = await newConversation(alfa, 'psid-token');
    responder = () => refused(400, 190, 'token expirado');
    const res = await send(conv, 'Sem token');
    assert.equal(res.body.data.deliveryStatus, 'failed');
    const page = await db()('messenger_pages').where({ tenant_id: alfa }).first();
    assert.equal(page.status, 'error');
    assert.match(page.webhook_error, /token expirado/);
    // Com a Página em erro, novas respostas são recusadas na hora.
    const depois = await send(conv, 'Outra');
    assert.equal(depois.status, 409);
    assert.equal(depois.body.code, 'page_unavailable');
    await db()('messenger_pages').where({ id: page.id }).update({ status: 'connected', webhook_error: null });
  });

  it('duas passadas ao mesmo tempo: a mensagem é pega e enviada uma vez só', async () => {
    const conv = await newConversation(alfa, 'psid-race');
    responder = down;
    const id = (await send(conv, 'Corrida')).body.data.id;
    await makeDue(id);
    responder = null;
    calls.length = 0;
    // `deliver` roda dentro do escopo do provedor, como na passada de verdade.
    const [a, b] = await Promise.all([
      runInTenant(alfa, () => MessengerOutboxWorker.deliver(id)),
      runInTenant(alfa, () => MessengerOutboxWorker.deliver(id))
    ]);
    assert.deepEqual([a.outcome, b.outcome].sort(), ['claimed_elsewhere', 'sent']);
    assert.equal(calls.filter((c) => c.body.message.text === 'Corrida').length, 1);
  });

  it('retoma a mensagem abandonada em "enviando", mas não a que está no ar agora', async () => {
    const conv = await newConversation(alfa, 'psid-stale');
    responder = down;
    const id = (await send(conv, 'Abandonada')).body.data.id;
    responder = null;
    await db()('messenger_messages').where({ id }).update({ delivery_status: 'sending', claimed_at: new Date(Date.now() - 60_000), next_attempt_at: null });
    calls.length = 0;
    await MessengerOutboxWorker.tick();
    assert.equal(calls.filter((c) => c.body.message.text === 'Abandonada').length, 0, 'ainda no ar: não retoma');
    await db()('messenger_messages').where({ id }).update({ claimed_at: new Date(Date.now() - RECLAIM_MS - 1000) });
    await MessengerOutboxWorker.tick();
    assert.equal(calls.filter((c) => c.body.message.text === 'Abandonada').length, 1);
    assert.equal((await row(id)).delivery_status, 'sent');
  });

  it('não passa na frente da irmã mais antiga que espera nova tentativa', async () => {
    const conv = await newConversation(alfa, 'psid-order');
    responder = down;
    const primeira = (await send(conv, 'Primeira')).body.data.id;
    // A segunda é digitada enquanto a primeira espera: fica atrás dela.
    responder = null;
    calls.length = 0;
    const segunda = await db()('messenger_messages').insert({
      tenant_id: alfa, conversation_id: conv, direction: 'out', body: 'Segunda', source: 'operator', delivery_status: 'queued'
    }).returning('id');
    const segundaId = typeof segunda[0] === 'object' ? segunda[0].id : segunda[0];
    await MessengerOutboxWorker.tick();
    assert.equal(calls.filter((c) => ['Primeira', 'Segunda'].includes(c.body.message.text)).length, 0, 'a segunda espera a primeira');
    await makeDue(primeira);
    await MessengerOutboxWorker.tick();
    const textos = calls.map((c) => c.body.message.text).filter((t) => ['Primeira', 'Segunda'].includes(t));
    assert.deepEqual(textos, ['Primeira', 'Segunda'], 'saem na ordem em que foram escritas');
    assert.equal((await row(segundaId)).delivery_status, 'sent');
  });

  it('o eco chegou antes da confirmação: a linha do eco é adotada e não sai uma segunda bolha', async () => {
    const conv = await newConversation(alfa, 'psid-echo');
    responder = down;
    const id = (await send(conv, 'Com eco')).body.data.id;
    await makeDue(id);
    // A Meta aceita, e o eco (is_echo) já está gravado com o mesmo mid.
    responder = () => new Response(JSON.stringify({ message_id: 'm.eco.1' }), { status: 200 });
    await db()('messenger_messages').insert({
      tenant_id: alfa, conversation_id: conv, direction: 'out', external_id: 'm.eco.1', body: 'Com eco', source: 'page', delivery_status: 'sent'
    });
    await MessengerOutboxWorker.tick();
    const doConv = await db()('messenger_messages').where({ conversation_id: conv, direction: 'out' });
    assert.equal(doConv.length, 1, 'uma bolha só');
    assert.equal(doConv[0].external_id, 'm.eco.1');
    assert.equal(doConv[0].source, 'operator', 'a origem é a de quem escreveu, não "page"');
    assert.equal(await row(id), undefined, 'a linha da fila saiu');
  });
});

describe('cada provedor com a sua fila', () => {
  it('uma passada atende os dois provedores, cada um com o token da própria Página', async () => {
    const convA = await newConversation(alfa, 'psid-iso-a');
    const convB = await newConversation(beta, 'psid-iso-b');
    responder = down;
    const idA = (await send(convA, 'Do alfa')).body.data.id;
    const [idBRow] = await db()('messenger_messages').insert({
      tenant_id: beta, conversation_id: convB, direction: 'out', body: 'Do beta', source: 'operator',
      delivery_status: 'queued', next_attempt_at: new Date(Date.now() - 1000)
    }).returning('id');
    const idB = typeof idBRow === 'object' ? idBRow.id : idBRow;
    await makeDue(idA);
    responder = null;
    calls.length = 0;
    await MessengerOutboxWorker.tick();
    const doAlfa = calls.find((c) => c.body.message.text === 'Do alfa');
    const doBeta = calls.find((c) => c.body.message.text === 'Do beta');
    assert.equal(doAlfa.token, 'tok-alfa');
    assert.match(doAlfa.url, /\/1000000001\/messages$/);
    assert.equal(doBeta.token, 'tok-beta');
    assert.match(doBeta.url, /\/2000000002\/messages$/);
    assert.equal((await row(idA)).delivery_status, 'sent');
    assert.equal((await row(idB)).delivery_status, 'sent');
  });

  it('passada ociosa: sem nada vencido, nenhuma chamada à Meta', async () => {
    calls.length = 0;
    assert.deepEqual(await MessengerOutboxWorker.tick(), { sent: 0, failed: 0, retry: 0 });
    assert.equal(calls.length, 0);
    assert.deepEqual(await MessengerMessage.providersWithSendable(), []);
  });
});

describe('a confirmação do vínculo também passa pela fila', () => {
  it('a Meta fora do ar na hora: a confirmação espera e sai na próxima passada', async () => {
    // Um link de vínculo emitido para um contrato, aberto por quem ainda não tem conversa.
    await db()('sgp_links').insert({ tenant_id: alfa, device_id: 'ont-fila', contract: 'CT-FILA', client_name: 'Fila', state: 'active' });
    const { url } = (await api('/links', { method: 'POST', body: { contract: 'CT-FILA' } })).body.data;
    const ref = new URL(url).searchParams.get('ref');
    const raw = JSON.stringify({
      object: 'page',
      entry: [{ id: '1000000001', messaging: [{ sender: { id: 'psid-conf-fila' }, recipient: { id: '1000000001' }, timestamp: Date.now(), referral: { ref, source: 'SHORTLINK', type: 'OPEN_THREAD' } }] }]
    });
    const sig = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex')}`;
    responder = down;
    const res = await fetch(`${panelUrl}/api/messenger-webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
    assert.equal(res.status, 200, 'o webhook responde 200 mesmo com a Meta fora');
    const conv = await db()('messenger_conversations').where({ tenant_id: alfa, psid: 'psid-conf-fila' }).first();
    assert.equal(conv.contract, 'CT-FILA', 'o vínculo está feito');
    const [msg] = await db()('messenger_messages').where({ conversation_id: conv.id });
    assert.equal(msg.source, 'system');
    assert.equal(msg.delivery_status, 'queued', 'a confirmação espera a próxima tentativa, em vez de se perder');

    await makeDue(msg.id);
    responder = null;
    await MessengerOutboxWorker.tick();
    assert.equal((await row(msg.id)).delivery_status, 'sent');
  });
});
