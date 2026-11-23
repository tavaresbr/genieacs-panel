import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.META_APP_SECRET = 'segredo-do-app-meta';
process.env.MESSENGER_VERIFY_TOKEN = 'token-de-verificacao';

const { asTenant, authHeaders, call, defaultTenantId, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaDunningService } = await import('../src/services/waDunningService.js');
const { default: MessengerLinkTokenService } = await import('../src/services/messengerLinkTokenService.js');
const { encryptPageToken } = await import('../src/services/messengerPageService.js');

/**
 * `{{link_messenger}}` numa cobrança automática (a régua).
 *
 * O que se defende: sem Página conectada a cobrança sai igual, só sem a linha do
 * Messenger (a variável é OPCIONAL e não recusa a mensagem); com Página, cada
 * cobrança leva um link de uso único do contrato daquela pessoa; a simulação
 * não emite link nenhum; e abrir o link vincula a conversa de quem o abriu.
 */
const APP = 'painel';
const TOKEN = 'token-secreto-regua';
const PAGE_ID = '1000000001';
const SEMPRE = {
  timezone: 'America/Sao_Paulo',
  week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: false, open: '00:00', close: '23:59' }))
};
const MODELO = 'Olá {{nome}}, sua fatura de {{valor}} venceu há {{dias_atraso}} dias.\nPrefere o Messenger? {{link_messenger}}\nSe já pagou, desconsidere.';

