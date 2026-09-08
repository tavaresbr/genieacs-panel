import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');

const INSTANCE = 'painel-teste';
const INSTANCE_TOKEN = 'token-da-instancia-abc';
const WEBHOOK_TOKEN = 'segredo-do-webhook-xyz';

let panelUrl;
let token;
let accountId;

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1' }
  });
  token = setup.body.data.token;

  const account = await WhatsAppAccount.create({
    name: INSTANCE,
    label: 'Cobrança',
    purpose: 'billing',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(INSTANCE_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  });
  accountId = account.id;
});

after(async () => {
  await stopTestServers();
});

describe('whatsapp configuration', () => {
  it('starts disabled and exposes no secret', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/config`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.equal(body.data.enabled, false);
    assert.equal(body.data.managedAdminKeyConfigured, false);
    assert.equal('managedAdminKey' in body.data, false);
  });

  it('refuses to enable without a webhook URL, because nothing would come back', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { enabled: true }
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'incomplete_config');
  });

  it('rejects a webhook URL that is not http(s) or that carries credentials', async () => {
    for (const webhookBaseUrl of ['ftp://p/hook', 'https://user:pass@p/hook']) {
      const { status, body } = await call(`${panelUrl}/api/whatsapp/config`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: { webhookBaseUrl }
      });
      assert.equal(status, 400, webhookBaseUrl);
      assert.equal(body.code, 'invalid_webhook_url');
    }
  });

  it('stores the admin key encrypted and never returns it', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: {
        enabled: true,
        webhookBaseUrl: 'https://painel.provedor.com.br/api/whatsapp-webhook?x=1',
        allowedHosts: 'evo.provedor.com.br\n*.outro.com',
        managedAdminKey: 'chave-global-do-servidor'
      }
    });
    assert.equal(status, 200);
    assert.equal(body.data.enabled, true);
    assert.equal(body.data.managedAdminKeyConfigured, true);
    assert.equal('managedAdminKey' in body.data, false);
    // The query string is stripped: the webhook secret is appended as `?t=`
    // later, and a leftover query would stop it parsing as one.
    assert.equal(body.data.webhookBaseUrl, 'https://painel.provedor.com.br/api/whatsapp-webhook');
    assert.deepEqual(body.data.allowedHosts, ['evo.provedor.com.br', '*.outro.com']);

    const stored = await getDb()('app_state').where({ key: 'whatsapp_evolution_config' }).first();
    assert.equal(stored.value.includes('chave-global-do-servidor'), false);
  });

  it('keeps the stored key when the field is omitted, and clears it on empty string', async () => {
    const kept = await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { rateLimitPerMin: 30 }
    });
    assert.equal(kept.body.data.managedAdminKeyConfigured, true);
    assert.equal(kept.body.data.rateLimitPerMin, 30);

    const cleared = await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { managedAdminKey: '' }
    });
    assert.equal(cleared.body.data.managedAdminKeyConfigured, false);
  });

  it('requires an authenticated admin', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/config`);
    assert.equal(status, 401);
  });
});

describe('whatsapp accounts', () => {
  it('lists numbers without either stored secret', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].name, INSTANCE);
    assert.equal(body.data[0].purpose, 'billing');
    const serialized = JSON.stringify(body.data);
    assert.equal(serialized.includes(INSTANCE_TOKEN), false);
    assert.equal(serialized.includes(WEBHOOK_TOKEN), false);
    assert.equal(serialized.includes('ciphertext'), false);
  });

  it('round-trips both secrets through independent boxes', async () => {
    const row = await WhatsAppAccount.getById(accountId);
    assert.equal(WhatsAppConfigService.decryptInstanceToken(row), INSTANCE_TOKEN);
    assert.equal(WhatsAppConfigService.decryptWebhookToken(row), WEBHOOK_TOKEN);
    // A ciphertext from one context must never decrypt as the other.
    assert.equal(
      WhatsAppConfigService.decryptInstanceToken({
        token_ciphertext: row.webhook_token_ciphertext,
        token_iv: row.webhook_token_iv,
        token_tag: row.webhook_token_tag
      }),
      ''
    );
  });

  it('routes by purpose, and falls back to the default number', async () => {
    assert.equal((await WhatsAppAccount.getForPurpose('billing')).id, accountId);
    assert.equal((await WhatsAppAccount.getForPurpose('support')).id, accountId);
  });
});

