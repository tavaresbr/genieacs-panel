import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');

const FONE = '5593981215425';

let panelUrl;
let token;
let conversaId;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-auditoria',
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia-auditoria'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-webhook-auditoria')
  }));
  const conversa = await asTenant(() => WaConversation.ensure({
    accountId: account.id,
    externalThreadId: `${FONE}@s.whatsapp.net`,
    waPhone: FONE,
    waLid: null,
    pushName: 'Cliente'
  }));
  conversaId = conversa.id;
});

after(async () => {
  await stopTestServers();
});

const entrada = (body) => asTenant(() => WaMessage.create({
  conversation_id: conversaId,
  direction: 'in',
  body,
  is_note: false,
  source: 'operator',
  external_id: `EXT-${body}`,
  created_at: new Date(),
  updated_at: new Date()
}));

describe('apagar uma mensagem fica na trilha de auditoria', () => {
  it('registra quem apagou, o escopo e nunca o texto', async () => {
    const msg = await entrada('segredo do cliente 123');
    const { status, body } = await call(`${panelUrl}/api/whatsapp/messages/${msg.id}/delete`, {
      method: 'POST',
      headers: authHeaders(token),
      body: {}
    });
    assert.equal(status, 200, JSON.stringify(body));

    const trilha = await getDb()('audit_log').where({ action: 'whatsapp.message_deleted' }).orderBy('id', 'desc').first();
    assert.ok(trilha, 'a exclusão não foi para a trilha');
    assert.equal(trilha.actor_username, 'operator');
    assert.equal(String(trilha.subject_id), String(msg.id));
    const detail = typeof trilha.detail === 'string' ? JSON.parse(trilha.detail) : trilha.detail;
    assert.equal(detail.scope, 'panel', 'mensagem do cliente só some do painel');
    assert.equal(detail.direction, 'in');
    assert.ok(!JSON.stringify(trilha).includes('segredo do cliente'), 'o texto da mensagem foi para a trilha');
  });

  it('uma exclusão recusada não deixa linha na trilha', async () => {
    const antes = await getDb()('audit_log').where({ action: 'whatsapp.message_deleted' }).count({ n: '*' }).first();
    const { status } = await call(`${panelUrl}/api/whatsapp/messages/999999/delete`, {
      method: 'POST',
      headers: authHeaders(token),
      body: {}
    });
    assert.equal(status, 404);
    const depois = await getDb()('audit_log').where({ action: 'whatsapp.message_deleted' }).count({ n: '*' }).first();
    assert.equal(Number(depois.n), Number(antes.n));
  });
});
