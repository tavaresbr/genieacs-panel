import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: WaOutboxWorker } = await import('../src/services/waOutboxWorker.js');

const SUPPORT = 'painel-suporte';
const SUPPORT_TOKEN = 'token-suporte-111';
const BACKUP = 'painel-reserva';
const BACKUP_TOKEN = 'token-reserva-222';

/**
 * The Evolution server has to look public.
 *
 * `evolutionClient` runs every target through the SSRF guard, which blocks
 * loopback by literal — so a stub on 127.0.0.1 can never be reached by its own
 * address, and turning that check off for tests would be testing a different
 * program. Instead the account points at a name that resolves nowhere (so the
 * guard's DNS check passes it as "not internal") and `fetch` is rewritten onto
 * the stub. Everything past that line is real: a real socket, real status
 * codes, real bodies.
 */
const EVO_BASE = 'https://evo.provedor.test';

let panelUrl;
let token;
let supportId;
let backupId;
let evoServer;
let evoLocalUrl;
let realFetch;

/** What the stub answers with, per test. */
const stub = {
  textStatus: 200,
  textBody: null,
  audioStatus: 200,
  mediaStatus: 200,
  nextId: 0
};

/** Every request the stub saw: `{ path, apikey, payload }`. */
const requests = [];

function startEvolutionStub() {
  evoServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const path = req.url.split('?')[0];
      requests.push({ path, apikey: req.headers.apikey || null, payload });

      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const accepted = () => {
        stub.nextId += 1;
        return { key: { id: `EVO-${stub.nextId}`, remoteJid: payload.number }, status: 'PENDING' };
      };

      if (path.startsWith('/message/sendText/')) {
        return stub.textStatus === 200
          ? send(200, accepted())
          : send(stub.textStatus, stub.textBody ?? { message: 'numero invalido' });
      }
      if (path.startsWith('/message/sendWhatsAppAudio/')) {
        return stub.audioStatus === 200
          ? send(200, accepted())
          : send(stub.audioStatus, { message: 'ptt route unavailable' });
      }
      if (path.startsWith('/message/sendMedia/')) {
        return stub.mediaStatus === 200
          ? send(200, accepted())
          : send(stub.mediaStatus, { message: 'media recusada' });
      }
      return send(404, { message: 'unknown route' });
    });
  });
  return new Promise((resolve) => {
    evoServer.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${evoServer.address().port}`);
    });
  });
}

/** A fresh thread per test, so no test depends on another one's leftovers. */
let threadSeq = 0;
async function newConversation({ accountId = supportId, phone = null, lid = null, thread } = {}) {
  threadSeq += 1;
  return WaConversation.ensure({
    accountId,
    externalThreadId: thread || `55939811104${String(threadSeq).padStart(2, '0')}@s.whatsapp.net`,
    waPhone: phone === null && lid === null ? `55939811104${String(threadSeq).padStart(2, '0')}` : phone,
    waLid: lid,
    pushName: 'Cliente'
  });
}

/**
 * Empties the outbox before a test that counts requests.
 *
 * `node:test` runs the file in order and the tests above leave queued rows
 * behind on purpose (the send route is supposed to enqueue and stop there), so
 * without this a pass would drain someone else's message and the count would
 * measure the wrong thing.
 */
async function clearOutbox() {
  await getDb()('wa_messages').where({ delivery_status: 'queued' }).del();
  requests.length = 0;
}

function post(conversationId, body) {
  return call(`${panelUrl}/api/whatsapp/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body
  });
}

const sendTextCalls = () => requests.filter((r) => r.path.startsWith('/message/sendText/'));
const audioCalls = () => requests.filter((r) => r.path.startsWith('/message/sendWhatsAppAudio/'));
const mediaCalls = () => requests.filter((r) => r.path.startsWith('/message/sendMedia/'));

