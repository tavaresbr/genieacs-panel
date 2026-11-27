import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: WaOutboxWorker } = await import('../src/services/waOutboxWorker.js');
const { default: WaSendService } = await import('../src/services/waSendService.js');
const { default: WaNoContactService } = await import('../src/services/waNoContactService.js');

/**
 * "Encerrar sem enviar nada": depois disso o cliente só recebe cobrança, ou
 * resposta quando ele mesmo escreve. Nada velho sai da fila.
 */

let panelUrl;
let token;
let accountId;
const api = (rota, options = {}) => call(`${panelUrl}/api/whatsapp${rota}`, { headers: authHeaders(token), ...options });
const FONE = '5593991110301';
let n = 0;
let enviados;
const dispatchOriginal = WaSendService.dispatch;

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
    name: 'painel-sem-contato',
    purpose: 'billing',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));
  accountId = account.id;
});

after(async () => {
  WaSendService.dispatch = dispatchOriginal;
  await stopTestServers();
});

beforeEach(async () => {
  enviados = [];
  WaSendService.dispatch = async (message) => {
    enviados.push(message.id);
    n += 1;
    return { externalId: `EXT-${n}` };
  };
  await getDb()('wa_opt_outs').del();
  await getDb()('wa_messages').del();
  await getDb()('wa_conversations').del();
});

async function novaConversa() {
  n += 1;
  return asTenant(() => WaConversation.ensure({
    accountId,
    externalThreadId: `${FONE}${n}@s.whatsapp.net`,
    waPhone: `${FONE}${n}`,
    pushName: 'Cliente'
  }));
}

const enfileira = (conversation, extra = {}) => asTenant(() => WaSendService.enqueue({
  conversationId: conversation.id, body: 'oi', ...extra
}));
const linha = (id) => asTenant(() => WaMessage.getById(id));
const encerra = (conversation, body = {}) => api(`/conversations/${conversation.id}/status`, {
  method: 'POST', body: { status: 'closed', ...body }
});

