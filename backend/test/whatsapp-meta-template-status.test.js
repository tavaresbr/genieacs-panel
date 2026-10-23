/**
 * O status dos modelos da Meta atualizado sozinho: o motivo da recusa (pelo
 * Evolution quando vier, senão pela Graph direto), a mudança de status gravada
 * e registrada, e o vigia que só volta à Meta pelos números com pendência.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaMetaTemplateWatcher } = await import('../src/services/waMetaTemplateWatcher.js');
const { setMetaGraphFetcher, fetchTemplateStatuses, META_GRAPH_VERSION } = await import('../src/services/metaWebhookService.js');
const { readMetaTemplates, readRejectedReason, readQualityScore } = await import('../src/utils/wa/evolutionApi.js');

const EVO_BASE = 'https://evo-status.provedor.test';
const META_TOKEN = 'EAAGm0PX4ZCpsBAMetaStatusToken1234567890';
const WABA = '998877665544332';

let panelUrl;
let token;
let server;
let desfazer;
let pendente;
let tudoAprovado;
const requests = [];
const graphCalls = [];
const graph = { status: 200, body: { data: [] }, throws: false };

/** Os modelos que o dublê do Evolution devolve, por instância. */
const evo = {
  'oficial-pendente': [
    {
      id: '21', name: 'aviso_novo', language: 'pt_BR', status: 'PENDING', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Oi {{1}}' }]
    },
    {
      id: '22', name: 'promo_recusada', language: 'pt_BR', status: 'PENDING', category: 'MARKETING',
      components: [{ type: 'BODY', text: 'Promo' }]
    }
  ],
  'oficial-aprovado': [
    {
      id: '31', name: 'aviso_ok', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Ok {{1}}' }]
    }
  ]
};

before(async () => {
  ({ panelUrl } = await startTestServers());
  server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    requests.push({ path, apikey: req.headers.apikey || null });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (path.startsWith('/template/find/')) {
        const nome = decodeURIComponent(path.slice('/template/find/'.length));
        return res.end(JSON.stringify(evo[nome] ?? []));
      }
      return res.end(JSON.stringify({}));
    });
  });
  const url = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  desfazer = rotearBase(EVO_BASE, url);

  setMetaGraphFetcher(async (u, init) => {
    graphCalls.push({ url: u, init });
    if (graph.throws) throw new Error(`connect ECONNREFUSED ${u}`);
    return new Response(JSON.stringify(graph.body), {
      status: graph.status,
      headers: { 'Content-Type': 'application/json' }
    });
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
  const conta = (name, extra = {}) => asTenant(() => WhatsAppAccount.create({
    name,
    purpose: 'general',
    flavor: 'v2',
    integration: 'cloud',
    base_url: EVO_BASE,
    status: 'connected',
    meta_waba_id: WABA,
    ...WhatsAppConfigService.encryptInstanceToken(META_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken(`webhook-${name}`),
    ...extra
  }));
  pendente = await conta('oficial-pendente');
  tudoAprovado = await conta('oficial-aprovado');
});

after(async () => {
  setMetaGraphFetcher(null);
  WaMetaTemplateWatcher.stop();
  desfazer?.();
  await new Promise((resolve) => server.close(resolve));
  await stopTestServers();
});

const api = (path, init = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...init });
const buscas = (nome) => requests.filter((r) => r.path === `/template/find/${nome}`).length;

describe('leitura do motivo e da qualidade', () => {
  it('lê rejected_reason e quality_score quando a resposta os traz', () => {
    const [m] = readMetaTemplates([{
      name: 'x', language: 'pt_BR', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT',
      quality_score: { score: 'yellow', date: 1 }, components: []
    }]);
    assert.equal(m.rejectedReason, 'INVALID_FORMAT');
    assert.equal(m.qualityScore, 'YELLOW');
  });

  it('NONE e UNKNOWN viram nulo, como o campo ausente', () => {
    assert.equal(readRejectedReason('NONE'), null);
    assert.equal(readRejectedReason(undefined), null);
    assert.equal(readQualityScore({ score: 'UNKNOWN' }), null);
    assert.equal(readQualityScore('GREEN'), 'GREEN');
  });
});

