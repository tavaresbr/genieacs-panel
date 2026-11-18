import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { tinsert } from '../src/config/database.js';

const { default: WaResponseTimeService } = await import('../src/services/waResponseTimeService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');

/** Cliente que a IA marcou como urgente e irritado entra na lista de espera na metade do tempo. */

let account;
let contador = 0;
const MINUTO = 60_000;

before(async () => {
  await startTestServers();
  account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-espera', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.com.br',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-espera'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-espera')
  }));
});
after(stopTestServers);

const esperando = async (minutosAtras, marca = {}) => {
  contador += 1;
  const telefone = `55939816${String(contador).padStart(4, '0')}`;
  const c = await asTenant(() => WaConversation.ensure({
    accountId: account.id, externalThreadId: `${telefone}@s.whatsapp.net`, waPhone: telefone, waLid: null, pushName: `Cliente ${contador}`
  }));
  const quando = new Date(Math.floor((Date.now() - minutosAtras * MINUTO) / 1000) * 1000);
  await asTenant(() => tinsert('wa_messages', {
    conversation_id: c.id, direction: 'in', body: 'alguém?', source: 'operator', external_id: `ESP-${contador}`, created_at: quando, updated_at: quando
  }));
  await getDb()('wa_conversations').where({ id: c.id }).update({ last_inbound_at: quando, ...marca });
  return c.id;
};
const ids = (itens) => itens.map((i) => i.conversationId);
const lista = (opcoes) => asTenant(() => WaResponseTimeService.waitingNow({ minMinutes: 15, urgentMinMinutes: 7, ...opcoes }));

describe('waitingNow com a marca da IA', () => {
  it('urgente e irritado entra aos 7 min; os outros esperam os 15', async () => {
    const urgente = await esperando(10, { ai_urgency: 'alta', ai_mood: 'irritado' });
    const comum = await esperando(10);
    const soUrgencia = await esperando(10, { ai_urgency: 'alta', ai_mood: 'calmo' });
    const soHumor = await esperando(10, { ai_urgency: 'media', ai_mood: 'irritado' });
    const itens = await lista();
    assert.ok(ids(itens).includes(urgente));
    assert.equal(itens.find((i) => i.conversationId === urgente).urgent, true);
    for (const outro of [comum, soUrgencia, soHumor]) assert.ok(!ids(itens).includes(outro), `conversa ${outro} não é urgente e irritada`);
  });

  it('passou dos 15 min, todos entram; só o urgente vem marcado', async () => {
    const urgente = await esperando(20, { ai_urgency: 'alta', ai_mood: 'irritado' });
    const comum = await esperando(20);
    const itens = await lista();
    assert.equal(itens.find((i) => i.conversationId === urgente).urgent, true);
    assert.equal(itens.find((i) => i.conversationId === comum).urgent, false);
  });

  it('sem urgentMinMinutes, o limite é o mesmo para todos (como antes)', async () => {
    const urgente = await esperando(10, { ai_urgency: 'alta', ai_mood: 'irritado' });
    const itens = await asTenant(() => WaResponseTimeService.waitingNow({ minMinutes: 15 }));
    assert.ok(!ids(itens).includes(urgente));
  });

  it('antes dos 7 min nem o urgente entra', async () => {
    const urgente = await esperando(3, { ai_urgency: 'alta', ai_mood: 'irritado' });
    assert.ok(!ids(await lista()).includes(urgente));
  });
});

describe('waitingNowCached, a memória da rota da tela', () => {
  it('serve a mesma lista por ~30 s, por limite, e esquece quando pedem', async () => {
    WaResponseTimeService.resetWaitingCache();
    const cached = (opcoes) => asTenant(() => WaResponseTimeService.waitingNowCached(opcoes));
    const primeira = await cached({ minMinutes: 15, urgentMinMinutes: 7 });
    const nova = await esperando(40);
    const segunda = await cached({ minMinutes: 15, urgentMinMinutes: 7 });
    assert.deepEqual(ids(segunda), ids(primeira), 'dentro da janela a lista é a mesma');
    // Outro limite é outra chave: calcula na hora e já vê a conversa nova.
    assert.ok(ids(await cached({ minMinutes: 30, urgentMinMinutes: 15 })).includes(nova));
    // E o caminho sem cache (o do alerta) nunca lê o passado.
    assert.ok(ids(await lista()).includes(nova));
    WaResponseTimeService.resetWaitingCache();
    assert.ok(ids(await cached({ minMinutes: 15, urgentMinMinutes: 7 })).includes(nova));
  });
});