before(async () => {
  ({ panelUrl } = await startTestServers());
  evoLocalUrl = await startEvolutionStub();

  realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(EVO_BASE)) return realFetch(evoLocalUrl + url.slice(EVO_BASE.length), init);
    return realFetch(input, init);
  };

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1' }
  });
  token = setup.body.data.token;

  await WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    rateLimitPerMin: 60
  });

  const support = await WhatsAppAccount.create({
    name: SUPPORT,
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(SUPPORT_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-suporte')
  });
  supportId = support.id;

  const backup = await WhatsAppAccount.create({
    name: BACKUP,
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    // Disconnected until the routing test needs it, so the fallback cannot be
    // what every other test was quietly exercising.
    status: 'disconnected',
    ...WhatsAppConfigService.encryptInstanceToken(BACKUP_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-reserva')
  });
  backupId = backup.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  WaOutboxWorker.stop();
  await new Promise((resolve) => evoServer.close(resolve));
  await stopTestServers();
});

describe('the send route enqueues and returns', () => {
  it('answers with a queued message and does not touch the server', async () => {
    const conversation = await newConversation();
    requests.length = 0;

    const { status, body } = await post(conversation.id, { body: 'bom dia' });
    assert.equal(status, 201);
    assert.equal(body.data.direction, 'out');
    assert.equal(body.data.deliveryStatus, 'queued');
    assert.equal(body.data.externalId, null);
    assert.ok(body.data.sentBy, 'the operator who sent it is recorded');
    assert.equal(requests.length, 0, 'enqueuing must not talk to Evolution');
  });

  it('refuses an empty message, a thread with no address, and an unknown thread', async () => {
    const conversation = await newConversation();
    const vazia = await post(conversation.id, { body: '   ' });
    assert.equal(vazia.status, 400);
    assert.equal(vazia.body.code, 'message_empty');

    const semEndereco = await newConversation({ thread: 'grupo-qualquer@g.us', phone: '', lid: '' });
    const sem = await post(semEndereco.id, { body: 'oi' });
    assert.equal(sem.status, 409);
    assert.equal(sem.body.code, 'no_destination');

    const inexistente = await post(999999, { body: 'oi' });
    assert.equal(inexistente.status, 404);
    assert.equal(inexistente.body.code, 'conversation_not_found');
  });

  it('requires an authenticated admin', async () => {
    const conversation = await newConversation();
    const { status } = await call(
      `${panelUrl}/api/whatsapp/conversations/${conversation.id}/messages`,
      { method: 'POST', body: { body: 'oi' } }
    );
    assert.equal(status, 401);
  });
});

describe('the outbox worker despatches', () => {
  it('sends a queued message and stores the id the server gave it', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'a caixa chegou?' });

    const summary = await WaOutboxWorker.tick();
    assert.equal(summary.sent, 1);

    const row = await WaMessage.getById(body.data.id);
    assert.equal(row.delivery_status, 'sent');
    // The id comes from the server's answer, not from anything we made up: it
    // is the only thing a delivery receipt can be matched against later.
    assert.equal(row.external_id, `EVO-${stub.nextId}`);
    assert.equal(row.delivery_error, null);
    assert.equal(sendTextCalls().length, 1);
    assert.equal(sendTextCalls()[0].payload.text, 'a caixa chegou?');
  });

  it('sends a message exactly once when two passes overlap', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'só uma vez' });
    requests.length = 0;

    await Promise.all([WaOutboxWorker.tick(), WaOutboxWorker.tick()]);

    assert.equal(sendTextCalls().length, 1, 'the loser of the claim must do nothing');
    const row = await WaMessage.getById(body.data.id);
    assert.equal(row.delivery_status, 'sent');
    assert.equal(row.attempts, 1);
  });

  it('records the failure, retries three times, and then stays failed', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'vai falhar' });
    requests.length = 0;
    stub.textStatus = 400;

    try {
      await WaOutboxWorker.tick();
      let row = await WaMessage.getById(body.data.id);
      // Still queued: a first failure is a retry, not a verdict.
      assert.equal(row.delivery_status, 'queued');
      assert.equal(row.attempts, 1);
      assert.match(row.delivery_error, /http_error/);
      assert.match(row.delivery_error, /numero invalido/);

      await WaOutboxWorker.tick();
      row = await WaMessage.getById(body.data.id);
      assert.equal(row.delivery_status, 'queued');
      assert.equal(row.attempts, 2);

      await WaOutboxWorker.tick();
      row = await WaMessage.getById(body.data.id);
      assert.equal(row.delivery_status, 'failed');
      assert.equal(row.attempts, 3);
      assert.equal(sendTextCalls().length, 3);

      // A fourth pass must not pick it up again.
      await WaOutboxWorker.tick();
      assert.equal(sendTextCalls().length, 3);
      assert.equal((await WaMessage.getById(body.data.id)).attempts, 3);
    } finally {
      stub.textStatus = 200;
    }
  });

  it('never lets one unsendable message stop the pass', async () => {
    await clearOutbox();
    // A thread whose number stops being usable after the message was queued —
    // a cadastro corrected to something that is not a phone number. Dispatch
    // throws for it, and the message queued behind it still has to go out.
    const quebrada = await newConversation();
    await post(quebrada.id, { body: 'sem destino' });
    await WaConversation.update(quebrada.id, { wa_phone_e164: '12', wa_lid: null });

    const boa = await newConversation();
    const { body } = await post(boa.id, { body: 'esta tem de sair' });
    requests.length = 0;

    const summary = await WaOutboxWorker.tick();
    assert.equal(summary.failed, 1);
    assert.equal(summary.sent, 1);
    assert.equal(sendTextCalls().length, 1);
    assert.equal((await WaMessage.getById(body.data.id)).delivery_status, 'sent');
  });
});

