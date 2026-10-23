/**
 * Editar e apagar um modelo da Meta pelo painel, direto na Graph API (o
 * servidor Evolution só lista e cria). O que este arquivo guarda: o pedido sai
 * com o que a Meta pede e com o token só no cabeçalho; apagar um modelo em uso
 * é recusado com a lista das ligações, e `unlink=1` as desfaz; a recusa da Meta
 * não vaza token nem URL; e a ordem das recusas (conta, modelo, corpo, rede).
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaTemplate } = await import('../src/models/WaTemplate.js');
const { default: WaOutboxWorker } = await import('../src/services/waOutboxWorker.js');
const { setMetaGraphFetcher, META_GRAPH_VERSION } = await import('../src/services/metaGraphClient.js');
const { readMetaTemplateDraft, metaTemplateComponents } = await import('../src/utils/wa/evolutionApi.js');

const EVO_BASE = 'https://evo-editar-modelo.provedor.test';
const META_TOKEN = 'EAAGm0PX4ZCpsBAMetaPermanentTokenEditar12345';
const WABA = '555444333222111';

let panelUrl;
let token;
let server;
let desfazer;
let accountId;

/** O que a Meta lista (pelo servidor Evolution). */
const modelos = () => [
  {
    id: '9001', name: 'aviso_geral', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Aviso' },
      { type: 'BODY', text: 'Olá {{1}}', example: { body_text: [['Ana']] } },
      { type: 'FOOTER', text: 'Provedor' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Ok' }] }
    ]
  },
  {
    id: '9002', name: 'em_analise', language: 'pt_BR', status: 'PENDING', category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Em análise' }]
  },
  {
    id: '9003', name: 'com_midia', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
    components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Foto' }]
  },
  {
    id: '9004', name: 'livre', language: 'pt_BR', status: 'REJECTED', category: 'MARKETING',
    components: [{ type: 'BODY', text: 'Sem ligação' }]
  }
];
const evo = { templates: modelos() };

/** A Graph falsa: o que ela responde e o que recebeu. */
const graph = { status: 200, body: { success: true }, throws: false };
const graphCalls = [];

before(async () => {
  ({ panelUrl } = await startTestServers());
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = req.url.split('?')[0];
      res.writeHead(path.startsWith('/template/find/') ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(path.startsWith('/template/find/') ? evo.templates : { error: 'not found' }));
    });
  });
  const url = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  desfazer = rotearBase(EVO_BASE, url);

  setMetaGraphFetcher(async (u, init) => {
    // A leitura do motivo das recusas (a sincronização depois de editar) não
    // é o que estes testes contam: responde vazio e fica fora de `graphCalls`.
    if ((init.method || 'GET') === 'GET' && new URL(u).pathname.endsWith('/message_templates')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    graphCalls.push({ url: u, init, body: init.body ? JSON.parse(init.body) : null });
    if (graph.throws) throw new Error(`connect ECONNREFUSED ${u} ${META_TOKEN}`);
    return new Response(JSON.stringify(graph.body), { status: graph.status, headers: { 'Content-Type': 'application/json' } });
  });

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    rateLimitPerMin: 60
  }));
  const row = await asTenant(() => WhatsAppAccount.create({
    name: 'oficial-editar',
    purpose: 'general',
    flavor: 'v2',
    integration: 'cloud',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    meta_waba_id: WABA,
    ...WhatsAppConfigService.encryptInstanceToken(META_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-editar')
  }));
  accountId = row.id;
});

beforeEach(() => {
  graph.status = 200;
  graph.body = { success: true };
  graph.throws = false;
  graphCalls.length = 0;
});

after(async () => {
  setMetaGraphFetcher(null);
  desfazer?.();
  WaOutboxWorker.stop();
  await new Promise((resolve) => server.close(resolve));
  await stopTestServers();
});

const api = (path, init = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...init });

