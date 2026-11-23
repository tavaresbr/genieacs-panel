import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

process.env.META_APP_SECRET = 'segredo-do-app-meta';
process.env.MESSENGER_VERIFY_TOKEN = 'token-de-verificacao';

const { setMediaFetcher, isMetaMediaUrl, normalizeMime, MAX_MEDIA_BYTES } = await import('../src/services/messengerMediaService.js');
const { default: MessengerMediaService } = await import('../src/services/messengerMediaService.js');
const { encryptPageToken } = await import('../src/services/messengerPageService.js');
const { DATA_DIR } = await import('../src/config/paths.js');
const { setMetaGraphFetcher } = await import('../src/services/metaGraphClient.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let panelUrl;
let token;
let alfa;
let beta;
const fetched = [];
let cdn = null;
const api = (p, options = {}) => call(`${panelUrl}/api/messenger${p}`, { headers: authHeaders(token), ...options });
const sign = (raw) => `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex')}`;
async function deliver(pageId, psid, mid, attachments) {
  const raw = JSON.stringify({
    object: 'page',
    entry: [{ id: pageId, time: Date.now(), messaging: [{
      sender: { id: psid }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, attachments }
    }] }]
  });
  const res = await fetch(`${panelUrl}/api/messenger-webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) }, body: raw
  });
  await MessengerMediaService.idle();
  return res.status;
}
const messageOf = (mid) => getDb()('messenger_messages').where({ external_id: mid }).first();
const image = (url) => [{ type: 'image', payload: { url } }];

before(async () => {
  ({ panelUrl } = await startTestServers());
  setMetaGraphFetcher(async () => new Response('{}', { status: 500 }));
  setMediaFetcher(async (url, init) => {
    fetched.push({ url: String(url), maxBytes: init.maxBytes });
    return cdn ? cdn(url) : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
  for (const [tenant, pageId] of [[alfa, '9200000001'], [beta, '9200000002']]) {
    await db('messenger_pages').insert({
      tenant_id: tenant, page_id: pageId, page_name: pageId, page_token: encryptPageToken('t'), status: 'connected'
    });
  }
});
after(async () => {
  setMediaFetcher(null);
  setMetaGraphFetcher(null);
  await stopTestServers();
});

describe('o endereço do anexo', () => {
  it('só https e só CDN da Meta', () => {
    assert.equal(isMetaMediaUrl('https://scontent.xx.fbcdn.net/v/t1/a.png'), true);
    assert.equal(isMetaMediaUrl('https://lookaside.fbsbx.com/x'), true);
    for (const bad of ['http://scontent.xx.fbcdn.net/a', 'https://evilfbcdn.net/a', 'https://fbcdn.net.evil.com/a',
      'https://127.0.0.1/a', 'https://user:pw@scontent.xx.fbcdn.net/a', 'https://scontent.xx.fbcdn.net:8443/a', 'lixo', '']) {
      assert.equal(isMetaMediaUrl(bad), false, bad);
    }
  });
  it('o tipo vem de uma lista fechada', () => {
    assert.equal(normalizeMime('image/png; charset=x'), 'image/png');
    assert.equal(normalizeMime('text/html'), 'application/octet-stream');
    assert.equal(normalizeMime('image/svg+xml'), 'application/octet-stream');
    assert.equal(normalizeMime(null), 'application/octet-stream');
  });
});

describe('anexo recebido', () => {
  it('desce, fica em disco no caminho do provedor e a tela o busca pelo painel', async () => {
    fetched.length = 0;
    assert.equal(await deliver('9200000001', 'p-img', 'm.img.1', image('https://scontent.xx.fbcdn.net/v/a.png')), 200);
    const msg = await messageOf('m.img.1');
    assert.ok(msg.attachment_path.startsWith(path.join('messenger-media', `t${alfa}`)), msg.attachment_path);
    assert.equal(msg.attachment_mime, 'image/png');
    assert.equal(msg.attachment_size, PNG.length);
    assert.deepEqual(fs.readFileSync(path.join(DATA_DIR, msg.attachment_path)), PNG);
    assert.equal(fetched[0].maxBytes, MAX_MEDIA_BYTES);

    const res = await fetch(`${panelUrl}/api/messenger/messages/${msg.id}/attachment`, { headers: authHeaders(token) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-disposition'), /^inline/);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);

    const list = await api(`/conversations/${msg.conversation_id}/messages`);
    const shown = list.body.data.messages.find((m) => m.id === msg.id);
    assert.equal(shown.attachmentStored, true);
    assert.equal(shown.attachmentMime, 'image/png');
    assert.ok(!JSON.stringify(list.body).includes('messenger-media'), 'o caminho nunca sai do servidor');
  });

  it('tipo fora da lista vira download, nunca inline', async () => {
    cdn = () => new Response('<script>alert(1)</script>', { status: 200, headers: { 'content-type': 'text/html' } });
    await deliver('9200000001', 'p-html', 'm.html.1', [{ type: 'file', payload: { url: 'https://scontent.xx.fbcdn.net/v/x.html' } }]);
    cdn = null;
    const msg = await messageOf('m.html.1');
    assert.equal(msg.attachment_mime, 'application/octet-stream');
    const res = await fetch(`${panelUrl}/api/messenger/messages/${msg.id}/attachment`, { headers: authHeaders(token) });
    assert.match(res.headers.get('content-disposition'), /^attachment/);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  });

  it('endereço que não é da Meta nem é buscado; a mensagem entra sem arquivo', async () => {
    fetched.length = 0;
    assert.equal(await deliver('9200000001', 'p-evil', 'm.evil.1', image('https://169.254.169.254/latest/meta-data')), 200);
    assert.equal(fetched.length, 0);
    const msg = await messageOf('m.evil.1');
    assert.equal(msg.attachment_path, null);
    assert.ok(msg.id);
  });

  it('CDN fora do ar ou arquivo vazio: mensagem entra, sem arquivo, e a entrega responde 200', async () => {
    cdn = () => new Response('', { status: 404 });
    assert.equal(await deliver('9200000001', 'p-404', 'm.404.1', image('https://scontent.xx.fbcdn.net/v/a.png')), 200);
    cdn = () => { throw new Error('rede'); };
    assert.equal(await deliver('9200000001', 'p-down', 'm.down.1', image('https://scontent.xx.fbcdn.net/v/b.png')), 200);
    cdn = null;
    for (const mid of ['m.404.1', 'm.down.1']) {
      const msg = await messageOf(mid);
      assert.equal(msg.attachment_path, null);
      assert.ok(msg.attachment_url, 'o link original fica como último recurso');
    }
  });

  it('reentrega não baixa de novo', async () => {
    fetched.length = 0;
    await deliver('9200000001', 'p-img', 'm.img.1', image('https://scontent.xx.fbcdn.net/v/a.png'));
    assert.equal(fetched.length, 0);
  });

  it('sem arquivo, mensagem de outro provedor ou inexistente: 404', async () => {
    const semArquivo = await messageOf('m.404.1');
    assert.equal((await fetch(`${panelUrl}/api/messenger/messages/${semArquivo.id}/attachment`, { headers: authHeaders(token) })).status, 404);
    await deliver('9200000002', 'p-beta', 'm.beta.1', image('https://scontent.xx.fbcdn.net/v/c.png'));
    const doBeta = await messageOf('m.beta.1');
    assert.ok(doBeta.attachment_path.startsWith(path.join('messenger-media', `t${beta}`)));
    assert.equal((await fetch(`${panelUrl}/api/messenger/messages/${doBeta.id}/attachment`, { headers: authHeaders(token) })).status, 404);
    assert.equal((await fetch(`${panelUrl}/api/messenger/messages/999999/attachment`, { headers: authHeaders(token) })).status, 404);
  });

  it('caminho gravado que escapa da pasta de dados não é servido', async () => {
    const msg = await messageOf('m.img.1');
    await getDb()('messenger_messages').where({ id: msg.id }).update({ attachment_path: '../../etc/passwd' });
    assert.equal((await fetch(`${panelUrl}/api/messenger/messages/${msg.id}/attachment`, { headers: authHeaders(token) })).status, 404);
  });

  it('desconectar a Página apaga os arquivos dos anexos dela', async () => {
    const msg = await messageOf('m.html.1');
    const file = path.join(DATA_DIR, msg.attachment_path);
    assert.ok(fs.existsSync(file));
    const page = await getDb()('messenger_pages').where({ page_id: '9200000001' }).first();
    setMetaGraphFetcher(async () => new Response('{}', { status: 200 }));
    const res = await api(`/pages/${page.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(fs.existsSync(file), false);
    assert.equal(await getDb()('messenger_messages').where({ id: msg.id }).first(), undefined);
    // O arquivo do outro provedor não foi tocado.
    const doBeta = await messageOf('m.beta.1');
    assert.ok(fs.existsSync(path.join(DATA_DIR, doBeta.attachment_path)));
  });
});
