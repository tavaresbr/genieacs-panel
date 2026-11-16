import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O 2FA de quem opera a plataforma (`PLATFORM_REQUIRE_MFA`).
 *
 * O console cria e suspende provedores, mexe em cobrança e abre personificação
 * em qualquer cliente; até aqui bastava a senha para isso, se a pessoa não
 * tivesse ligado o 2FA por conta própria. O que estes casos defendem: com a
 * chave ligada, a sessão do console sem 2FA só alcança a própria conta até
 * ativar — e entra, não é trancada fora —; ativar a libera na hora; o 2FA não
 * se desliga enquanto a chave estiver ligada; a sessão do painel de um provedor
 * e a personificação seguem as regras delas; e, sem a chave, nada muda (o
 * padrão dos testes, que não são produção).
 *
 * Edição hospedada e sem domínio-base, antes do harness: o console só existe na
 * SaaS, e sem domínio-base ele se pede no login com `destination: 'console'`.
 */
process.env.EDITION = 'saas';
delete process.env.TENANT_BASE_DOMAIN;
delete process.env.PORTAL_BASE_DOMAIN;
delete process.env.PLATFORM_REQUIRE_MFA;

const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { totpCode, totpStep } = await import('../src/utils/totp.js');
const { authLimiter, mfaLimiter } = await import('../src/middleware/rateLimit.js');
const { generateImpersonationToken } = await import('../src/middleware/auth.js');
const { platformRequiresMfa } = await import('../src/config/platformMfa.js');

const DONA = { username: 'dona', password: 'senha-da-dona-1', email: 'dona@exemplo.test' };

let panelUrl;
let alfa;
let segredo;

const get = (path, token) => call(`${panelUrl}${path}`, { headers: authHeaders(token) });
const post = (path, body, token) => call(`${panelUrl}${path}`, { method: 'POST', headers: authHeaders(token), body });
const entrar = (extra = {}) => call(`${panelUrl}/api/auth/login`, {
  method: 'POST',
  body: { username: DONA.username, password: DONA.password, ...extra }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: DONA });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  // Na SaaS a primeira conta entra no cadastro da plataforma; conferido aqui
  // para o resto do arquivo não medir a guarda errada.
  assert.ok(await getDb()('platform_admins').where({ user_id: setup.body.data.user.id }).first());
});

afterEach(async () => {
  delete process.env.PLATFORM_REQUIRE_MFA;
  await authLimiter.resetKey('default|127.0.0.1');
  await authLimiter.resetKey('|127.0.0.1');
});

after(async () => {
  await stopTestServers();
});

describe('a chave', () => {
  it('explícita decide; ausente, só vale em produção', () => {
    assert.equal(platformRequiresMfa({ PLATFORM_REQUIRE_MFA: 'true' }), true);
    assert.equal(platformRequiresMfa({ PLATFORM_REQUIRE_MFA: 'false' }), false);
    // Os testes rodam com APP_ENV=test: ausente é desligado.
    assert.equal(platformRequiresMfa({}), false);
    const antes = process.env.APP_ENV;
    process.env.APP_ENV = 'production';
    try {
      assert.equal(platformRequiresMfa({}), true, 'ligada por padrão em produção');
      assert.equal(platformRequiresMfa({ PLATFORM_REQUIRE_MFA: 'false' }), false, 'e desligável');
    } finally {
      process.env.APP_ENV = antes;
    }
  });
});

describe('sem a chave', () => {
  it('o console entra e opera só com a senha, como antes', async () => {
    const { status, body } = await entrar({ destination: 'console' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.mfaEnrollmentRequired, false);
    const provedores = await get('/api/platform/tenants', body.data.token);
    assert.equal(provedores.status, 200, JSON.stringify(provedores.body));
  });
});

describe('com a chave ligada e sem 2FA', () => {
  it('entra no console, mas só alcança a própria conta', async () => {
    process.env.PLATFORM_REQUIRE_MFA = 'true';
    const { status, body } = await entrar({ destination: 'console' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.mfaEnrollmentRequired, true, 'a tela vai direto para a ativação');
    const token = body.data.token;

    const provedores = await get('/api/platform/tenants', token);
    assert.equal(provedores.status, 403, JSON.stringify(provedores.body));
    assert.equal(provedores.body.code, 'mfa_enrollment_required');

    const eu = await get('/api/auth/user', token);
    assert.equal(eu.status, 200, JSON.stringify(eu.body));
    assert.equal(eu.body.data.mfaEnrollmentRequired, true);
    assert.equal(eu.body.data.platform, true);
  });

  it('a sessão aberta ANTES da chave é parada na requisição seguinte', async () => {
    const { body } = await entrar({ destination: 'console' });
    assert.equal((await get('/api/platform/tenants', body.data.token)).status, 200);
    process.env.PLATFORM_REQUIRE_MFA = 'true';
    const depois = await get('/api/platform/tenants', body.data.token);
    assert.equal(depois.status, 403);
    assert.equal(depois.body.code, 'mfa_enrollment_required');
  });

  it('o painel do provedor da mesma pessoa não é afetado', async () => {
    process.env.PLATFORM_REQUIRE_MFA = 'true';
    const { status, body } = await entrar({ tenantId: alfa });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.mfaEnrollmentRequired, false);
    const equipe = await get('/api/users', body.data.token);
    assert.equal(equipe.status, 200, JSON.stringify(equipe.body));
  });

  it('nem a personificação, que já foi aberta de um console', async () => {
    process.env.PLATFORM_REQUIRE_MFA = 'true';
    const dona = await getDb()('users').where({ username: DONA.username }).first();
    const personificando = generateImpersonationToken(dona, alfa);
    const eu = await get('/api/auth/user', personificando);
    assert.equal(eu.status, 200, JSON.stringify(eu.body));
    assert.equal(eu.body.data.mfaEnrollmentRequired, false);
    assert.equal((await get('/api/users', personificando)).status, 200);
  });

  it('ativar libera o console na hora, com o token que a ativação devolve', async () => {
    process.env.PLATFORM_REQUIRE_MFA = 'true';
    const { body } = await entrar({ destination: 'console' });
    const token = body.data.token;
    const setup = await post('/api/auth/mfa/setup', {}, token);
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    segredo = setup.body.data.secret;
    const ligou = await post('/api/auth/mfa/enable', {
      password: DONA.password, code: totpCode(segredo, totpStep())
    }, token);
    assert.equal(ligou.status, 200, JSON.stringify(ligou.body));

    const provedores = await get('/api/platform/tenants', ligou.body.data.token);
    assert.equal(provedores.status, 200, JSON.stringify(provedores.body));
    const eu = await get('/api/auth/user', ligou.body.data.token);
    assert.equal(eu.body.data.mfaEnrollmentRequired, false);
  });

  it('e o 2FA não se desliga enquanto a chave estiver ligada', async () => {
    process.env.PLATFORM_REQUIRE_MFA = 'true';
    const { status, body } = await entrar({ destination: 'console', totpCode: totpCode(segredo, totpStep() + 1) });
    assert.equal(status, 200, JSON.stringify(body));
    await mfaLimiter.resetKey(`user:${(await getDb()('users').where({ username: DONA.username }).first()).id}`);
    const desligar = await post('/api/auth/mfa/disable', {
      password: DONA.password, code: totpCode(segredo, totpStep() + 2)
    }, body.data.token);
    assert.equal(desligar.status, 409, JSON.stringify(desligar.body));
    assert.equal(desligar.body.code, 'mfa_required_by_platform');
    assert.ok((await getDb()('users').where({ username: DONA.username }).first()).totp_enabled_at);
  });
});
