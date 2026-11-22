import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

process.env.META_APP_SECRET = 'segredo-do-app-meta';
process.env.MESSENGER_VERIFY_TOKEN = 'token-de-verificacao';

const { setMetaGraphFetcher } = await import('../src/services/metaGraphClient.js');
const { verifyMetaSignature } = await import('../src/utils/messenger/messengerSignature.js');
const { encryptPageToken, decryptPageToken } = await import('../src/services/messengerPageService.js');
const { default: MessengerConversation } = await import('../src/models/MessengerConversation.js');
const { default: MessengerMessage } = await import('../src/models/MessengerMessage.js');

let panelUrl;
let token;
let alfa;
let beta;
const hook = () => `${panelUrl}/api/messenger-webhook`;
const api = (p, options = {}) => call(`${panelUrl}/api/messenger${p}`, { headers: authHeaders(token), ...options });

const sign = (raw, secret = process.env.META_APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

/** Entrega assinada, com o corpo exatamente como foi assinado. */
async function deliver(body, { secret, signature } = {}) {
  const raw = JSON.stringify(body);
  const response = await fetch(hook(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature ?? sign(raw, secret) },
    body: raw
  });
  return response.status;
}

const inbound = (pageId, psid, mid, text, ts = Date.now()) => ({
  object: 'page',
  entry: [{ id: pageId, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: ts, message: { mid, text } }] }]
});

async function seedPage(tenantId, pageId, tokenValue = 'tok') {
  return getDb()('messenger_pages').insert({
    tenant_id: tenantId, page_id: pageId, page_name: `Página ${pageId}`, page_token: encryptPageToken(tokenValue), status: 'connected'
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
  await seedPage(alfa, '1000000001');
  await seedPage(beta, '2000000002');
});
after(async () => {
  setMetaGraphFetcher(null);
  await stopTestServers();
});

describe('assinatura da Meta', () => {
  const raw = Buffer.from('{"a":1}');
  it('aceita a assinatura certa e recusa o resto, falhando fechado', () => {
    assert.equal(verifyMetaSignature(raw, sign(raw), process.env.META_APP_SECRET), true);
    assert.equal(verifyMetaSignature(raw, sign(raw, 'outro'), process.env.META_APP_SECRET), false);
    assert.equal(verifyMetaSignature(Buffer.from('{"a":2}'), sign(raw), process.env.META_APP_SECRET), false);
    assert.equal(verifyMetaSignature(raw, undefined, process.env.META_APP_SECRET), false);
    assert.equal(verifyMetaSignature(raw, 'sha256=zz', process.env.META_APP_SECRET), false);
    assert.equal(verifyMetaSignature(raw, sign(raw), ''), false);
  });
  it('o token da Página volta igual depois de cifrado, e não aparece no que foi gravado', () => {
    const stored = encryptPageToken('EAAB-token-secreto');
    assert.equal(decryptPageToken(stored), 'EAAB-token-secreto');
    assert.ok(!stored.includes('EAAB-token-secreto'));
  });
});

describe('GET /api/messenger-webhook (verificação)', () => {
  it('devolve o desafio com o token certo', async () => {
    const r = await fetch(`${hook()}?hub.mode=subscribe&hub.verify_token=token-de-verificacao&hub.challenge=12345`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '12345');
  });
  it('só devolve desafio numérico: texto do chamador nunca é refletido', async () => {
    const r = await fetch(`${hook()}?hub.mode=subscribe&hub.verify_token=token-de-verificacao&hub.challenge=${encodeURIComponent('<script>alert(1)</script>')}`);
    assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes('<script>'));
    const vazio = await fetch(`${hook()}?hub.mode=subscribe&hub.verify_token=token-de-verificacao`);
    assert.equal(vazio.status, 400);
  });
  it('recusa token errado ou modo errado', async () => {
    assert.equal((await fetch(`${hook()}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`)).status, 403);
    assert.equal((await fetch(`${hook()}?hub.mode=ping&hub.verify_token=token-de-verificacao&hub.challenge=1`)).status, 403);
    assert.equal((await fetch(hook())).status, 403);
  });
});