describe('whatsapp webhook authentication', () => {
  const hook = () => `${panelUrl}/api/whatsapp-webhook`;

  it('accepts an event carrying the webhook token', async () => {
    const { status, body } = await call(`${hook()}?t=${WEBHOOK_TOKEN}`, {
      method: 'POST',
      body: { instance: INSTANCE, event: 'messages.upsert', data: {} }
    });
    assert.equal(status, 200);
    assert.equal(body.event, 'messages_upsert');
  });

  it('refuses an event with no credential at all', async () => {
    // Evolution GO sends no auth header of its own, so this is the shape a
    // forged request actually takes. Fail-open here let anyone who knew an
    // instance name inject inbound messages.
    const { status } = await call(hook(), {
      method: 'POST',
      body: { instance: INSTANCE, event: 'messages.upsert' }
    });
    assert.equal(status, 401);
  });

  it('refuses a wrong token, and does not accept the instance key instead', async () => {
    const errado = await call(`${hook()}?t=nao-e-o-segredo`, {
      method: 'POST',
      body: { instance: INSTANCE, event: 'messages.upsert' }
    });
    assert.equal(errado.status, 401);

    const trocado = await call(`${hook()}?t=${INSTANCE_TOKEN}`, {
      method: 'POST',
      body: { instance: INSTANCE, event: 'messages.upsert' }
    });
    assert.equal(trocado.status, 401);
  });

  it('accepts the instance key in the body when there is no ?t=', async () => {
    const { status } = await call(hook(), {
      method: 'POST',
      body: { instance: INSTANCE, event: 'messages.upsert', apikey: INSTANCE_TOKEN }
    });
    assert.equal(status, 200);
  });

  it('answers 401 for an unknown instance, telling a prober nothing', async () => {
    const { status } = await call(`${hook()}?t=${WEBHOOK_TOKEN}`, {
      method: 'POST',
      body: { instance: 'nao-existe', event: 'messages.upsert' }
    });
    assert.equal(status, 401);
  });

  it('needs an instance name to resolve anything', async () => {
    const { status } = await call(`${hook()}?t=${WEBHOOK_TOKEN}`, {
      method: 'POST',
      body: { event: 'messages.upsert' }
    });
    assert.equal(status, 400);
  });
});

describe('outbox claim', () => {
  let conversationId;

  before(async () => {
    const conversation = await WaConversation.ensure({
      accountId,
      externalThreadId: '5593981110449@s.whatsapp.net',
      waPhone: '5593981110449',
      pushName: 'João'
    });
    conversationId = conversation.id;
  });

  it('claims a queued message exactly once', async () => {
    const message = await WaMessage.create({
      conversation_id: conversationId,
      direction: 'out',
      body: 'olá',
      delivery_status: 'queued'
    });

    const first = await WaMessage.claim(message.id);
    assert.ok(first, 'the first pass should win the claim');
    assert.equal(first.delivery_status, 'sending');
    assert.equal(first.attempts, 1);

    // A second pass must not send the same message again.
    assert.equal(await WaMessage.claim(message.id), null);
  });

  it('retakes a message abandoned mid-send, so a crash is recoverable', async () => {
    const message = await WaMessage.create({
      conversation_id: conversationId,
      direction: 'out',
      body: 'travada',
      delivery_status: 'sending',
      claimed_at: new Date(Date.now() - 10 * 60 * 1000)
    });
    const sendable = await WaMessage.listSendable(10);
    assert.ok(sendable.includes(message.id));
    assert.ok(await WaMessage.claim(message.id));
  });

  it('never claims a message the server already accepted', async () => {
    const message = await WaMessage.create({
      conversation_id: conversationId,
      direction: 'out',
      body: 'já foi',
      delivery_status: 'queued',
      external_id: 'ABC123'
    });
    assert.equal(await WaMessage.claim(message.id), null);
  });

  it('applies receipts without ever walking the status backwards', async () => {
    const message = await WaMessage.create({
      conversation_id: conversationId,
      direction: 'out',
      body: 'com recibo',
      delivery_status: 'sending',
      external_id: 'RECIBO1'
    });

    await WaMessage.applyReceipt(['RECIBO1'], 'read');
    assert.equal((await WaMessage.getById(message.id)).delivery_status, 'read');

    // A 'delivered' event crossing a 'read' on the wire must not turn the blue
    // ticks grey again.
    await WaMessage.applyReceipt(['RECIBO1'], 'delivered');
    assert.equal((await WaMessage.getById(message.id)).delivery_status, 'read');
  });

  it('refuses a duplicated external id, so a redelivered webhook cannot double a message', async () => {
    await WaMessage.create({
      conversation_id: conversationId,
      direction: 'in',
      body: 'primeira',
      external_id: 'DUPLICADA'
    });
    await assert.rejects(() => WaMessage.create({
      conversation_id: conversationId,
      direction: 'in',
      body: 'a mesma de novo',
      external_id: 'DUPLICADA'
    }));
  });
});

describe('opt-out', () => {
  it('records once, matches by phone, and stops matching after revocation', async () => {
    const created = await WaOptOut.record({ waPhone: '5593999990000', origin: 'customer', reasonText: 'SAIR' });
    assert.ok(created);
    assert.equal(await WaOptOut.isActive({ waPhone: '5593999990000' }), true);

    // A repeated "SAIR" must not add a second row.
    assert.equal(await WaOptOut.record({ waPhone: '5593999990000' }), null);

    await WaOptOut.revoke(created.id, null);
    assert.equal(await WaOptOut.isActive({ waPhone: '5593999990000' }), false);
  });

  it('matches on the LID too, for a contact that has no phone', async () => {
    await WaOptOut.record({ waLid: '140076734488739', origin: 'customer' });
    assert.equal(await WaOptOut.isActive({ waLid: '140076734488739' }), true);
    assert.equal(await WaOptOut.isActive({ waPhone: '5511000000000' }), false);
  });

  it('filters a whole campaign in one query', async () => {
    await WaOptOut.record({ waPhone: '5593988887777' });
    const blocked = await WaOptOut.activePhones(['5593988887777', '5593911112222']);
    assert.equal(blocked.has('5593988887777'), true);
    assert.equal(blocked.has('5593911112222'), false);
  });
});
