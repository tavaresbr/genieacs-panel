import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Configurações → Dados do SaaS: a logo e o favicon do sistema.
 */
process.env.EDITION = 'saas';

const { authHeaders, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { invalidatePlatformBranding } = await import('../src/services/platformBrandingService.js');

let panelUrl;
let token;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(32, 2)]);

const enviar = (kind, body, { method = 'PUT', auth = true } = {}) => fetch(`${panelUrl}/api/platform/settings/branding/${kind}`, {
  method,
  headers: { ...(auth ? authHeaders(token) : {}), 'Content-Type': 'application/octet-stream' },
  body: method === 'PUT' ? body : undefined
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await fetch(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' })
  });
  const data = (await setup.json()).data;
  token = data.token;
  const db = getDb();
  if (!(await db('platform_admins').where({ user_id: data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: data.user.id });
  }
  await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  invalidatePlatformBranding();
});

after(async () => {
  await stopTestServers();
});

describe('logo e favicon do sistema', () => {
  it('começa sem imagens', async () => {
    const res = await fetch(`${panelUrl}/api/tenant/brand`);
    const body = await res.json();
    assert.deepEqual(body.data, { logoUrl: null, faviconUrl: null });
    assert.equal((await fetch(`${panelUrl}/api/tenant/brand/logo`)).status, 404);
  });

  it('exige o administrador da plataforma', async () => {
    const res = await enviar('logo', PNG, { auth: false });
    assert.equal(res.status, 401);
  });

  it('grava, serve com o tipo provado pelos bytes e remove', async () => {
    assert.equal((await enviar('logo', PNG)).status, 200);
    assert.equal((await enviar('favicon', ICO)).status, 200);

    const info = (await (await fetch(`${panelUrl}/api/tenant/brand`)).json()).data;
    assert.match(info.logoUrl, /^\/api\/tenant\/brand\/logo\?v=/);
    assert.match(info.faviconUrl, /^\/api\/tenant\/brand\/favicon\?v=/);

    const img = await fetch(`${panelUrl}${info.logoUrl}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    assert.equal((await fetch(`${panelUrl}/api/tenant/brand/favicon`)).headers.get('content-type'), 'image/x-icon');

    assert.equal((await enviar('logo', null, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${panelUrl}/api/tenant/brand/logo`)).status, 404);
  });

  it('recusa SVG, vazio, rota desconhecida e imagem grande', async () => {
    const svg = await enviar('logo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'));
    assert.equal(svg.status, 415);
    assert.equal((await svg.json()).code, 'branding_type_invalid');

    assert.equal((await enviar('logo', Buffer.alloc(0))).status, 400);
    assert.equal((await enviar('outro', PNG)).status, 404);

    const grande = await enviar('favicon', Buffer.concat([PNG, Buffer.alloc(200 * 1024)]));
    assert.equal(grande.status, 413);
    assert.equal((await grande.json()).code, 'branding_too_large');
  });

  it('registra na trilha', async () => {
    const linha = await getDb()('platform_audit').where({ action: 'platform.branding_changed' }).first();
    assert.ok(linha);
  });
});
