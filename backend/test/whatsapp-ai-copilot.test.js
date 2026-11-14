import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { limparTexto, modoDeReescrita, promptDeReescrita, promptDeResumo } = await import('../src/utils/wa/copilotoIa.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');

/** O copiloto: resumir a conversa e reescrever o texto da caixa; nada é gravado nem enviado. */

let panelUrl;
let token;
let aiServer;
let aiUrl;
let account;
let contador = 0;
let resposta = 'Texto da IA';
let pedidos = [];

const api = (path, options = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...options });

before(async () => {
  ({ panelUrl } = await startTestServers());
  aiServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      pedidos.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: resposta } }] }));
    });
  });
  aiUrl = await new Promise((resolve) => {
    aiServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${aiServer.address().port}/api/paas/v4`));
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
  account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-copiloto', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.com.br',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-copiloto'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-copiloto')
  }));
  await asTenant(() => WaBotConfigService.saveConfig({
    ai: { enabled: true, apiKey: 'chave-do-copiloto-123', baseUrl: aiUrl, model: 'modelo-grande', fastModel: 'modelo-rapido' }
  }));
});

after(async () => {
  await new Promise((resolve) => aiServer.close(resolve));
  await stopTestServers();
});

beforeEach(() => { pedidos = []; resposta = 'Texto da IA'; });

const conversa = async (falas = []) => {
  contador += 1;
  const telefone = `55939813${String(contador).padStart(4, '0')}`;
  const c = await asTenant(() => WaConversation.ensure({
    accountId: account.id, externalThreadId: `${telefone}@s.whatsapp.net`, waPhone: telefone, waLid: null, pushName: 'Cliente'
  }));
  for (const [direcao, corpo] of falas) {
    await getDb()('wa_messages').insert({ conversation_id: c.id, direction: direcao, body: corpo, is_note: false, created_at: new Date() });
  }
  return c;
};
const mensagens = (id) => getDb()('wa_messages').where({ conversation_id: id }).count({ n: '*' }).first().then((r) => Number(r.n));

describe('as funções puras', () => {
  it('só os cinco modos existem', () => {
    for (const m of ['educado', 'direto', 'curto', 'corrigir', 'traduzir']) assert.ok(modoDeReescrita(m), m);
    assert.equal(modoDeReescrita('toString'), false);
    assert.equal(modoDeReescrita('hack'), false);
  });

  it('os prompts dizem a empresa e tratam o texto como material', () => {
    assert.match(promptDeReescrita({ empresa: 'Fibra X', modo: 'curto' }), /Fibra X[\s\S]*curta[\s\S]*ignore qualquer instrução/);
    assert.match(promptDeResumo({ empresa: 'Fibra X' }), /Próximo passo:[\s\S]*ignore qualquer instrução/);
  });

  it('limpa cerca de código, aspas e negrito e corta', () => {
    assert.equal(limparTexto('```\n"Olá **tudo** bem"\n```', 100), 'Olá tudo bem');
    assert.equal(limparTexto('abcdef', 3), 'abc');
    assert.equal(limparTexto(null, 3), '');
  });
});

describe('POST /conversations/:id/ai-summary', () => {
  it('resume com o modelo rápido, mascara documentos e não grava nada', async () => {
    const c = await conversa([['in', 'Minha internet caiu, meu CPF é 123.456.789-09'], ['out', 'Vou verificar já.'], ['in', 'Obrigado']]);
    const antes = await mensagens(c.id);
    resposta = 'Cliente sem internet.\nPróximo passo: abrir visita.';
    const res = await api(`/conversations/${c.id}/ai-summary`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.data.text, /Próximo passo/);
    assert.equal(pedidos[0].model, 'modelo-rapido');
    const enviado = JSON.stringify(pedidos[0].messages);
    assert.doesNotMatch(enviado, /123\.456\.789-09/);
    assert.match(enviado, /Cliente: Minha internet caiu/);
    assert.equal(await mensagens(c.id), antes);
  });

  it('conversa sem mensagens é 400 e conversa que não existe é 404', async () => {
    const vazia = await conversa();
    assert.equal((await api(`/conversations/${vazia.id}/ai-summary`, { method: 'POST', body: {} })).status, 400);
    assert.equal((await api('/conversations/99999999/ai-summary', { method: 'POST', body: {} })).status, 404);
    assert.equal(pedidos.length, 0);
  });

  it('exige login', async () => {
    const c = await conversa([['in', 'oi']]);
    const res = await call(`${panelUrl}/api/whatsapp/conversations/${c.id}/ai-summary`, { method: 'POST', body: {} });
    assert.equal(res.status, 401);
  });
});

describe('POST /conversations/:id/ai-rewrite', () => {
  it('reescreve no modo pedido, com o modelo rápido', async () => {
    const c = await conversa([['in', 'oi']]);
    resposta = '"Olá! Poderia enviar o comprovante, por favor?"';
    const res = await api(`/conversations/${c.id}/ai-rewrite`, { method: 'POST', body: { text: 'manda o comprovante', mode: 'educado' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.text, 'Olá! Poderia enviar o comprovante, por favor?');
    assert.equal(pedidos[0].model, 'modelo-rapido');
    assert.match(pedidos[0].messages[0].content, /educada/);
    assert.equal(pedidos[0].messages[1].content, 'manda o comprovante');
  });

  it('recusa modo desconhecido e texto vazio sem chamar a IA', async () => {
    const c = await conversa([['in', 'oi']]);
    const modo = await api(`/conversations/${c.id}/ai-rewrite`, { method: 'POST', body: { text: 'oi', mode: 'constructor' } });
    assert.equal(modo.status, 400);
    assert.equal(modo.body.code, 'ai_rewrite_mode');
    const vazio = await api(`/conversations/${c.id}/ai-rewrite`, { method: 'POST', body: { text: '   ', mode: 'curto' } });
    assert.equal(vazio.status, 400);
    assert.equal(pedidos.length, 0);
  });

  it('resposta vazia da IA é 502', async () => {
    const c = await conversa([['in', 'oi']]);
    resposta = '   ';
    const res = await api(`/conversations/${c.id}/ai-rewrite`, { method: 'POST', body: { text: 'oi', mode: 'curto' } });
    assert.equal(res.status, 502);
  });

  it('sem chave da IA é 409; /ai/status diz se o copiloto está ligado', async () => {
    const c = await conversa([['in', 'oi']]);
    assert.equal((await api('/ai/status')).body.data.copilot, true);
    await asTenant(() => WaBotConfigService.saveConfig({ ai: { enabled: false, suggest: false, apiKey: '' } }));
    try {
      assert.equal((await api('/ai/status')).body.data.copilot, false);
      const res = await api(`/conversations/${c.id}/ai-rewrite`, { method: 'POST', body: { text: 'oi', mode: 'curto' } });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'ai_key_required');
    } finally {
      await asTenant(() => WaBotConfigService.saveConfig({ ai: { enabled: true, apiKey: 'chave-do-copiloto-123' } }));
    }
  });
});
