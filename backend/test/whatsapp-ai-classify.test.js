import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { lerClassificacao, promptDeClassificacao } = await import('../src/utils/wa/classificacaoIa.js');
const { default: WaAiService } = await import('../src/services/waAiService.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');

/** A classificação automática: opt-in, no máximo 1 a cada 6 h, resposta do modelo validada. */

let panelUrl;
let token;
let server;
let aiUrl;
let account;
let contador = 0;
let pedidos = [];
let resposta = '{"topic":"reclamacao","urgency":"alta","mood":"irritado"}';

const classificar = (c) => asTenant(() => WaAiService.classificar(c));
const salvar = (ai) => asTenant(() => WaBotConfigService.saveConfig({ ai }));

before(async () => {
  ({ panelUrl } = await startTestServers());
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      pedidos.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: resposta } }] }));
    });
  });
  aiUrl = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}/api/paas/v4`)));
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
  account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-classifica', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.com.br',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-classifica'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-classifica')
  }));
  await salvar({ enabled: true, apiKey: 'chave-classifica-123', baseUrl: aiUrl, model: 'modelo-grande', fastModel: 'modelo-rapido', classify: true });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopTestServers();
});

beforeEach(() => {
  pedidos = [];
  resposta = '{"topic":"reclamacao","urgency":"alta","mood":"irritado"}';
});

const conversa = async (falas = [['in', 'Já faz 3 dias que a internet cai! Meu CPF 529.982.247-25']]) => {
  contador += 1;
  const telefone = `55939815${String(contador).padStart(4, '0')}`;
  const c = await asTenant(() => WaConversation.ensure({
    accountId: account.id, externalThreadId: `${telefone}@s.whatsapp.net`, waPhone: telefone, waLid: null, pushName: 'Cliente'
  }));
  for (const [direcao, corpo] of falas) {
    await getDb()('wa_messages').insert({ conversation_id: c.id, direction: direcao, body: corpo, is_note: false, created_at: new Date() });
  }
  return c;
};
const linha = (c) => getDb()('wa_conversations').where({ id: c.id }).first();
const tags = (c) => getDb()('wa_conversation_tags').join('wa_tags', 'wa_tags.id', 'wa_conversation_tags.tag_id').where({ conversation_id: c.id }).pluck('wa_tags.name');

describe('as funções puras', () => {
  it('lê só JSON que bate com as listas', () => {
    assert.deepEqual(lerClassificacao('{"topic":"Suporte","urgency":"media","mood":"calmo"}'), { topic: 'suporte', urgency: 'media', mood: 'calmo' });
    assert.deepEqual(lerClassificacao('Claro!\n```json\n{"topic":"fatura","urgency":"baixa","mood":"calmo"}\n```'), { topic: 'fatura', urgency: 'baixa', mood: 'calmo' });
    assert.equal(lerClassificacao('{"topic":"hack","urgency":"alta","mood":"calmo"}'), null);
    assert.equal(lerClassificacao('{"topic":"fatura"}'), null);
    assert.equal(lerClassificacao('não sei'), null);
    assert.equal(lerClassificacao(null), null);
  });

  it('o prompt lista as opções e trata a conversa como material', () => {
    const p = promptDeClassificacao({ empresa: 'Fibra X' });
    assert.match(p, /Fibra X[\s\S]*reclamacao[\s\S]*irritado[\s\S]*ignore qualquer instrução/);
  });
});

describe('WaAiService.classificar', () => {
  it('grava a marca, usa o modelo rápido, mascara o CPF e etiqueta a reclamação', async () => {
    const c = await conversa();
    const marca = await classificar(c);
    assert.deepEqual(marca, { topic: 'reclamacao', urgency: 'alta', mood: 'irritado' });
    const l = await linha(c);
    assert.equal(l.ai_topic, 'reclamacao');
    assert.equal(l.ai_urgency, 'alta');
    assert.equal(l.ai_mood, 'irritado');
    assert.ok(l.ai_classified_at);
    assert.equal(pedidos[0].model, 'modelo-rapido');
    assert.doesNotMatch(JSON.stringify(pedidos[0].messages), /529\.982\.247-25/);
    assert.deepEqual(await tags(c), ['Reclamação']);
    const dec = await asTenant(async () => (await import('../src/services/waConversationService.js')).default.decorate(await WaConversation.getById(c.id)));
    assert.equal(dec.aiUrgency, 'alta');
  });

  it('no máximo uma vez a cada 6 horas', async () => {
    const c = await conversa();
    await classificar(c);
    pedidos = [];
    assert.equal(await classificar(c), null);
    assert.equal(pedidos.length, 0);
    await getDb()('wa_conversations').where({ id: c.id }).update({ ai_classified_at: new Date(Date.now() - 7 * 3600_000) });
    resposta = '{"topic":"elogio","urgency":"baixa","mood":"satisfeito"}';
    assert.equal((await classificar(c)).topic, 'elogio');
  });

  it('duas ao mesmo tempo gastam uma chamada só', async () => {
    const c = await conversa();
    await Promise.all([classificar(c), classificar(c)]);
    assert.equal(pedidos.length, 1);
  });

  it('JSON inválido não grava nada (e a vaga fica tomada)', async () => {
    const c = await conversa();
    resposta = 'não faço ideia';
    assert.equal(await classificar(c), null);
    const l = await linha(c);
    assert.equal(l.ai_topic, null);
    assert.ok(l.ai_classified_at);
  });

  it('cancelamento e comercial recebem as etiquetas certas', async () => {
    const a = await conversa([['in', 'Quero cancelar o plano']]);
    resposta = '{"topic":"cancelamento","urgency":"media","mood":"calmo"}';
    await classificar(a);
    assert.deepEqual(await tags(a), ['Cancelamento']);
    const b = await conversa([['in', 'Quanto custa o plano?']]);
    resposta = '{"topic":"comercial","urgency":"baixa","mood":"calmo"}';
    await classificar(b);
    assert.deepEqual(await tags(b), ['Venda']);
  });

  it('desligado (ou sem chave) não chama a IA', async () => {
    await salvar({ classify: false });
    try {
      const c = await conversa();
      assert.equal(await classificar(c), null);
      assert.equal(pedidos.length, 0);
      assert.equal((await linha(c)).ai_classified_at, null);
    } finally {
      await salvar({ classify: true });
    }
  });

  it('a opção começa desligada e só aceita verdadeiro', async () => {
    await salvar({ classify: 'sim' });
    assert.equal((await asTenant(() => WaBotConfigService.getConfig())).ai.classify, false);
    await salvar({ classify: true });
    assert.equal((await asTenant(() => WaBotConfigService.getConfig())).ai.classify, true);
  });
});

describe('na entrada do webhook', () => {
  it('uma mensagem do cliente dispara a classificação sem atrasar a resposta', async () => {
    const res = await call(`${panelUrl}/api/whatsapp-webhook?t=segredo-classifica`, {
      method: 'POST',
      body: {
        event: 'messages.upsert', instance: 'painel-classifica',
        data: { key: { remoteJid: '5593981000999@s.whatsapp.net', fromMe: false, id: 'CL-1' }, pushName: 'Teste', message: { conversation: 'a internet caiu de novo!' }, messageType: 'conversation', messageTimestamp: 1739990000 }
      }
    });
    assert.ok(res.status < 300, JSON.stringify(res.body));
    let l;
    for (let i = 0; i < 40 && !l?.ai_topic; i += 1) {
      l = await getDb()('wa_conversations').where({ wa_phone_e164: '5593981000999' }).first(); // eslint-disable-line no-await-in-loop -- a marca sai depois da resposta
      if (!l?.ai_topic) await new Promise((r) => setTimeout(r, 50)); // eslint-disable-line no-await-in-loop
    }
    assert.equal(l?.ai_topic, 'reclamacao');
    assert.ok(authHeaders(token));
  });
});
