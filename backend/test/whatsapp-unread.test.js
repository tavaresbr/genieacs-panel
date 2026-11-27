import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');

let panelUrl;
let token;
let accountId;
const api = (rota) => call(`${panelUrl}/api/whatsapp${rota}`, { headers: authHeaders(token) });
let n = 0;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true, webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook', rateLimitPerMin: 60
  }));
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-nao-lidas', purpose: 'billing', flavor: 'v2', base_url: 'https://evo.provedor.test',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));
  accountId = account.id;
});
after(async () => { await stopTestServers(); });
beforeEach(async () => { await getDb()('wa_conversations').del(); });

async function conversa(patch) {
  n += 1;
  const c = await asTenant(() => WaConversation.ensure({
    accountId, externalThreadId: `55939911103${n}@s.whatsapp.net`, waPhone: `55939911103${n}`, pushName: `C${n}`
  }));
  await getDb()('wa_conversations').where({ id: c.id }).update({ engaged_at: new Date(), ...patch });
  return c;
}

describe('conversas não lidas', () => {
  it('filtro unread lista só abertas com não lidas; a contagem é de conversas, não de mensagens', async () => {
    const a = await conversa({ unread_count: 30 });
    await conversa({ unread_count: 0 });
    await conversa({ unread_count: 2, closed_at: new Date() });
    const lista = await api('/conversations?status=open&unread=1');
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.body.data.map((r) => r.id), [a.id]);
    const total = await api('/conversations/unread-count');
    assert.equal(total.body.data.unread, 1);
    const todas = await api('/conversations?status=open');
    assert.equal(todas.body.data.length, 2);
  });
});
