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

const metaCalls = [];
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
  setMetaGraphFetcher(async (url) => {
    metaCalls.push(String(url));
    return new Response('{}', { status: 500 });
  });
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

describe('vínculo com o assinante', () => {
  const convOf = async (tenant, psid) => getDb()('messenger_conversations').where({ tenant_id: tenant, psid }).first();
  let convId;
  let accountId;

  before(async () => {
    convId = (await convOf(alfa, 'psid-1')).id;
    const db = getDb();
    accountId = (await db('customer_accounts').insert({
      tenant_id: alfa, customer_id: 'CSG-MSG-1', device_id: 'ONT-MSG-1', identity_hash: 'a'.repeat(64),
      software_id: 'V1', pppoe_username: 'maria.msg', active: true
    }).returning('id'))[0];
    accountId = typeof accountId === 'object' ? accountId.id : accountId;
    await db('sgp_links').insert({ tenant_id: alfa, device_id: 'ONT-MSG-1', contract: 'CT-ALFA-1', client_name: 'Maria da Silva', state: 'active' });
    await db('sgp_contacts').insert({ tenant_id: alfa, contract: 'CT-ALFA-SEM-ONT', client_name: 'João Sem ONT' });
    await db('sgp_links').insert({ tenant_id: beta, device_id: 'ONT-MSG-BETA', contract: 'CT-BETA-1', client_name: 'Cliente do Beta', state: 'active' });
  });

  it('sem vínculo, a conversa não tem cliente', async () => {
    const list = (await api('/conversations')).body.data.find((c) => c.id === convId);
    assert.equal(list.linked, false);
    assert.equal(list.clientName, null);
  });

  it('vincula a um contrato: guarda contrato e conta do portal, e a lista traz o nome', async () => {
    const res = await api(`/conversations/${convId}/subscriber`, { method: 'POST', body: { contract: 'CT-ALFA-1' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.contract, 'CT-ALFA-1');
    assert.equal(res.body.data.clientName, 'Maria da Silva');
    assert.equal(res.body.data.linked, true);
    const row = await convOf(alfa, 'psid-1');
    assert.equal(row.customer_account_id, accountId);
    assert.equal(row.bound_via, 'operator');
    const list = (await api('/conversations')).body.data.find((c) => c.id === convId);
    assert.equal(list.clientName, 'Maria da Silva');
    const thread = await api(`/conversations/${convId}/messages`);
    assert.equal(thread.body.data.conversation.clientName, 'Maria da Silva');
  });

  it('vincula a um cliente do cadastro sem ONT pelo contrato, e a um sem contrato por c:<id>', async () => {
    const semOnt = await api(`/conversations/${convId}/subscriber`, { method: 'POST', body: { contract: 'CT-ALFA-SEM-ONT' } });
    assert.equal(semOnt.status, 200, JSON.stringify(semOnt.body));
    assert.equal(semOnt.body.data.clientName, 'João Sem ONT');
    assert.equal((await convOf(alfa, 'psid-1')).customer_account_id, null);

    const contato = await getDb()('sgp_contacts').insert({ tenant_id: alfa, contract: null, client_name: 'Ana Sem Contrato' }).returning('id');
    const contatoId = typeof contato[0] === 'object' ? contato[0].id : contato[0];
    const semContrato = await api(`/conversations/${convId}/subscriber`, { method: 'POST', body: { contract: `c:${contatoId}` } });
    assert.equal(semContrato.status, 200, JSON.stringify(semContrato.body));
    assert.equal(semContrato.body.data.contract, null);
    assert.equal(semContrato.body.data.sgpContactId, contatoId);
    assert.equal(semContrato.body.data.clientName, 'Ana Sem Contrato');
    assert.equal(semContrato.body.data.linked, true);
  });

  it('contrato que não existe, ou que é de outro provedor, dá o mesmo 404', async () => {
    const nunca = await api(`/conversations/${convId}/subscriber`, { method: 'POST', body: { contract: 'CT-NUNCA' } });
    const doBeta = await api(`/conversations/${convId}/subscriber`, { method: 'POST', body: { contract: 'CT-BETA-1' } });
    assert.equal(nunca.status, 404);
    assert.equal(nunca.body.code, 'subscriber_not_found');
    assert.equal(doBeta.status, 404);
    assert.deepEqual(doBeta.body, nunca.body);
    assert.equal((await api(`/conversations/${convId}/subscriber`, { method: 'POST', body: {} })).body.code, 'invalid_body');
  });

  it('o contrato vinculado entra no dossiê do assinante', async () => {
    await api(`/conversations/${convId}/subscriber`, { method: 'POST', body: { contract: 'CT-ALFA-1' } });
    const { alcanceDoAssinante } = await import('../src/services/customerDataExportService.js');
    const { default: CustomerAccount } = await import('../src/models/CustomerAccount.js');
    const alcance = await runInTenant(alfa, async () => alcanceDoAssinante(await CustomerAccount.getById(accountId)));
    assert.deepEqual(alcance.messengerConversaIds, [convId]);
  });

  it('desvincula', async () => {
    const res = await api(`/conversations/${convId}/subscriber`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.linked, false);
    const row = await convOf(alfa, 'psid-1');
    assert.deepEqual([row.contract, row.sgp_contact_id, row.customer_account_id, row.bound_via], [null, null, null, null]);
  });

  it('a conversa de outro provedor é 404 ao vincular e ao desvincular', async () => {
    const doBeta = await getDb()('messenger_conversations').where({ tenant_id: beta }).first();
    assert.equal((await api(`/conversations/${doBeta.id}/subscriber`, { method: 'POST', body: { contract: 'CT-ALFA-1' } })).status, 404);
    assert.equal((await api(`/conversations/${doBeta.id}/subscriber`, { method: 'DELETE' })).status, 404);
  });
});

describe('link de vínculo automático (?ref=)', () => {
  const refOfUrl = (url) => new URL(url).searchParams.get('ref');
  const post = (body) => api('/links', { method: 'POST', body });
  const referral = (psid, ref, shape = 'referral') => {
    const base = { sender: { id: psid }, recipient: { id: '1000000001' }, timestamp: Date.now() };
    const r = { ref, source: 'SHORTLINK', type: 'OPEN_THREAD' };
    const event = shape === 'postback'
      ? { ...base, postback: { title: 'Get Started', payload: 'GET_STARTED', referral: r } }
      : shape === 'message'
        ? { ...base, message: { mid: `m.ref.${psid}.${ref.slice(0, 6)}`, text: 'oi', referral: r } }
        : { ...base, referral: r };
    return { object: 'page', entry: [{ id: '1000000001', messaging: [event] }] };
  };
  const convOf = (psid) => getDb()('messenger_conversations').where({ tenant_id: alfa, psid }).first();

  it('emite um link m.me da Página conectada; só o hash do token fica guardado', async () => {
    const res = await post({ contract: 'CT-ALFA-1' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.data.url, /^https:\/\/m\.me\/1000000001\?ref=[A-Za-z0-9_-]{22}$/);
    assert.ok(new Date(res.body.data.expiresAt).getTime() > Date.now() + 6 * 24 * 3600_000);
    const ref = refOfUrl(res.body.data.url);
    const rows = await getDb()('messenger_link_tokens').where({ tenant_id: alfa });
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, ref);
    assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(ref).digest('hex'));
    assert.equal(rows[0].contract, 'CT-ALFA-1');
    assert.equal(rows[0].source, 'operator');
    assert.equal(JSON.stringify(rows).includes(ref), false);
  });

  it('contrato inexistente e contrato de outro provedor dão o mesmo 404; sem corpo, 400', async () => {
    const nunca = await post({ contract: 'CT-NUNCA' });
    const doBeta = await post({ contract: 'CT-BETA-1' });
    assert.equal(nunca.status, 404);
    assert.deepEqual(doBeta.body, nunca.body);
    assert.equal((await post({})).body.code, 'invalid_body');
  });

  it('abrir o link vincula a conversa de quem abriu, pelos três formatos de evento', async () => {
    for (const [psid, shape] of [['psid-ref-a', 'referral'], ['psid-ref-b', 'postback'], ['psid-ref-c', 'message']]) {
      const ref = refOfUrl((await post({ contract: 'CT-ALFA-1' })).body.data.url);
      assert.equal(await deliver(referral(psid, ref, shape)), 200);
      const conv = await convOf(psid);
      assert.ok(conv, `${shape}: a conversa tem que existir`);
      assert.equal(conv.contract, 'CT-ALFA-1', shape);
      assert.equal(conv.bound_via, 'link', shape);
      assert.equal(conv.customer_account_id, (await getDb()('customer_accounts').where({ device_id: 'ONT-MSG-1' }).first()).id, shape);
    }
    const lista = (await api('/conversations')).body.data.find((c) => c.psid === 'psid-ref-a');
    assert.equal(lista.clientName, 'Maria da Silva');
    assert.equal(lista.linked, true);
  });

  it('o link é de uso único: a segunda pessoa não é vinculada nem ganha conversa', async () => {
    const ref = refOfUrl((await post({ contract: 'CT-ALFA-1' })).body.data.url);
    assert.equal(await deliver(referral('psid-once-1', ref)), 200);
    assert.equal(await deliver(referral('psid-once-2', ref)), 200);
    assert.equal((await convOf('psid-once-1')).contract, 'CT-ALFA-1');
    assert.equal(await convOf('psid-once-2'), undefined);
  });

  it('a reentrega do mesmo evento não gasta nem duplica nada', async () => {
    const ref = refOfUrl((await post({ contract: 'CT-ALFA-1' })).body.data.url);
    const evento = referral('psid-redeliver', ref);
    assert.equal(await deliver(evento), 200);
    assert.equal(await deliver(evento), 200);
    const n = await getDb()('messenger_conversations').where({ tenant_id: alfa, psid: 'psid-redeliver' }).count({ n: '*' }).first();
    assert.equal(Number(n.n), 1);
  });

  it('duas pessoas abrindo ao mesmo tempo: só uma é vinculada', async () => {
    const ref = refOfUrl((await post({ contract: 'CT-ALFA-1' })).body.data.url);
    await Promise.all([deliver(referral('psid-race-1', ref)), deliver(referral('psid-race-2', ref))]);
    const vinculadas = [await convOf('psid-race-1'), await convOf('psid-race-2')].filter((c) => c?.contract === 'CT-ALFA-1');
    assert.equal(vinculadas.length, 1);
  });

  it('link vencido não vincula', async () => {
    const ref = refOfUrl((await post({ contract: 'CT-ALFA-1' })).body.data.url);
    await getDb()('messenger_link_tokens')
      .where({ token_hash: crypto.createHash('sha256').update(ref).digest('hex') })
      .update({ expires_at: new Date(Date.now() - 1000) });
    assert.equal(await deliver(referral('psid-expired', ref)), 200);
    assert.equal(await convOf('psid-expired'), undefined);
  });

  it('não sobrescreve um vínculo que o atendente já fez', async () => {
    assert.equal(await deliver(inbound('1000000001', 'psid-keep', 'm.keep', 'oi')), 200);
    const conv = await convOf('psid-keep');
    await api(`/conversations/${conv.id}/subscriber`, { method: 'POST', body: { contract: 'CT-ALFA-SEM-ONT' } });
    const ref = refOfUrl((await post({ contract: 'CT-ALFA-1' })).body.data.url);
    assert.equal(await deliver(referral('psid-keep', ref)), 200);
    const depois = await convOf('psid-keep');
    assert.equal(depois.contract, 'CT-ALFA-SEM-ONT');
    assert.equal(depois.bound_via, 'operator');
    // E o link continua valendo para quem ainda não tem vínculo.
    assert.equal(await deliver(referral('psid-fresh', ref)), 200);
    assert.equal((await convOf('psid-fresh')).contract, 'CT-ALFA-1');
  });

  it('um ref que não é do painel, ou de outro provedor, é ignorado', async () => {
    assert.equal(await deliver(referral('psid-junk', 'campanha-natal')), 200);
    assert.equal(await convOf('psid-junk'), undefined);
    // Um token VÁLIDO do beta, entregue na Página do alfa.
    const tokenBeta = crypto.randomBytes(16).toString('base64url');
    await getDb()('messenger_link_tokens').insert({
      tenant_id: beta, token_hash: crypto.createHash('sha256').update(tokenBeta).digest('hex'),
      contract: 'CT-BETA-1', source: 'operator', expires_at: new Date(Date.now() + 3600_000)
    });
    assert.equal(await deliver(referral('psid-cross', tokenBeta)), 200);
    assert.equal(await convOf('psid-cross'), undefined);
    const doBeta = await getDb()('messenger_link_tokens').where({ tenant_id: beta }).first();
    assert.equal(doBeta.used_at, null, 'o token do beta não pode ter sido gasto');
  });

  it('sem Página conectada, não há para onde apontar: 409', async () => {
    await getDb()('messenger_pages').where({ page_id: '1000000001' }).update({ status: 'error' });
    const res = await post({ contract: 'CT-ALFA-1' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'no_page');
    await getDb()('messenger_pages').where({ page_id: '1000000001' }).update({ status: 'connected' });
  });

  it('assinar de novo os campos do webhook: recusa sem token e não toca na Meta', async () => {
    const [semToken] = await getDb()('messenger_pages').insert({
      tenant_id: alfa, page_id: '7000000007', page_name: 'Sem token', page_token: null, status: 'connected'
    }).returning('id');
    const id = typeof semToken === 'object' ? semToken.id : semToken;
    const antes = metaCalls.length;
    const res = await api(`/pages/${id}/subscribe`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'missing_token');
    assert.equal(metaCalls.length, antes);
    await getDb()('messenger_pages').where({ id }).del();
  });

  it('assinar de novo, com token: pede à Meta os campos, inclusive messaging_referrals', async () => {
    const page = await getDb()('messenger_pages').where({ page_id: '1000000001' }).first();
    let body = null;
    setMetaGraphFetcher(async (url, init) => {
      if (String(url).endsWith('/subscribed_apps')) body = JSON.parse(init.body);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const res = await api(`/pages/${page.id}/subscribe`, { method: 'POST' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'connected');
    assert.ok(body.subscribed_fields.includes('messaging_referrals'));
  });

  it('a assinatura inclui messaging_referrals', async () => {
    const { SUBSCRIBED_FIELDS } = await import('../src/services/messengerPageService.js');
    assert.ok(SUBSCRIBED_FIELDS.split(',').includes('messaging_referrals'));
  });
});

describe('prévia da última mensagem na lista', () => {
  const previewOf = async (psid) => (await api('/conversations')).body.data.find((c) => c.psid === psid)?.lastMessage;
  const withAttachment = (psid, mid) => ({
    object: 'page',
    entry: [{ id: '1000000001', messaging: [{
      sender: { id: psid }, recipient: { id: '1000000001' }, timestamp: Date.now(),
      message: { mid, attachments: [{ type: 'image', payload: { url: 'https://cdn.exemplo.test/foto.jpg' } }] }
    }] }]
  });
  const echo = (psid, mid, text) => ({
    object: 'page',
    entry: [{ id: '1000000001', messaging: [{
      sender: { id: '1000000001' }, recipient: { id: psid }, timestamp: Date.now(),
      message: { mid, text, is_echo: true }
    }] }]
  });

  it('traz a última mensagem gravada, numa linha só e limitada', async () => {
    assert.equal(await deliver(inbound('1000000001', 'psid-prev', 'm.p1', 'primeira')), 200);
    const longa = `Linha um\n   linha  dois ${'x'.repeat(300)}`;
    assert.equal(await deliver(inbound('1000000001', 'psid-prev', 'm.p2', longa)), 200);
    const prev = await previewOf('psid-prev');
    assert.equal(prev.direction, 'in');
    assert.equal(prev.text.length, 120);
    assert.ok(prev.text.endsWith('…'));
    assert.ok(prev.text.startsWith('Linha um linha dois x'));
    assert.ok(!/\s{2,}|\n/.test(prev.text), 'sem quebra de linha nem espaço duplo');
    assert.equal(prev.attachmentType, null);
    assert.equal(prev.deliveryStatus, null);
  });

  it('mensagem só com anexo: sem texto, com o tipo do anexo', async () => {
    assert.equal(await deliver(withAttachment('psid-prev', 'm.p3')), 200);
    const prev = await previewOf('psid-prev');
    assert.equal(prev.text, null);
    assert.equal(prev.attachmentType, 'image');
    // A URL do anexo não vai na lista: só ao abrir a conversa.
    assert.ok(!JSON.stringify(prev).includes('cdn.exemplo.test'));
  });

  it('a resposta da Página vira a última, com a direção de saída', async () => {
    assert.equal(await deliver(echo('psid-prev', 'm.p4', 'Já estamos verificando')), 200);
    const prev = await previewOf('psid-prev');
    assert.equal(prev.direction, 'out');
    assert.equal(prev.text, 'Já estamos verificando');
    assert.equal(prev.deliveryStatus, 'sent');
  });

  it('cada conversa mostra a sua, e a sem mensagens vem com null', async () => {
    const [vazia] = await getDb()('messenger_conversations').insert({
      tenant_id: alfa, page_row_id: (await getDb()('messenger_pages').where({ page_id: '1000000001' }).first()).id, psid: 'psid-vazia'
    }).returning('id');
    assert.ok(vazia);
    assert.equal(await previewOf('psid-vazia'), null);
    assert.equal((await previewOf('psid-1')).text !== undefined, true);
    assert.notEqual((await previewOf('psid-prev')).text, (await previewOf('psid-1')).text);
  });

  it('não mostra prévia de mensagem de outro provedor', async () => {
    const lista = (await api('/conversations')).body.data;
    const todas = JSON.stringify(lista);
    assert.ok(!todas.includes('mensagem do beta'), 'a mensagem do beta não pode aparecer na lista do alfa');
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