const meioDia = () => {
  const d = new Date();
  d.setUTCHours(15, 0, 0, 0);
  return d;
};
const dayOffset = (days) => {
  const d = meioDia();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const SUBSCRIBERS = new Map([
  ['R-X', { name: 'Xavier', phone: '5593981130001', titulo: 'TX' }],
  ['R-Y', { name: 'Yara', phone: '5593981130002', titulo: 'TY' }],
  ['R-Z', { name: 'Zeca', phone: '5593981130003', titulo: 'TZ' }]
]);

let panelUrl;
let token;
let sgpServer;
let templateId;
let tenantId;

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (payload.app !== APP || payload.token !== TOKEN) return send({ status: 0, msg: 'Token inválido' });
      if (req.url.startsWith('/api/ura/titulos')) {
        const sub = SUBSCRIBERS.get(String(payload.contrato));
        if (!sub) return send({ status: 0, msg: 'Contrato inexistente' });
        return send({ status: 1, titulos: [{ numerodocumento: sub.titulo, valor: '89,90', vencimento: dayOffset(-2) }] });
      }
      res.writeHead(404);
      return res.end('{}');
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

const api = (path, options = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...options });
const run = (options = {}) => asTenant(() => WaDunningService.run({ now: meioDia(), ...options }));
const tokens = () => getDb()('messenger_link_tokens').orderBy('id');
const bodyOf = async (contract) => {
  const send = await getDb()('wa_dunning_sends').where({ contract, status: 'queued' }).first();
  assert.ok(send?.message_id, `${contract}: a cobrança tem que ter entrado na fila`);
  return (await getDb()('wa_messages').where({ id: send.message_id }).first()).body;
};
const linkSgp = async (contract) => {
  const now = new Date();
  const sub = SUBSCRIBERS.get(contract);
  await getDb()('sgp_links').insert({
    tenant_id: tenantId, device_id: `ont-${contract}`, contract, client_name: sub.name, document: '12345678909',
    state: 'active', link_mode: 'auto', phone_e164: sub.phone, created_at: now, updated_at: now
  });
};

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await startSgpStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  tenantId = await defaultTenantId();
  await asTenant(() => SgpService.saveConfig({ enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'pppoe' }));
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true, webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook', rateLimitPerMin: 60
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: 'painel-cobranca', purpose: 'billing', flavor: 'v2', base_url: 'https://evo.provedor.test', status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));
  await linkSgp('R-X');

  const created = await api('/templates', { method: 'POST', body: { name: 'régua com Messenger', body: MODELO, category: 'cobranca' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  templateId = created.body.data.id;
  assert.equal((await api('/dunning/rule', { method: 'PUT', body: { window: SEMPRE, steps: [{ offsetDays: 1, templateId }] } })).status, 200);
  assert.equal((await api('/dunning/enabled', { method: 'POST', body: { enabled: true } })).status, 200);
});
after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('cobrança automática com {{link_messenger}}', () => {
  it('sem Página conectada a cobrança sai igual, só sem a linha do Messenger', async () => {
    const summary = await run();
    assert.equal(summary.queued, 1);
    assert.equal(summary.skipped.templateIncomplete, 0, 'a variável opcional não pula a cobrança');
    const corpo = await bodyOf('R-X');
    assert.match(corpo, /sua fatura de R\$ 89,90 venceu há 2 dias\./);
    assert.match(corpo, /Se já pagou, desconsidere\.$/);
    assert.ok(!corpo.includes('Messenger'), 'a linha inteira saiu');
    assert.ok(!corpo.includes('{{'), 'nenhum placeholder sobra');
    assert.equal((await tokens()).length, 0, 'nenhum link foi emitido');
  });

  let refY;
  it('com Página conectada, a cobrança leva um link de uso único do contrato daquela pessoa', async () => {
    await getDb()('messenger_pages').insert({
      tenant_id: tenantId, page_id: PAGE_ID, page_name: 'Provedor', page_token: encryptPageToken('tok'), status: 'connected'
    });
    await linkSgp('R-Y');
    const summary = await run();
    assert.equal(summary.queued, 1, 'só Y: X já foi decidido nesta etapa');
    const corpo = await bodyOf('R-Y');
    const achado = corpo.match(/Prefere o Messenger\? (https:\/\/m\.me\/(\d+)\?ref=([A-Za-z0-9_-]{22}))\n/);
    assert.ok(achado, `o texto tem que levar o link: ${corpo}`);
    assert.equal(achado[2], PAGE_ID);
    refY = achado[3];

    const emitidos = await tokens();
    assert.equal(emitidos.length, 1);
    assert.equal(emitidos[0].contract, 'R-Y');
    assert.equal(emitidos[0].source, 'invoice');
    assert.equal(emitidos[0].created_by, null);
    assert.equal(emitidos[0].used_at, null);
    assert.equal(emitidos[0].token_hash, crypto.createHash('sha256').update(refY).digest('hex'));
    assert.ok(!JSON.stringify(emitidos).includes(refY), 'só o hash fica guardado');
  });

  it('a simulação (prévia) não emite link nenhum', async () => {
    await linkSgp('R-Z');
    const antes = (await tokens()).length;
    const previa = await run({ dryRun: true });
    assert.ok(previa.queued >= 1, 'Z receberia a cobrança');
    assert.equal((await tokens()).length, antes);
  });

  it('abrir o link vincula a conversa de quem o abriu ao contrato da cobrança', async () => {
    const raw = JSON.stringify({
      object: 'page',
      entry: [{ id: PAGE_ID, messaging: [{ sender: { id: 'psid-yara' }, recipient: { id: PAGE_ID }, timestamp: Date.now(), referral: { ref: refY, source: 'SHORTLINK', type: 'OPEN_THREAD' } }] }]
    });
    const sig = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex')}`;
    const res = await fetch(`${panelUrl}/api/messenger-webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
    assert.equal(res.status, 200);
    const conv = await getDb()('messenger_conversations').where({ psid: 'psid-yara' }).first();
    assert.equal(conv.contract, 'R-Y');
    assert.equal(conv.bound_via, 'link');
    assert.ok((await tokens()).find((t) => t.contract === 'R-Y').used_at, 'o link foi gasto');
  });
});

describe('varsForTemplate', () => {
  const vars = (body, contract) => asTenant(() => MessengerLinkTokenService.varsForTemplate(body, contract));

  it('só emite quando o modelo cita a variável', async () => {
    const antes = (await tokens()).length;
    assert.deepEqual(await vars('Olá {{nome}}', 'R-Y'), {});
    assert.equal((await tokens()).length, antes);
  });

  it('contrato desconhecido não lança: devolve nada, e a cobrança segue sem o link', async () => {
    assert.deepEqual(await vars('{{link_messenger}}', 'CONTRATO-QUE-NAO-EXISTE'), {});
    assert.deepEqual(await vars('{{link_messenger}}', null), {});
  });

  it('Página com erro ou desconectada: devolve nada', async () => {
    await getDb()('messenger_pages').where({ page_id: PAGE_ID }).update({ status: 'error' });
    assert.deepEqual(await vars('{{link_messenger}}', 'R-Y'), {});
    await getDb()('messenger_pages').where({ page_id: PAGE_ID }).update({ status: 'connected' });
    assert.match((await vars('{{link_messenger}}', 'R-Y')).link_messenger, /^https:\/\/m\.me\/1000000001\?ref=/);
  });
});
