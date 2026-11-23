import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.META_APP_SECRET = 'segredo-do-app-meta';
process.env.MESSENGER_VERIFY_TOKEN = 'token-de-verificacao';

const { authHeaders, call, defaultTenantId, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { default: CustomerPortalPasswordService } = await import('../src/services/customerPortalPasswordService.js');
const { encryptPageToken } = await import('../src/services/messengerPageService.js');

/**
 * O botão "Messenger" do portal do assinante: o link nasce do contrato da ONT de
 * QUEM ESTÁ LOGADO, então ao abri-lo a conversa já nasce vinculada — o vínculo
 * de maior confiança, porque quem pede está autenticado.
 */
const CUSTOMER_ID = 'CSG-MSGPTL1-123456';
let panelUrl;
let portalUrl;
let token;
let cookie;
let tenantId;
let accountId;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  const db = getDb();
  tenantId = await defaultTenantId();
  const created = await CustomerPortalPasswordService.createRecord();
  const inserted = await db('customer_accounts').insert({
    tenant_id: tenantId, customer_id: CUSTOMER_ID, device_id: 'portal-msg-device', identity_hash: 'pm'.padEnd(64, '0'),
    software_id: 'V1', pppoe_username: 'portal@isp', active: true, ...created.record
  }).returning('id');
  accountId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  await db('sgp_links').insert({ tenant_id: tenantId, device_id: 'portal-msg-device', contract: 'CT-PORTAL-1', client_name: 'Assinante do Portal', state: 'active' });
  const login = await call(`${portalUrl}/api/customer/login`, { method: 'POST', body: { customerId: CUSTOMER_ID, password: created.password } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  cookie = login.response.headers.getSetCookie().find((e) => e.startsWith('skygp_portal_session=')).split(';')[0];
  await call(`${panelUrl}/api/settings/portalShowProviderContact`, { method: 'PUT', headers: authHeaders(token), body: { value: 'true' } });
});
after(stopTestServers);

const link = (headers = { Cookie: cookie }) => call(`${portalUrl}/api/customer/messenger-link`, { method: 'POST', headers });
const provider = () => call(`${portalUrl}/api/customer/provider`, { headers: { Cookie: cookie } });

describe('POST /api/customer/messenger-link', () => {
  it('sem sessão do portal, 401', async () => {
    assert.equal((await link({})).status, 401);
  });

  it('sem Página conectada: 409, e o portal não oferece o botão', async () => {
    const res = await link();
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'no_page');
    assert.equal((await provider()).body.data.messenger, false);
  });

  it('com Página conectada, devolve o link do contrato de quem está logado', async () => {
    await getDb()('messenger_pages').insert({
      tenant_id: tenantId, page_id: '1000000001', page_name: 'P', page_token: encryptPageToken('tok'), status: 'connected'
    });
    assert.equal((await provider()).body.data.messenger, true);
    const res = await link();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.data.url, /^https:\/\/m\.me\/1000000001\?ref=[A-Za-z0-9_-]{22}$/);
    // Nada além da URL sai para o portal.
    assert.deepEqual(Object.keys(res.body.data), ['url']);
    const row = await getDb()('messenger_link_tokens').where({ tenant_id: tenantId }).first();
    assert.equal(row.contract, 'CT-PORTAL-1');
    assert.equal(row.customer_account_id, accountId);
    assert.equal(row.source, 'portal');
    assert.equal(row.created_by, null);
  });

  it('abrir o link vincula a conversa à conta e ao contrato do assinante', async () => {
    const ref = new URL((await link()).body.data.url).searchParams.get('ref');
    const raw = JSON.stringify({
      object: 'page',
      entry: [{ id: '1000000001', messaging: [{ sender: { id: 'psid-portal' }, recipient: { id: '1000000001' }, timestamp: Date.now(), referral: { ref, source: 'SHORTLINK', type: 'OPEN_THREAD' } }] }]
    });
    const sig = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex')}`;
    const res = await fetch(`${panelUrl}/api/messenger-webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
    assert.equal(res.status, 200);
    const conv = await getDb()('messenger_conversations').where({ psid: 'psid-portal' }).first();
    assert.equal(conv.contract, 'CT-PORTAL-1');
    assert.equal(conv.customer_account_id, accountId);
    assert.equal(conv.bound_via, 'link');
  });

  it('o dossiê do assinante alcança a conversa e os links emitidos para ele', async () => {
    const { alcanceDoAssinante } = await import('../src/services/customerDataExportService.js');
    const { default: CustomerAccount } = await import('../src/models/CustomerAccount.js');
    const { runInTenant } = await import('./helpers/harness.js');
    const alcance = await runInTenant(tenantId, async () => alcanceDoAssinante(await CustomerAccount.getById(accountId)));
    assert.equal(alcance.messengerConversaIds.length, 1);
    assert.ok(alcance.linksMessenger.length >= 2);
    assert.ok(alcance.linksMessenger.every((l) => l.customer_account_id === accountId));
  });
});
