import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { documentoDigitado, escolherMidias, tipoDeMidia, MIDIAS_MAX } = await import('../src/utils/wa/midiaIa.js');
const { DATA_DIR } = await import('../src/config/paths.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');
const { default: WaAiService } = await import('../src/services/waAiService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');

/** O Claude lê fotos e PDFs do cliente (opt-in); o documento só vale se ele o digitou. */

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let panelUrl;
let token;
let server;
let aiUrl;
let account;
let contador = 0;
let pedidos = [];

const api = (p, options = {}) => call(`${panelUrl}/api/whatsapp${p}`, { headers: authHeaders(token), ...options });
const salvar = (ai) => asTenant(() => WaBotConfigService.saveConfig({ ai }));

before(async () => {
  ({ panelUrl } = await startTestServers());
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      pedidos.push({ url: req.url, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url.startsWith('/v1/messages')
        ? { content: [{ type: 'text', text: 'Recebi o comprovante.' }], usage: { input_tokens: 10, output_tokens: 3 } }
        : { choices: [{ index: 0, message: { role: 'assistant', content: 'Recebi o comprovante.' } }] }));
    });
  });
  aiUrl = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
  account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-visao', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.com.br',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-visao'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-visao')
  }));
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopTestServers();
});

beforeEach(() => { pedidos = []; });

const conversa = async () => {
  contador += 1;
  const telefone = `55939814${String(contador).padStart(4, '0')}`;
  return asTenant(() => WaConversation.ensure({
    accountId: account.id, externalThreadId: `${telefone}@s.whatsapp.net`, waPhone: telefone, waLid: null, pushName: 'Cliente'
  }));
};
const mensagem = (c, { direcao = 'in', corpo = null, arquivo = null, tipo = 'image/png', bytes = PNG, quando = new Date() } = {}) => (async () => {
  let attachment_path = null;
  if (arquivo) {
    attachment_path = path.join('wa-media', 'teste-visao', `${c.id}-${arquivo}`);
    await fsp.mkdir(path.join(DATA_DIR, 'wa-media', 'teste-visao'), { recursive: true });
    await fsp.writeFile(path.join(DATA_DIR, attachment_path), bytes);
  }
  await getDb()('wa_messages').insert({
    conversation_id: c.id, direction: direcao, body: corpo, is_note: false, created_at: quando,
    attachment_path, attachment_type: arquivo ? tipo : null, attachment_name: arquivo
  });
})();
const sugerir = (c) => api(`/conversations/${c.id}/suggest-reply`, { method: 'POST', body: {} });
const blocos = () => pedidos.flatMap((p) => (p.body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])));

describe('as funções puras', () => {
  it('só imagem e PDF que a API lê', () => {
    assert.equal(tipoDeMidia('image/jpeg'), 'image');
    assert.equal(tipoDeMidia('IMAGE/PNG; x=1'), 'image');
    assert.equal(tipoDeMidia('application/pdf'), 'document');
    assert.equal(tipoDeMidia('image/svg+xml'), null);
    assert.equal(tipoDeMidia('audio/ogg'), null);
  });

  it('escolhe as últimas 3 do cliente dentro de 24 h', () => {
    const agora = Date.now();
    const m = (id, extra = {}) => ({ id, direction: 'in', attachment_path: 'x', attachment_type: 'image/png', created_at: new Date(agora - id * 1000), ...extra });
    const linhas = [m(9), m(8), m(7), m(6), m(5, { direction: 'out' }), m(4, { attachment_type: 'audio/ogg' }), m(3, { created_at: new Date(agora - 25 * 3600_000) })];
    const ids = escolherMidias(linhas, agora);
    assert.equal(ids.size, MIDIAS_MAX);
    assert.deepEqual([...ids].sort(), [6, 7, 8]);
  });

  it('o documento só vale se aparece no texto digitado', () => {
    assert.equal(documentoDigitado(['meu cpf é 529.982.247-25'], '52998224725'), true);
    assert.equal(documentoDigitado(['oi', null], '52998224725'), false);
    assert.equal(documentoDigitado(['oi'], ''), false);
  });
});

