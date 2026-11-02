import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O programa de afiliados (0126): o cadastro com `?aff=A-CÓDIGO` e o portal do
 * afiliado no endereço da plataforma.
 *
 * SaaS com subdomínio, porque o cadastro e o portal só existem ali (ver
 * `referrals-signup.test.js`). O dinheiro — a comissão, o lote e o Pix — está
 * em `affiliates.test.js`, que precisa do gateway de mentira em `127.0.0.1`.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const APEX = 'painel.test';
const CASA = 'default.painel.test';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { default: AffiliateService } = await import('../src/services/affiliateService.js');

let panelUrl;
let consoleToken;
let casa;
let afiliado;

function callAs(host, url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: response.statusCode, body: parsed, headers: response.headers });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const cadastrar = (body) => callAs(APEX, `${panelUrl}/api/auth/signup`, { method: 'POST', body });
const noConsole = (path, options = {}) => callAs(APEX, `${panelUrl}${path}`, {
  ...options, headers: { Authorization: `Bearer ${consoleToken}`, ...(options.headers || {}) }
});
let sequencia = 0;
const novoCadastro = (extra = {}) => {
  sequencia += 1;
  return {
    providerName: `Provedor Afiliado ${sequencia}`,
    slug: `prov-aff-${sequencia}`,
    username: `dono-aff-${sequencia}`,
    email: `dono${sequencia}@prov-aff.test`,
    password: 'senha-do-dono-1',
    ...extra
  };
};
const tenantDe = (slug) => getDb()('tenants').where({ slug }).first();

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  casa = (await db('tenants').orderBy('id', 'asc').first()).id;
  const setup = await callAs(CASA, `${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-da-casa', password: 'senha-da-casa-1', email: 'dona@casa.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const entrada = await callAs(APEX, `${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'dona-da-casa', password: 'senha-da-casa-1' }
  });
  assert.equal(entrada.status, 200, JSON.stringify(entrada.body));
  consoleToken = entrada.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  if (!(await db('tenants').where({ kind: 'platform' }).first())) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  }
  afiliado = await AffiliateService.create({
    name: 'Joana Divulgadora', email: 'joana@divulga.test', taxId: '52998224725', status: 'active'
  });
  void casa;
});

after(async () => {
  await stopTestServers();
});

describe('o cadastro com ?aff=', () => {
  it('liga o provedor novo ao afiliado, com o instante em que a janela começa', async () => {
    const corpo = novoCadastro({ affiliateCode: afiliado.code.toLowerCase() });
    const r = await cadastrar(corpo);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const tenant = await tenantDe(corpo.slug);
    assert.equal(Number(tenant.referred_by_affiliate_id), Number(afiliado.id));
    assert.ok(tenant.referred_at);
    assert.equal(tenant.referred_by_tenant_id, null);
  });

  it('ignora código inválido, de afiliado pendente e o afiliado se cadastrando', async () => {
    const pendente = await AffiliateService.create({ name: 'Pendente', email: 'pendente@divulga.test' });
    for (const extra of [
      { affiliateCode: 'A-NAOEXISTE' },
      { affiliateCode: pendente.code },
      { affiliateCode: afiliado.code, email: 'joana@divulga.test' }
    ]) {
      const corpo = novoCadastro(extra);
      // eslint-disable-next-line no-await-in-loop
      const r = await cadastrar(corpo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await tenantDe(corpo.slug)).referred_by_affiliate_id, null, JSON.stringify(extra));
    }
  });

  it('com afiliado e indicação no mesmo link, só o afiliado conta', async () => {
    const indicador = await getDb()('tenants').where({ id: casa }).first();
    let code = indicador.referral_code;
    if (!code) {
      code = 'CASA2345';
      await getDb()('tenants').where({ id: casa }).update({ referral_code: code });
    }
    const corpo = novoCadastro({ affiliateCode: afiliado.code, referralCode: code });
    const r = await cadastrar(corpo);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const tenant = await tenantDe(corpo.slug);
    assert.equal(Number(tenant.referred_by_affiliate_id), Number(afiliado.id));
    assert.equal(tenant.referred_by_tenant_id, null);
  });
});

describe('o portal e o console no endereço da plataforma', () => {
  it('o portal responde no ápice e não existe no host de um provedor', async () => {
    const noApice = await callAs(APEX, `${panelUrl}/api/affiliate/overview`);
    assert.equal(noApice.status, 401);
    const noProvedor = await callAs(CASA, `${panelUrl}/api/affiliate/overview`);
    assert.equal(noProvedor.status, 404);
    const loginNoProvedor = await callAs(CASA, `${panelUrl}/api/affiliate/login`, { method: 'POST', body: { email: 'x@y.test', password: 'qualquer-1234' } });
    assert.equal(loginNoProvedor.status, 404);
  });

  it('o console lista o afiliado com o indicado, e o link de cadastro usa o domínio da plataforma', async () => {
    const lista = await noConsole('/api/platform/affiliates');
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    const dela = lista.body.data.affiliates.find((a) => a.id === Number(afiliado.id));
    assert.ok(dela.referredCount >= 2);
    assert.equal(dela.signupUrl, `https://painel.test/signup?aff=${afiliado.code}`);
    const detalhe = await noConsole(`/api/platform/affiliates/${afiliado.id}`);
    assert.equal(detalhe.status, 200);
    assert.ok(detalhe.body.data.referrals.every((r) => r.windowEndsAt));
  });

  it('o login do afiliado no ápice devolve o cookie próprio, e o token dele não abre o console', async () => {
    const { token } = await AffiliateService.issuePasswordLink(afiliado.id);
    const definida = await callAs(APEX, `${panelUrl}/api/affiliate/password`, { method: 'POST', body: { token, password: 'senha-da-joana-1' } });
    assert.equal(definida.status, 200, JSON.stringify(definida.body));
    const login = await callAs(APEX, `${panelUrl}/api/affiliate/login`, { method: 'POST', body: { email: 'joana@divulga.test', password: 'senha-da-joana-1' } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const visao = await callAs(APEX, `${panelUrl}/api/affiliate/overview`, { headers: { Cookie: cookie } });
    assert.equal(visao.status, 200);
    assert.ok(visao.body.data.referrals.length >= 2);
    const valor = cookie.split('=')[1];
    const console = await callAs(APEX, `${panelUrl}/api/platform/affiliates`, { headers: { Authorization: `Bearer ${valor}`, Cookie: cookie } });
    assert.ok([401, 403].includes(console.status), String(console.status));
  });
});