describe('POST /api/messenger-webhook (entrega)', () => {
  it('recusa sem assinatura ou com assinatura errada, sem gravar nada', async () => {
    const body = inbound('1000000001', 'psid-1', 'm.bad', 'oi');
    assert.equal(await deliver(body, { signature: 'sha256=' + '0'.repeat(64) }), 401);
    assert.equal(await deliver(body, { secret: 'segredo-errado' }), 401);
    const sem = await fetch(hook(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(sem.status, 401);
    assert.equal(await getDb()('messenger_messages').where({ external_id: 'm.bad' }).first(), undefined);
  });

  it('grava a conversa e a mensagem no provedor dono da Página', async () => {
    assert.equal(await deliver(inbound('1000000001', 'psid-1', 'm.1', 'Estou sem internet')), 200);
    const conv = await getDb()('messenger_conversations').where({ tenant_id: alfa, psid: 'psid-1' }).first();
    assert.ok(conv);
    assert.equal(conv.unread_count, 1);
    assert.ok(conv.last_inbound_at);
    const msg = await getDb()('messenger_messages').where({ external_id: 'm.1' }).first();
    assert.equal(msg.tenant_id, alfa);
    assert.equal(msg.direction, 'in');
    assert.equal(msg.body, 'Estou sem internet');
  });

  it('a reentrega do mesmo mid não duplica nem conta de novo como não lida', async () => {
    const body = inbound('1000000001', 'psid-1', 'm.1', 'Estou sem internet');
    assert.equal(await deliver(body), 200);
    assert.equal(await deliver(body), 200);
    const n = await getDb()('messenger_messages').where({ external_id: 'm.1' }).count({ n: '*' }).first();
    assert.equal(Number(n.n), 1);
    const conv = await getDb()('messenger_conversations').where({ tenant_id: alfa, psid: 'psid-1' }).first();
    assert.equal(conv.unread_count, 1);
  });

  it('a mesma pessoa e o mesmo mid em outra Página caem no outro provedor, sem se misturar', async () => {
    assert.equal(await deliver(inbound('2000000002', 'psid-1', 'm.1', 'mensagem do beta')), 200);
    const doBeta = await getDb()('messenger_messages').where({ tenant_id: beta, external_id: 'm.1' }).first();
    assert.equal(doBeta.body, 'mensagem do beta');
    const doAlfa = await getDb()('messenger_messages').where({ tenant_id: alfa, external_id: 'm.1' }).first();
    assert.equal(doAlfa.body, 'Estou sem internet');
  });

  it('Página desconhecida: 200 e nada é gravado', async () => {
    assert.equal(await deliver(inbound('9999999999', 'psid-x', 'm.x', 'oi')), 200);
    assert.equal(await getDb()('messenger_messages').where({ external_id: 'm.x' }).first(), undefined);
  });

  it('corpo assinado mas ilegível: 200, para a Meta não reentregar em laço', async () => {
    const raw = '{not json';
    const r = await fetch(hook(), { method: 'POST', headers: { 'X-Hub-Signature-256': sign(raw) }, body: raw });
    assert.equal(r.status, 200);
  });

  it('o eco de uma resposta dada fora do painel entra como saída da Página', async () => {
    const ts = Date.now();
    const echo = {
      object: 'page',
      entry: [{ id: '1000000001', messaging: [{ sender: { id: '1000000001' }, recipient: { id: 'psid-1' }, timestamp: ts, message: { mid: 'm.echo', text: 'Já vamos verificar', is_echo: true } }] }]
    };
    assert.equal(await deliver(echo), 200);
    const msg = await getDb()('messenger_messages').where({ external_id: 'm.echo' }).first();
    assert.equal(msg.direction, 'out');
    assert.equal(msg.source, 'page');
    const conv = await getDb()('messenger_conversations').where({ tenant_id: alfa, psid: 'psid-1' }).first();
    assert.equal(conv.unread_count, 1, 'eco não conta como não lida');
  });

  it('recibos de entrega e de leitura avançam o estado e não regridem', async () => {
    const conv = await getDb()('messenger_conversations').where({ tenant_id: alfa, psid: 'psid-1' }).first();
    const past = new Date(Date.now() - 1000);
    await getDb()('messenger_messages').insert({
      tenant_id: alfa, conversation_id: conv.id, direction: 'out', external_id: 'm.out1', body: 'olá',
      source: 'operator', delivery_status: 'sent', created_at: past, updated_at: past
    });
    const wm = Date.now() + 5000;
    const base = { object: 'page', entry: [{ id: '1000000001', messaging: [] }] };
    base.entry[0].messaging = [{ sender: { id: 'psid-1' }, recipient: { id: '1000000001' }, delivery: { watermark: wm } }];
    assert.equal(await deliver(base), 200);
    assert.equal((await getDb()('messenger_messages').where({ external_id: 'm.out1' }).first()).delivery_status, 'delivered');
    base.entry[0].messaging = [{ sender: { id: 'psid-1' }, recipient: { id: '1000000001' }, read: { watermark: wm } }];
    assert.equal(await deliver(base), 200);
    const lida = await getDb()('messenger_messages').where({ external_id: 'm.out1' }).first();
    assert.equal(lida.delivery_status, 'read');
    base.entry[0].messaging = [{ sender: { id: 'psid-1' }, recipient: { id: '1000000001' }, delivery: { watermark: wm } }];
    assert.equal(await deliver(base), 200);
    assert.equal((await getDb()('messenger_messages').where({ external_id: 'm.out1' }).first()).delivery_status, 'read');
  });
});

describe('API do painel', () => {
  it('exige sessão', async () => {
    assert.equal((await call(`${panelUrl}/api/messenger/conversations`)).status, 401);
  });

  it('lista só as conversas do provedor logado e não vaza o token', async () => {
    const res = await api('/conversations');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const psids = res.body.data.map((c) => c.psid);
    assert.deepEqual(psids, ['psid-1']);
    assert.ok(!JSON.stringify(res.body).includes('page_token'));
    const pages = await api('/pages');
    assert.equal(pages.status, 200);
    assert.deepEqual(pages.body.data.map((p) => p.pageId), ['1000000001']);
    assert.ok(!JSON.stringify(pages.body).includes('token'));
  });

  it('abrir a conversa devolve as mensagens e zera o não lido', async () => {
    const list = (await api('/conversations')).body.data;
    const id = list[0].id;
    assert.equal(list[0].unreadCount, 1);
    const res = await api(`/conversations/${id}/messages`);
    assert.equal(res.status, 200);
    assert.ok(res.body.data.messages.length >= 2);
    assert.equal((await api('/conversations')).body.data[0].unreadCount, 0);
  });

  it('a conversa de outro provedor é 404, nunca 403', async () => {
    const doBeta = await getDb()('messenger_conversations').where({ tenant_id: beta }).first();
    assert.equal((await api(`/conversations/${doBeta.id}/messages`)).status, 404);
    assert.equal((await api(`/conversations/${doBeta.id}/messages`, { method: 'POST', body: { text: 'oi' } })).status, 404);
  });

  describe('envio', () => {
    const calls = [];
    before(() => {
      setMetaGraphFetcher(async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ recipient_id: 'psid-1', message_id: `m.sent.${calls.length}` }), { status: 200 });
      });
    });

    it('responde dentro da janela e grava como enviada, com o token só no cabeçalho', async () => {
      const id = (await api('/conversations')).body.data[0].id;
      const res = await api(`/conversations/${id}/messages`, { method: 'POST', body: { text: '  Já estamos verificando  ' } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.deliveryStatus, 'sent');
      const sent = calls.at(-1);
      assert.match(sent.url, /\/1000000001\/messages$/);
      assert.equal(sent.init.headers.Authorization, 'Bearer tok');
      assert.ok(!sent.url.includes('tok'));
      const payload = JSON.parse(sent.init.body);
      assert.equal(payload.messaging_type, 'RESPONSE');
      assert.equal(payload.recipient.id, 'psid-1');
      assert.equal(payload.message.text, 'Já estamos verificando');
    });

    it('recusa texto vazio e longo demais, sem chamar a Meta', async () => {
      const id = (await api('/conversations')).body.data[0].id;
      const antes = calls.length;
      assert.equal((await api(`/conversations/${id}/messages`, { method: 'POST', body: { text: '   ' } })).body.code, 'empty_message');
      assert.equal((await api(`/conversations/${id}/messages`, { method: 'POST', body: { text: 'x'.repeat(2001) } })).body.code, 'message_too_long');
      assert.equal(calls.length, antes);
    });

    it('com a janela de 24 h fechada, recusa com 409 e não chama a Meta', async () => {
      const id = (await api('/conversations')).body.data[0].id;
      await runInTenant(alfa, () => MessengerConversation.update(id, { last_inbound_at: new Date(Date.now() - 25 * 3600_000) }));
      const antes = calls.length;
      const res = await api(`/conversations/${id}/messages`, { method: 'POST', body: { text: 'oi' } });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'window_closed');
      assert.equal(calls.length, antes);
      assert.equal((await api('/conversations')).body.data[0].windowOpen, false);
      await runInTenant(alfa, () => MessengerConversation.update(id, { last_inbound_at: new Date() }));
    });

    it('se a Meta recusar, grava a tentativa como falha com o motivo', async () => {
      setMetaGraphFetcher(async () => new Response(JSON.stringify({ error: { code: 10, message: 'fora da janela' } }), { status: 400 }));
      const id = (await api('/conversations')).body.data[0].id;
      const res = await api(`/conversations/${id}/messages`, { method: 'POST', body: { text: 'tentando' } });
      assert.equal(res.status, 502);
      assert.equal(res.body.data.deliveryStatus, 'failed');
      assert.match(res.body.data.deliveryError, /fora da janela/);
    });
  });

  it('arquiva e a próxima mensagem da pessoa reabre', async () => {
    const id = (await api('/conversations')).body.data[0].id;
    const closed = await api(`/conversations/${id}/closed`, { method: 'POST', body: { closed: true } });
    assert.equal(closed.status, 200);
    assert.ok(closed.body.data.closedAt);
    assert.equal((await api('/conversations')).body.data.length, 0);
    assert.equal((await api('/conversations?status=closed')).body.data.length, 1);
    assert.equal(await deliver(inbound('1000000001', 'psid-1', 'm.reopen', 'voltei')), 200);
    assert.equal((await api('/conversations')).body.data.length, 1);
    assert.equal((await api(`/conversations/${id}/closed`, { method: 'POST', body: { closed: 'sim' } })).status, 400);
  });
});