async function sincronizar() {
  evo.templates = modelos();
  const r = await api(`/accounts/${accountId}/templates/sync`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data;
}
const porNome = (lista, nome) => lista.find((m) => m.name === nome);

const EDICAO = {
  category: 'UTILITY',
  headerText: 'Aviso novo',
  bodyText: 'Olá {{1}}, tudo certo?',
  examples: ['Ana'],
  buttons: [{ type: 'URL', text: 'Ver', url: 'https://provedor.test/x' }]
};

describe('ida e volta do formulário', () => {
  it('os components do formulário voltam como o mesmo rascunho', () => {
    const t = { headerText: 'Oi', bodyText: 'Olá {{1}}', examples: ['Ana'], footerText: 'Rodapé',
      buttons: [{ type: 'URL', text: 'Ir', url: 'https://a.test' }, { type: 'QUICK_REPLY', text: 'Ok' }] };
    assert.deepEqual(readMetaTemplateDraft(metaTemplateComponents(t)), {
      headerText: 'Oi', bodyText: 'Olá {{1}}', examples: ['Ana'], footerText: 'Rodapé',
      buttons: [{ type: 'URL', text: 'Ir', url: 'https://a.test' }, { type: 'QUICK_REPLY', text: 'Ok', url: '' }]
    });
  });

  it('o que o formulário não representa fica fora da edição', () => {
    assert.equal(readMetaTemplateDraft([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }]), null);
    assert.equal(readMetaTemplateDraft([{ type: 'BODY', text: 'x' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'a', url: 'https://a.test/{{1}}' }] }]), null);
    assert.equal(readMetaTemplateDraft([{ type: 'BODY', text: 'Olá {{nome}}' }]), null);
  });
});