describe('a Graph direto para o motivo', () => {
  it('pede os campos certos com o token no cabeçalho e segue a paginação da própria Graph', async () => {
    graphCalls.length = 0;
    let pagina = 0;
    setMetaGraphFetcher(async (u, init) => {
      graphCalls.push({ url: u, init });
      pagina += 1;
      const body = pagina === 1
        ? { data: [{ name: 'a', language: 'pt_BR' }], paging: { next: 'https://graph.facebook.com/v21.0/x?after=1' } }
        : { data: [{ name: 'b', language: 'pt_BR' }], paging: { next: 'https://evil.test/roubar' } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const r = await fetchTemplateStatuses({ wabaId: WABA, metaToken: META_TOKEN });
    assert.equal(r.ok, true);
    assert.deepEqual(r.templates.map((t) => t.name), ['a', 'b']);
    assert.equal(graphCalls.length, 2, 'não segue um next que sai da Graph');
    const primeira = new URL(graphCalls[0].url);
    assert.equal(primeira.pathname, `/${META_GRAPH_VERSION}/${WABA}/message_templates`);
    assert.match(primeira.searchParams.get('fields'), /rejected_reason/);
    assert.ok(!graphCalls[0].url.includes(META_TOKEN), 'o token nunca vai na URL');
    assert.equal(graphCalls[0].init.headers.Authorization, `Bearer ${META_TOKEN}`);
    // volta o dublê da suíte
    setMetaGraphFetcher(async (u, init) => {
      graphCalls.push({ url: u, init });
      if (graph.throws) throw new Error(`connect ECONNREFUSED ${u}`);
      return new Response(JSON.stringify(graph.body), { status: graph.status, headers: { 'Content-Type': 'application/json' } });
    });
  });

  it('falha de rede vira código curto, sem token nem URL', async () => {
    graph.throws = true;
    const r = await fetchTemplateStatuses({ wabaId: WABA, metaToken: META_TOKEN });
    graph.throws = false;
    assert.deepEqual(r, { ok: false, error: 'meta_unreachable' });
  });
});

describe('o vigia dos modelos em análise', () => {
  it('na primeira volta sincroniza quem nunca sincronizou', async () => {
    requests.length = 0;
    const r = await WaMetaTemplateWatcher.tick();
    assert.equal(r.synced, 2);
    assert.equal(buscas('oficial-pendente'), 1);
    assert.equal(buscas('oficial-aprovado'), 1);
  });

  it('depois só volta ao número que tem modelo PENDING', async () => {
    requests.length = 0;
    graphCalls.length = 0;
    const r = await WaMetaTemplateWatcher.tick();
    assert.equal(r.synced, 1);
    assert.equal(buscas('oficial-pendente'), 1);
    assert.equal(buscas('oficial-aprovado'), 0, 'número sem pendência não é consultado');
    assert.equal(graphCalls.length, 0, 'sem recusa sem motivo, a Graph não é chamada');
  });

  it('a decisão da Meta chega sozinha: status, motivo pela Graph, de/para e trilha', async () => {
    evo['oficial-pendente'] = [
      { ...evo['oficial-pendente'][0], status: 'APPROVED' },
      { ...evo['oficial-pendente'][1], status: 'REJECTED' }
    ];
    graph.body = {
      data: [
        { id: '22', name: 'promo_recusada', language: 'pt_BR', status: 'REJECTED', rejected_reason: 'TAG_CONTENT_MISMATCH' }
      ]
    };
    graphCalls.length = 0;
    await WaMetaTemplateWatcher.tick();
    assert.equal(graphCalls.length, 1);

    const lista = await api(`/meta-templates?accountId=${pendente.id}`);
    assert.equal(lista.status, 200);
    const recusada = lista.body.data.find((m) => m.name === 'promo_recusada');
    assert.equal(recusada.status, 'REJECTED');
    assert.equal(recusada.rejectedReason, 'TAG_CONTENT_MISMATCH');
    assert.equal(recusada.previousStatus, 'PENDING');
    assert.ok(recusada.statusChangedAt);
    const aprovada = lista.body.data.find((m) => m.name === 'aviso_novo');
    assert.equal(aprovada.status, 'APPROVED');
    assert.equal(aprovada.usable, true);
    assert.equal(aprovada.rejectedReason, null);

    const trilha = await asTenant(() => getDb()('audit_log')
      .where({ action: 'whatsapp.meta_template_status' })
      .orderBy('id'));
    assert.equal(trilha.length, 2);
    const detalhe = trilha.map((t) => JSON.parse(t.detail)).find((d) => d.name === 'promo_recusada');
    assert.equal(detalhe.from, 'PENDING');
    assert.equal(detalhe.to, 'REJECTED');
    assert.equal(detalhe.reason, 'TAG_CONTENT_MISMATCH');
    assert.ok(!JSON.stringify(trilha).includes(META_TOKEN));
  });

  it('sem pendência nenhuma, nenhum número é consultado', async () => {
    requests.length = 0;
    const r = await WaMetaTemplateWatcher.tick();
    assert.equal(r.synced, 0);
    assert.equal(requests.length, 0);
  });

  it('o motivo não some quando a Graph falha numa volta seguinte', async () => {
    graph.throws = true;
    const r = await api(`/accounts/${pendente.id}/templates/sync`, { method: 'POST' });
    graph.throws = false;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const recusada = r.body.data.find((m) => m.name === 'promo_recusada');
    assert.equal(recusada.rejectedReason, 'TAG_CONTENT_MISMATCH');
    // sem mudança de status, sem nova linha na trilha
    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'whatsapp.meta_template_status' }));
    assert.equal(trilha.length, 2);
    assert.ok(tudoAprovado.id);
  });
});