describe('audio is a voice bubble before it is a file', () => {
  const audio = {
    url: 'https://cdn.provedor.test/audios/1.ogg',
    type: 'audio/ogg; codecs=opus',
    name: 'recado.ogg'
  };

  it('does NOT fall back after a 2xx — a retry would send it twice', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: '', attachment: audio });
    requests.length = 0;

    await WaOutboxWorker.tick();

    assert.equal(audioCalls().length, 1);
    assert.equal(mediaCalls().length, 0, 'a 2xx audio must never be repeated as media');
    assert.equal((await WaMessage.getById(body.data.id)).delivery_status, 'sent');
  });

  it('falls back to sendMedia on a non-2xx', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'segue o áudio', attachment: audio });
    requests.length = 0;
    stub.audioStatus = 404;

    try {
      await WaOutboxWorker.tick();

      assert.equal(audioCalls().length, 1);
      assert.equal(mediaCalls().length, 1);
      assert.equal(mediaCalls()[0].payload.mediatype, 'audio');
      assert.equal(mediaCalls()[0].payload.media, audio.url);
      assert.equal(mediaCalls()[0].payload.fileName, audio.name);
      const row = await WaMessage.getById(body.data.id);
      assert.equal(row.delivery_status, 'sent');
      assert.ok(row.external_id, 'the id comes from the call that actually worked');
    } finally {
      stub.audioStatus = 200;
    }
  });

  it('sends anything else straight through sendMedia', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    await post(conversation.id, {
      body: 'a fatura',
      attachment: { url: 'https://cdn.provedor.test/f.pdf', type: 'application/pdf', name: 'f.pdf' }
    });
    requests.length = 0;

    await WaOutboxWorker.tick();
    assert.equal(audioCalls().length, 0);
    assert.equal(mediaCalls().length, 1);
    assert.equal(mediaCalls()[0].payload.mediatype, 'document');
  });
});

describe('an internal note is never sent', () => {
  it('is stored without a delivery status and the worker never sees it', async () => {
    const conversation = await newConversation();
    requests.length = 0;

    const { status, body } = await post(conversation.id, { body: 'cliente ligou também', isNote: true });
    assert.equal(status, 201);
    assert.equal(body.data.isNote, true);
    assert.equal(body.data.deliveryStatus, null);

    await WaOutboxWorker.tick();
    await WaOutboxWorker.tick();

    assert.equal(requests.length, 0, 'a note must never reach the server');
    const row = await WaMessage.getById(body.data.id);
    assert.equal(row.delivery_status, null);
    assert.equal(row.attempts, 0);
  });

  it('accepts a note on a thread that has no address at all', async () => {
    const semEndereco = await newConversation({ thread: 'grupo-2@g.us', phone: '', lid: '' });
    const { status } = await post(semEndereco.id, { body: 'anotação', isNote: true });
    assert.equal(status, 201);
  });
});