describe('editar modelo da Meta', () => {
  it('a lista diz o que dá para editar e traz o rascunho', async () => {
    const lista = await sincronizar();
    assert.equal(porNome(lista, 'aviso_geral').editable, true);
    assert.equal(porNome(lista, 'aviso_geral').draft.headerText, 'Aviso');
    assert.deepEqual(porNome(lista, 'aviso_geral').draft.examples, ['Ana']);
    assert.equal(porNome(lista, 'em_analise').editable, false, 'PENDING não se edita');
    assert.equal(porNome(lista, 'com_midia').editable, false, 'cabeçalho de mídia fica no Gerenciador');
    assert.equal(porNome(lista, 'com_midia').draft, null);
  });

  it('manda POST /{id do modelo} com os components, sem nome nem idioma, e o token só no cabeçalho', async () => {
    const lista = await sincronizar();
    const alvo = porNome(lista, 'aviso_geral');
    // Depois da edição a Meta lista o modelo de volta em análise.
    evo.templates = modelos().map((m) => (m.name === 'aviso_geral' ? { ...m, status: 'PENDING' } : m));
    const r = await api(`/accounts/${accountId}/templates/${alvo.id}`, {
      method: 'PUT',
      body: { ...EDICAO, name: 'outro_nome', language: 'en_US' }
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.template.status, 'PENDING');
    assert.equal(r.body.data.template.name, 'aviso_geral');
    assert.deepEqual(r.body.data.links, []);

    assert.equal(graphCalls.length, 1);
    const [chamada] = graphCalls;
    assert.equal(chamada.url, `https://graph.facebook.com/${META_GRAPH_VERSION}/9001`);
    assert.equal(chamada.init.method, 'POST');
    assert.equal(chamada.init.headers.Authorization, `Bearer ${META_TOKEN}`);
    assert.ok(!chamada.url.includes(META_TOKEN));
    assert.equal(chamada.body.name, undefined);
    assert.equal(chamada.body.language, undefined);
    // Aprovado: a categoria não vai (a Meta recusa trocar a de um aprovado).
    assert.equal(chamada.body.category, undefined);
    assert.deepEqual(chamada.body.components.map((c) => c.type), ['HEADER', 'BODY', 'BUTTONS']);
    assert.deepEqual(chamada.body.components[1].example, { body_text: [['Ana']] });
  });

  it('num rejeitado, a categoria nova vai junto', async () => {
    const alvo = porNome(await sincronizar(), 'livre');
    const r = await api(`/accounts/${accountId}/templates/${alvo.id}`, {
      method: 'PUT', body: { category: 'UTILITY', bodyText: 'Agora utilidade' }
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(graphCalls[0].body.category, 'UTILITY');
  });

  it('modelo em análise não se edita, e a Meta nem é chamada', async () => {
    const alvo = porNome(await sincronizar(), 'em_analise');
    const r = await api(`/accounts/${accountId}/templates/${alvo.id}`, { method: 'PUT', body: EDICAO });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'meta_template_not_editable');
    assert.equal(graphCalls.length, 0);
  });

  it('recusa de validação não chega à Meta', async () => {
    const alvo = porNome(await sincronizar(), 'aviso_geral');
    const r = await api(`/accounts/${accountId}/templates/${alvo.id}`, {
      method: 'PUT', body: { ...EDICAO, bodyText: 'Olá {{2}}' }
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_meta_template');
    assert.equal(graphCalls.length, 0);
  });

  it('limite de edição da Meta vira 409 com mensagem própria', async () => {
    const alvo = porNome(await sincronizar(), 'aviso_geral');
    graph.status = 400;
    graph.body = { error: { message: 'Invalid parameter', code: 100, error_subcode: 2388023,
      error_user_msg: 'Message template edits are limited to 1 per 24 hours' } };
    const r = await api(`/accounts/${accountId}/templates/${alvo.id}`, { method: 'PUT', body: EDICAO });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'meta_template_edit_limit');
  });

  it('outra recusa da Meta volta com o motivo dela, sem token nem URL', async () => {
    const alvo = porNome(await sincronizar(), 'aviso_geral');
    graph.status = 400;
    graph.body = { error: { message: 'Invalid parameter', code: 100, error_user_msg: 'Texto proibido no corpo' } };
    const r = await api(`/accounts/${accountId}/templates/${alvo.id}`, { method: 'PUT', body: EDICAO });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'meta_refused');
    assert.match(r.body.message, /Texto proibido no corpo/);
    assert.ok(!JSON.stringify(r.body).includes(META_TOKEN));
    assert.ok(!JSON.stringify(r.body).includes('graph.facebook.com'));
  });

  it('Meta fora do ar: meta_unreachable, sem a exceção do fetch', async () => {
    const alvo = porNome(await sincronizar(), 'aviso_geral');
    graph.throws = true;
    const r = await api(`/accounts/${accountId}/templates/${alvo.id}`, { method: 'PUT', body: EDICAO });
    assert.equal(r.status, 502);
    assert.match(r.body.message, /meta_unreachable/);
    assert.ok(!JSON.stringify(r.body).includes(META_TOKEN));
    assert.ok(!JSON.stringify(r.body).includes('ECONNREFUSED'));
  });
});

describe('apagar modelo da Meta', () => {
  it('sem ligação: DELETE com nome e hsm_id, e a linha some', async () => {
    const alvo = porNome(await sincronizar(), 'livre');
    const r = await api(`/accounts/${accountId}/templates/${alvo.id}`, { method: 'DELETE' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.unlinked, { templates: 0, notices: 0 });
    const [chamada] = graphCalls;
    const url = new URL(chamada.url);
    assert.equal(chamada.init.method, 'DELETE');
    assert.equal(url.pathname, `/${META_GRAPH_VERSION}/${WABA}/message_templates`);
    assert.equal(url.searchParams.get('name'), 'livre');
    assert.equal(url.searchParams.get('hsm_id'), '9004');
    assert.equal(chamada.init.headers.Authorization, `Bearer ${META_TOKEN}`);
    assert.ok(!chamada.url.includes(META_TOKEN));
    const linha = await getDb()('wa_meta_templates').where({ id: alvo.id }).first();
    assert.equal(linha, undefined);
  });

  it('em uso: 409 com as ligações e nada sai para a Meta; com unlink=1 desfaz e apaga', async () => {
    const alvo = porNome(await sincronizar(), 'aviso_geral');
    const modelo = await asTenant(() => WaTemplate.create({
      name: 'Aviso ligado', body: 'Olá {{nome}}', category: 'geral', active: true,
      meta_template_name: 'aviso_geral', meta_language: 'pt_BR', meta_params: JSON.stringify(['texto'])
    }));
    const ligar = await call(`${panelUrl}/api/whatsapp/meta-notice-bindings`, {
      method: 'PUT', headers: authHeaders(token),
      body: { outage: { name: 'aviso_geral', language: 'pt_BR' } }
    });
    assert.equal(ligar.status, 200, JSON.stringify(ligar.body));

    const recusa = await api(`/accounts/${accountId}/templates/${alvo.id}`, { method: 'DELETE' });
    assert.equal(recusa.status, 409);
    assert.equal(recusa.body.code, 'meta_template_in_use');
    assert.deepEqual(recusa.body.metaLinks, [
      { kind: 'template', id: modelo.id, name: 'Aviso ligado' },
      { kind: 'notice', key: 'outage' }
    ]);
    assert.equal(graphCalls.length, 0);

    const r = await api(`/accounts/${accountId}/templates/${alvo.id}?unlink=1`, { method: 'DELETE' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.unlinked, { templates: 1, notices: 1 });
    const depois = await getDb()('wa_templates').where({ id: modelo.id }).first();
    assert.equal(depois.meta_template_name, null);
    assert.equal(depois.meta_params, null);
    const avisos = await call(`${panelUrl}/api/whatsapp/meta-notice-bindings`, { headers: authHeaders(token) });
    assert.equal(avisos.body.data.outage, null);
  });

  it('"não existe" na Meta conta como apagado', async () => {
    const alvo = porNome(await sincronizar(), 'livre');
    graph.status = 400;
    graph.body = { error: { message: 'Message template not found', code: 100 } };
    const r = await api(`/accounts/${accountId}/templates/${alvo.id}`, { method: 'DELETE' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await getDb()('wa_meta_templates').where({ id: alvo.id }).first(), undefined);
  });

  it('outra recusa da Meta mantém a linha', async () => {
    const alvo = porNome(await sincronizar(), 'livre');
    graph.status = 403;
    graph.body = { error: { message: 'Permissions error', code: 200 } };
    const r = await api(`/accounts/${accountId}/templates/${alvo.id}`, { method: 'DELETE' });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'meta_refused');
    assert.ok(await getDb()('wa_meta_templates').where({ id: alvo.id }).first());
  });
});

describe('ordem das recusas', () => {
  it('número por QR: 409 antes de olhar o modelo', async () => {
    const qr = await asTenant(() => WhatsAppAccount.create({
      name: 'qr-editar', purpose: 'general', flavor: 'v2', base_url: EVO_BASE, status: 'connected',
      ...WhatsAppConfigService.encryptInstanceToken('tok'), ...WhatsAppConfigService.encryptWebhookToken('w')
    }));
    const put = await api(`/accounts/${qr.id}/templates/1`, { method: 'PUT', body: EDICAO });
    assert.equal(put.status, 409);
    assert.equal(put.body.code, 'meta_templates_cloud_only');
    const del = await api(`/accounts/${qr.id}/templates/1`, { method: 'DELETE' });
    assert.equal(del.status, 409);
    assert.equal(graphCalls.length, 0);
    await getDb()('whatsapp_accounts').where({ id: qr.id }).del();
  });

  it('conta que não existe: 404', async () => {
    const r = await api('/accounts/999999/templates/1', { method: 'DELETE' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'account_not_found');
  });

  it('modelo que não é deste número: 404', async () => {
    const r = await api(`/accounts/${accountId}/templates/999999`, { method: 'PUT', body: EDICAO });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'meta_template_not_found');
    const lixo = await api(`/accounts/${accountId}/templates/abc`, { method: 'DELETE' });
    assert.equal(lixo.status, 404);
  });

  it('pede a permissão de configuração do WhatsApp', async () => {
    const r = await call(`${panelUrl}/api/whatsapp/accounts/${accountId}/templates/1`, { method: 'DELETE' });
    assert.equal(r.status, 401);
  });
});