describe('conexão da Página', () => {
  const graph = (handler) => setMetaGraphFetcher(async (url, init) => handler(String(url), init));
  const ok = (data) => new Response(JSON.stringify(data), { status: 200 });

  it('confere o token na Graph, assina os campos do webhook e guarda o token cifrado', async () => {
    const seen = [];
    graph((url, init) => {
      seen.push({ url, method: init.method });
      if (url.includes('/subscribed_apps')) return ok({ success: true });
      return ok({ id: '3000000003', name: 'Provedor Alfa Net' });
    });
    const res = await api('/pages', { method: 'POST', body: { pageId: '3000000003', pageToken: 'EAAB-novo' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'connected');
    assert.equal(res.body.data.pageName, 'Provedor Alfa Net');
    assert.ok(res.body.data.subscribedAt);
    assert.ok(!JSON.stringify(res.body).includes('EAAB-novo'));
    const row = await getDb()('messenger_pages').where({ page_id: '3000000003' }).first();
    assert.ok(!row.page_token.includes('EAAB-novo'));
    assert.equal(decryptPageToken(row.page_token), 'EAAB-novo');
    assert.ok(seen.some((s) => s.method === 'POST' && s.url.endsWith('/3000000003/subscribed_apps')));
  });

  it('recusa Página já conectada (a deste ou de outro provedor) sem dizer de quem é', async () => {
    graph(() => ok({ id: '2000000002', name: 'x' }));
    const res = await api('/pages', { method: 'POST', body: { pageId: '2000000002', pageToken: 't' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'page_already_connected');
  });

  it('recusa id inválido, token que é de outra Página e token que a Meta recusa', async () => {
    graph(() => ok({ id: '5555555555', name: 'outra' }));
    assert.equal((await api('/pages', { method: 'POST', body: { pageId: 'abc', pageToken: 't' } })).body.code, 'invalid_page_id');
    assert.equal((await api('/pages', { method: 'POST', body: { pageId: '4000000004', pageToken: 't' } })).body.code, 'page_mismatch');
    graph(() => new Response(JSON.stringify({ error: { code: 190, message: 'token inválido' } }), { status: 401 }));
    const res = await api('/pages', { method: 'POST', body: { pageId: '4000000004', pageToken: 't' } });
    assert.equal(res.status, 502);
    assert.equal(await getDb()('messenger_pages').where({ page_id: '4000000004' }).first(), undefined);
  });

  it('se a Meta recusar a assinatura, a Página fica em erro com o motivo', async () => {
    graph((url) => (url.includes('/subscribed_apps')
      ? new Response(JSON.stringify({ error: { code: 200, message: 'sem permissão' } }), { status: 403 })
      : ok({ id: '6000000006', name: 'P6' })));
    const res = await api('/pages', { method: 'POST', body: { pageId: '6000000006', pageToken: 't' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'error');
    assert.match(res.body.data.webhookError, /sem permissão/);
  });

  it('desconectar apaga a Página e, em cascata, as conversas e mensagens dela', async () => {
    graph(() => ok({ success: true }));
    const page = await getDb()('messenger_pages').where({ page_id: '1000000001' }).first();
    const res = await api(`/pages/${page.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(await getDb()('messenger_conversations').where({ tenant_id: alfa }).first(), undefined);
    assert.equal(await getDb()('messenger_messages').where({ tenant_id: alfa }).first(), undefined);
    // O outro provedor não foi tocado.
    assert.ok(await getDb()('messenger_conversations').where({ tenant_id: beta }).first());
    assert.equal((await api(`/pages/${page.id}`, { method: 'DELETE' })).status, 404);
  });
});