describe('encerrar sem enviar nada', () => {
  it('marca a conversa, bloqueia serviço/promoção/pesquisa (não cobrança) e retira a fila', async () => {
    const conv = await novaConversa();
    const bot = await enfileira(conv, { source: 'bot' });
    const campanha = await enfileira(conv, { source: 'campaign' });
    const cobranca = await enfileira(conv, { source: 'campaign', billing: true });
    const nota = await enfileira(conv, { isNote: true });

    const r = await encerra(conv, { noContact: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.noContact, true);

    const op = await asTenant(() => WaOptOut.findActive({ waPhone: conv.wa_phone_e164 }));
    assert.equal(op.categories, 'service,marketing,survey');
    assert.equal(op.origin, 'operator');

    assert.equal((await linha(bot.id)).delivery_status, 'failed');
    assert.equal((await linha(campanha.id)).delivery_status, 'failed');
    assert.equal((await linha(cobranca.id)).delivery_status, 'queued', 'cobrança segue na fila');
    assert.equal((await linha(nota.id)).delivery_status, null);
  });

  it('a despedida do atendente (últimos minutos) sai; a mensagem velha do atendente não', async () => {
    const conv = await novaConversa();
    const velha = await enfileira(conv);
    await getDb()('wa_messages').where({ id: velha.id }).update({ created_at: new Date(Date.now() - 3600_000) });
    const despedida = await enfileira(conv);
    await encerra(conv, { noContact: true });
    assert.equal((await linha(despedida.id)).delivery_status, 'queued');
    assert.equal((await linha(velha.id)).delivery_status, 'failed');
  });

  it('o worker não envia saída velha (nem depois de reenfileirar), envia cobrança e atendente novo', async () => {
    const conv = await novaConversa();
    const bot = await enfileira(conv, { source: 'bot' });
    await encerra(conv, { noContact: true });
    // "Reenviar falhas" devolve à fila…
    await getDb()('wa_messages').where({ id: bot.id }).update({ delivery_status: 'queued', delivery_error: null, next_attempt_at: null });
    assert.equal(await asTenant(() => WaOutboxWorker.deliver(bot.id)), 'no_contact');
    assert.deepEqual(enviados, []);
    assert.equal((await linha(bot.id)).delivery_status, 'failed');

    const cobranca = await enfileira(conv, { source: 'campaign', billing: true });
    assert.equal(await asTenant(() => WaOutboxWorker.deliver(cobranca.id)), 'sent');
    await new Promise((r) => setTimeout(r, 5));
    const novo = await enfileira(conv);
    assert.equal(await asTenant(() => WaOutboxWorker.deliver(novo.id)), 'sent');
    assert.deepEqual(enviados, [cobranca.id, novo.id]);
  });

  it('a pesquisa de satisfação não sai e sem a opção nada muda', async () => {
    const comum = await novaConversa();
    const f = await enfileira(comum, { source: 'bot' });
    await encerra(comum);
    assert.equal((await linha(f.id)).delivery_status, 'queued');
    assert.equal((await asTenant(() => WaConversation.getById(comum.id))).no_contact_at, null);
  });

  it('a entrada do cliente e reabrir liberam', async () => {
    const conv = await novaConversa();
    await encerra(conv, { noContact: true });
    const reaberta = await api(`/conversations/${conv.id}/status`, { method: 'POST', body: { status: 'open' } });
    assert.equal(reaberta.body.data.noContact, false);
  });

  it('"Liberar mensagens" desfaz só o bloqueio deste encerramento', async () => {
    const conv = await novaConversa();
    await encerra(conv, { noContact: true });
    const r = await api(`/conversations/${conv.id}/allow-contact`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.noContact, false);
    assert.equal(await asTenant(() => WaOptOut.findActive({ waPhone: conv.wa_phone_e164 })), null);

    // O "SAIR" do próprio cliente fica.
    const outra = await novaConversa();
    await asTenant(() => WaOptOut.record({ waPhone: outra.wa_phone_e164, origin: 'customer' }));
    await encerra(outra, { noContact: true });
    await api(`/conversations/${outra.id}/allow-contact`, { method: 'POST' });
    assert.ok(await asTenant(() => WaOptOut.findActive({ waPhone: outra.wa_phone_e164 })));
  });

  it('o que o cliente pediu na hora (essential) passa; o número de alertas da equipe não é marcado', async () => {
    const conv = await novaConversa();
    await encerra(conv, { noContact: true });
    const otp = await enfileira(conv, { source: 'alert', essential: true });
    assert.equal(await asTenant(() => WaOutboxWorker.deliver(otp.id)), 'sent');
    const alerta = await enfileira(conv, { source: 'alert' });
    assert.equal(await asTenant(() => WaOutboxWorker.deliver(alerta.id)), 'no_contact');

    const equipe = await novaConversa();
    const { default: WaAlertService } = await import('../src/services/waAlertService.js');
    const original = WaAlertService.getSettings;
    WaAlertService.getSettings = async () => ({ recipients: [equipe.wa_phone_e164] });
    try {
      const r = await encerra(equipe, { noContact: true });
      assert.equal(r.body.data.noContact, false);
    } finally {
      WaAlertService.getSettings = original;
    }
  });

  it('a regra pura: nota e cobrança passam, bot não', () => {
    const marca = { no_contact_at: new Date() };
    const velho = new Date(Date.now() - 3600_000);
    assert.equal(WaNoContactService.allows({}, { source: 'bot' }), true);
    assert.equal(WaNoContactService.allows(marca, { source: 'bot', created_at: velho }), false);
    assert.equal(WaNoContactService.allows(marca, { source: 'campaign', billing: true, created_at: velho }), true);
    assert.equal(WaNoContactService.allows(marca, { source: 'operator', is_note: true, created_at: velho }), true);
    assert.equal(WaNoContactService.allows(marca, { source: 'operator', created_at: velho }), false);
  });
});
