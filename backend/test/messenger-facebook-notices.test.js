import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

process.env.META_APP_SECRET = 'segredo-do-app-meta';
process.env.MESSENGER_VERIFY_TOKEN = 'token-de-verificacao';

const { encryptPageToken } = await import('../src/services/messengerPageService.js');
const { signRequestForTest, parseSignedRequest, readConfirmationCode, issueConfirmationCode } =
  await import('../src/utils/messenger/messengerSignedRequest.js');

const SECRET = process.env.META_APP_SECRET;
let panelUrl;
let alfa;
let beta;
const hook = (p) => `${panelUrl}/api/messenger-webhook${p}`;
const post = (p, signed) => fetch(hook(p), {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ signed_request: signed }).toString()
});
const page = (id) => getDb()('messenger_pages').where({ page_id: id }).first();

before(async () => {
  ({ panelUrl } = await startTestServers());
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
  const seed = (tenant, pageId, fb) => db('messenger_pages').insert({
    tenant_id: tenant, page_id: pageId, page_name: `P ${pageId}`, page_token: encryptPageToken('tok'),
    status: 'connected', subscribed_at: new Date(), facebook_user_id: fb
  });
  await seed(alfa, '8100000001', '4440001');
  await seed(beta, '8100000002', '4440001'); // o mesmo usuário conectou nos dois provedores
  await seed(alfa, '8100000003', '4440002'); // outro usuário
  await seed(alfa, '8100000004', null);      // conectada à mão
});
after(stopTestServers);

describe('signed_request', () => {
  it('só aceita assinatura e algoritmo certos', () => {
    const ok = signRequestForTest({ user_id: '123', issued_at: 1700000000 }, SECRET);
    assert.deepEqual(parseSignedRequest(ok, SECRET), { userId: '123', issuedAt: 1700000000 });
    assert.equal(parseSignedRequest(ok, 'outro'), null);
    assert.equal(parseSignedRequest(ok, ''), null);
    assert.equal(parseSignedRequest(`${ok}x`, SECRET), null);
    assert.equal(parseSignedRequest('sem-ponto', SECRET), null);
    assert.equal(parseSignedRequest(signRequestForTest({ user_id: 'abc' }, SECRET), SECRET), null);
    assert.equal(parseSignedRequest(signRequestForTest({ user_id: '1', algorithm: 'HMAC-SHA1' }, SECRET), SECRET), null);
  });

  it('o código de confirmação é verificável e não se forja', () => {
    const code = issueConfirmationCode(SECRET, Date.UTC(2026, 10, 23));
    assert.equal(readConfirmationCode(code, SECRET)?.toISOString().slice(0, 10), '2026-11-23');
    assert.equal(readConfirmationCode(code, 'outro'), null);
    assert.equal(readConfirmationCode(code.replace(/.$/, (c) => (c === '0' ? '1' : '0')), SECRET), null);
    assert.equal(readConfirmationCode('<script>', SECRET), null);
  });
});

describe('avisos da Meta sobre o usuário do Facebook', () => {
  it('recusa sem assinatura válida e não mexe em nada', async () => {
    const forged = signRequestForTest({ user_id: '4440001' }, 'segredo-errado');
    for (const path of ['/deauthorize', '/data-deletion']) {
      assert.equal((await post(path, forged)).status, 401);
      assert.equal((await post(path, 'lixo')).status, 401);
    }
    assert.equal((await page('8100000001')).status, 'connected');
  });

  it('desautorização: marca só as Páginas daquele usuário, em todos os provedores, sem apagar nada', async () => {
    const res = await post('/deauthorize', signRequestForTest({ user_id: '4440001' }, SECRET));
    assert.equal(res.status, 200);
    for (const id of ['8100000001', '8100000002']) {
      const row = await page(id);
      assert.equal(row.status, 'error');
      assert.equal(row.webhook_error, 'facebook_deauthorized');
      assert.ok(row.page_token, 'o token ainda está lá: só a exclusão o apaga');
    }
    assert.equal((await page('8100000003')).status, 'connected');
    assert.equal((await page('8100000004')).status, 'connected');
  });

  it('exclusão de dados: apaga token e id das Páginas dele, devolve url e código, e preserva as conversas', async () => {
    const conv = await getDb()('messenger_conversations').insert({
      tenant_id: alfa, page_row_id: (await page('8100000001')).id, psid: 'psid-x'
    });
    const res = await post('/data-deletion', signRequestForTest({ user_id: '4440001' }, SECRET));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.confirmation_code, /^[0-9a-f]+-[0-9a-f]{12}-[0-9a-f]{16}$/);
    assert.match(body.url, /\/api\/messenger-webhook\/deletion-status\?code=/);
    for (const id of ['8100000001', '8100000002']) {
      const row = await page(id);
      assert.equal(row.page_token, null);
      assert.equal(row.facebook_user_id, null);
      assert.equal(row.status, 'error');
      assert.equal(row.webhook_error, 'facebook_data_deleted');
    }
    // Outro usuário e Página conectada à mão: intactos.
    const outro = await page('8100000003');
    assert.ok(outro.page_token);
    assert.equal(outro.facebook_user_id, '4440002');
    assert.ok((await page('8100000004')).page_token);
    assert.ok(conv);
    assert.equal((await getDb()('messenger_conversations').where({ psid: 'psid-x' })).length, 1);

    const status = await fetch(body.url);
    assert.equal(status.status, 200);
    assert.match(await status.text(), /Concluído em \d{4}-\d{2}-\d{2}/);
  });

  it('a página de status só confirma códigos do painel e nunca imprime a URL', async () => {
    const forged = await fetch(`${hook('/deletion-status')}?code=${encodeURIComponent('<img src=x onerror=1>')}`);
    assert.equal(forged.status, 404);
    const text = await forged.text();
    assert.ok(!text.includes('onerror'));
    assert.match(text, /Código não reconhecido/);
  });

  it('sem código a página de status vira a de instruções e SEMPRE abre (a Meta valida o endereço)', async () => {
    const res = await fetch(hook('/deletion-status'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const text = await res.text();
    assert.match(text, /Como pedir a exclusão dos seus dados/);
    assert.match(text, /provedor/);
    // Com código ruim continua sendo 404 (só o painel emite códigos).
    assert.equal((await fetch(`${hook('/deletion-status')}?code=x`)).status, 404);
  });
});