describe('an opt-out does not silence a reply', () => {
  it('lets the operator answer someone who asked not to be contacted', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    await WaOptOut.record({ waPhone: conversation.wa_phone_e164, origin: 'customer', reasonText: 'SAIR' });
    assert.equal(await WaOptOut.isActive({ waPhone: conversation.wa_phone_e164 }), true);
    requests.length = 0;

    // An opt-out means the provider does not INITIATE contact. Refusing to
    // answer a customer who wrote in would be a worse product, not a more
    // respectful one — campaigns and alerts enforce the list, the reply box
    // does not.
    const { status, body } = await post(conversation.id, { body: 'claro, já resolvo' });
    assert.equal(status, 201);

    await WaOutboxWorker.tick();
    assert.equal(sendTextCalls().length, 1);
    assert.equal((await WaMessage.getById(body.data.id)).delivery_status, 'sent');
  });
});

describe('routing picks the number the thread belongs to', () => {
  it('sends from the conversation own account', async () => {
    await clearOutbox();
    const conversation = await newConversation({ accountId: supportId });
    await post(conversation.id, { body: 'do número de suporte' });
    requests.length = 0;

    await WaOutboxWorker.tick();
    assert.equal(sendTextCalls()[0].path, `/message/sendText/${SUPPORT}`);
    assert.equal(sendTextCalls()[0].apikey, SUPPORT_TOKEN);
  });

  it('falls back to another connected number when that one is down', async () => {
    await clearOutbox();
    const conversation = await newConversation({ accountId: supportId });
    await post(conversation.id, { body: 'pelo reserva' });
    await WhatsAppAccount.update(supportId, { status: 'disconnected' });
    await WhatsAppAccount.update(backupId, { status: 'connected' });
    requests.length = 0;

    try {
      await WaOutboxWorker.tick();
      assert.equal(sendTextCalls()[0].path, `/message/sendText/${BACKUP}`);
      assert.equal(sendTextCalls()[0].apikey, BACKUP_TOKEN);
    } finally {
      await WhatsAppAccount.update(supportId, { status: 'connected' });
      await WhatsAppAccount.update(backupId, { status: 'disconnected' });
    }
  });

  it('refuses to enqueue at all when no number is connected', async () => {
    const conversation = await newConversation({ accountId: supportId });
    await WhatsAppAccount.update(supportId, { status: 'disconnected' });
    try {
      const { status, body } = await post(conversation.id, { body: 'ninguém conectado' });
      assert.equal(status, 409);
      assert.equal(body.code, 'no_account');
    } finally {
      await WhatsAppAccount.update(supportId, { status: 'connected' });
    }
  });
});

describe('the per-minute ceiling', () => {
  it('holds one pass to the configured number of sends', async () => {
    // `stop()` drops the rolling window, so the budget this test measures is
    // not whatever the tests above happened to leave behind.
    WaOutboxWorker.stop();
    await WhatsAppConfigService.saveConfig({ rateLimitPerMin: 2 });
    await clearOutbox();

    try {
      const ids = [];
      for (const texto of ['um', 'dois', 'três', 'quatro', 'cinco']) {
        const conversation = await newConversation();
        // eslint-disable-next-line no-await-in-loop -- the order of the queue is the point
        const { body } = await post(conversation.id, { body: texto });
        ids.push(body.data.id);
      }

      const summary = await WaOutboxWorker.tick();
      assert.equal(summary.sent, 2);
      assert.equal(summary.skipped, 'rate_limited');
      assert.equal(sendTextCalls().length, 2, 'the ceiling is a ceiling, not a target for the batch');

      // A second pass in the same minute sends nothing more.
      const again = await WaOutboxWorker.tick();
      assert.equal(again.sent, 0);
      assert.equal(again.skipped, 'rate_limited');
      assert.equal(sendTextCalls().length, 2);

      const statuses = await Promise.all(ids.map(async (id) => (await WaMessage.getById(id)).delivery_status));
      assert.equal(statuses.filter((s) => s === 'sent').length, 2);
      assert.equal(statuses.filter((s) => s === 'queued').length, 3);
    } finally {
      await WhatsAppConfigService.saveConfig({ rateLimitPerMin: 60 });
      WaOutboxWorker.stop();
    }
  });

  it('sends nothing while the integration is disabled', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    await post(conversation.id, { body: 'com a integração ligada' });
    await WhatsAppConfigService.saveConfig({ enabled: false });
    requests.length = 0;

    try {
      const summary = await WaOutboxWorker.tick();
      assert.equal(summary.skipped, 'disabled');
      assert.equal(requests.length, 0);
    } finally {
      await WhatsAppConfigService.saveConfig({ enabled: true });
    }
  });
});