describe('a IA vê as mídias do cliente', () => {
  it('com a opção ligada no Claude, a foto vai como bloco de imagem', async () => {
    await salvar({ enabled: true, suggest: true, provider: 'anthropic', baseUrl: aiUrl, model: 'claude-sonnet-5-5', apiKey: 'sk-ant-visao', vision: true });
    const c = await conversa();
    await mensagem(c, { corpo: 'segue o comprovante', arquivo: 'comp.png' });
    const res = await sugerir(c);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const imagem = blocos().find((b) => b.type === 'image');
    assert.ok(imagem, JSON.stringify(pedidos[0].body.messages).slice(0, 300));
    assert.equal(imagem.source.media_type, 'image/png');
    assert.equal(imagem.source.data, PNG.toString('base64'));
    assert.match(JSON.stringify(pedidos[0].body.system), /nunca afirme que o pagamento foi confirmado/i);
    let uso;
    for (let i = 0; i < 20 && !uso; i += 1) {
      uso = await getDb()('wa_ai_usage').where({ task: 'visao' }).first(); // eslint-disable-line no-await-in-loop -- o registro sai sem esperar a resposta
      if (!uso) await new Promise((r) => setTimeout(r, 50)); // eslint-disable-line no-await-in-loop
    }
    assert.ok(uso, 'a chamada com imagem conta como visão');
  });

  it('PDF vai como bloco de documento', async () => {
    const c = await conversa();
    await mensagem(c, { arquivo: 'boleto.pdf', tipo: 'application/pdf', bytes: Buffer.from('%PDF-1.4 teste') });
    await sugerir(c);
    assert.ok(blocos().some((b) => b.type === 'document' && b.source.media_type === 'application/pdf'));
  });

  it('opção desligada: só o aviso de texto, nenhuma imagem sai', async () => {
    await salvar({ vision: false });
    const c = await conversa();
    await mensagem(c, { arquivo: 'comp.png' });
    await sugerir(c);
    assert.equal(blocos().filter((b) => b.type === 'image').length, 0);
    assert.match(JSON.stringify(pedidos[0].body.messages), /o cliente enviou uma imagem/);
    await salvar({ vision: true });
  });

  it('arquivo que sumiu ou grande demais cai no aviso de texto', async () => {
    const c = await conversa();
    await mensagem(c, { arquivo: 'sumiu.png' });
    await fsp.rm(path.join(DATA_DIR, 'wa-media', 'teste-visao', `${c.id}-sumiu.png`));
    await mensagem(c, { arquivo: 'enorme.png', bytes: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await mensagem(c, { arquivo: 'audio.ogg', tipo: 'audio/ogg', bytes: Buffer.from('x') });
    const res = await sugerir(c);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(blocos().filter((b) => b.type === 'image' || b.type === 'document').length, 0);
    assert.match(JSON.stringify(pedidos[0].body.messages), /o cliente enviou uma imagem/);
  });

  it('outro provedor nunca recebe a imagem', async () => {
    await salvar({ provider: 'openai-compatible', baseUrl: `${aiUrl}/api/paas/v4`, model: 'glm-4.5-flash', apiKey: 'chave-compativel' });
    try {
      const c = await conversa();
      await mensagem(c, { arquivo: 'comp.png' });
      await sugerir(c);
      assert.doesNotMatch(JSON.stringify(pedidos), new RegExp(PNG.toString('base64').slice(0, 20)));
    } finally {
      await salvar({ provider: 'anthropic', baseUrl: aiUrl, model: 'claude-sonnet-5-5', apiKey: 'sk-ant-visao' });
    }
  });

  it('a opção é validada e começa desligada', async () => {
    const cfg = await asTenant(() => WaBotConfigService.getConfig());
    assert.equal(cfg.ai.vision, true);
    await salvar({ vision: false });
    assert.equal((await asTenant(() => WaBotConfigService.getConfig())).ai.vision, false);
    await salvar({ vision: 'sim' });
    assert.equal((await asTenant(() => WaBotConfigService.getConfig())).ai.vision, false);
  });
});

describe('identificar_cliente só aceita o documento digitado', () => {
  it('um CPF que só aparece numa foto não identifica ninguém', async () => {
    const c = await conversa();
    await mensagem(c, { corpo: 'olha o documento', arquivo: 'rg.png' });
    const r = await asTenant(() => WaAiService.identificar(c, { documento: '529.982.247-25' }));
    assert.match(r.paraModelo, /não foi digitado pelo cliente/);
    assert.equal(r.transferir, undefined);
  });
});
