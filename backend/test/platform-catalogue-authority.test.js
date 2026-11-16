import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Quem escreve no catálogo padrão — o da caixa da plataforma, na SaaS.
 *
 * O catálogo da caixa é o que o provedor novo herda, o que o "restaurar
 * padrão" de cada provedor devolve e o que o console propaga. `catalogue.write`
 * é de qualquer `admin` da equipe da caixa, e com ela um membro da equipe que
 * não está no cadastro da plataforma plantava um `wifi_password_path` que todo
 * cliente pegaria depois. Escrever ali pede o cadastro; ler continua como
 * estava; e o catálogo de um provedor comum segue sendo só dele.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, insertReturningId, runInTenant,
  startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: User } = await import('../src/models/User.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { generateImpersonationToken } = await import('../src/middleware/auth.js');
const { authLimiter } = await import('../src/middleware/rateLimit.js');

const DONA = { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' };
const PATH_ORIGINAL = 'WLANConfiguration.1.KeyPassphrase';

let panelUrl;
let alfa;
let caixa;
let donaId;
let tokenDona;
let tokenMembro;
let tokenDaAlfa;
let vendorId;
let wifiId;

const api = (token, path, options = {}) => call(`${panelUrl}/api/vendor-management${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

const corpoVendor = (name, path = PATH_ORIGINAL) => ({
  name,
  manufacturer_patterns: ['acme'],
  product_patterns: [name],
  wifi_password_path: path,
  priority: 10,
  enabled: true
});

async function entrar(username, password, tenantId) {
  await authLimiter.resetKey(`default|127.0.0.1`);
  const { status, body } = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username, password, ...(tenantId ? { tenantId } : {}) }
  });
  assert.equal(status, 200, JSON.stringify(body));
  return body.data.token;
}

async function pessoa(username, password, tenantId) {
  const bcrypt = (await import('bcryptjs')).default;
  const id = await runInTenant(tenantId, () => User.create({
    username, password: bcrypt.hashSync(password, 10), role: 'admin', email: `${username}@exemplo.test`
  }));
  await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId: id, role: 'admin' }));
  return id;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();

  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: DONA });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  donaId = setup.body.data.user.id;
  if (!(await getDb()('platform_admins').where({ user_id: donaId }).first())) {
    await getDb()('platform_admins').insert({ user_id: donaId });
  }

  caixa = await Tenant.create({ slug: 'plataforma', name: 'Plataforma', kind: 'platform' });
  // A caixa precisa de assinatura para a rota responder alguma coisa além do
  // 402 do portão; a do provedor da instalação serve de molde.
  const molde = await getDb()('subscriptions').where({ tenant_id: alfa }).first();
  if (!(await getDb()('subscriptions').where({ tenant_id: caixa }).first())) {
    await runInTenant(caixa, () => Subscription.createCurrent({ plan_id: molde.plan_id, status: 'active' }));
    SubscriptionService.invalidate(caixa);
  }

  await getDb()('vendors').where({ tenant_id: caixa }).del();
  await getDb()('wifi_security_config').where({ tenant_id: caixa }).del();
  vendorId = await insertReturningId('vendors', {
    ...corpoVendor('Padrao'),
    manufacturer_patterns: JSON.stringify(['acme']),
    product_patterns: JSON.stringify(['Padrao']),
    tenant_id: caixa
  });
  wifiId = await insertReturningId('wifi_security_config', {
    product_class: 'PADRAO-1',
    security_types: JSON.stringify(['WPA2']),
    password_param_path: PATH_ORIGINAL,
    tenant_id: caixa
  });

  // A dona também trabalha na caixa: é pela sessão do painel DELA ali que o
  // catálogo padrão se edita.
  await runInTenant(caixa, () => TenantUser.create({ tenantId: caixa, userId: donaId, role: 'admin' }));
  tokenDona = await entrar(DONA.username, DONA.password, caixa);

  await pessoa('admin-da-caixa', 'senha-da-caixa-1', caixa);
  tokenMembro = await entrar('admin-da-caixa', 'senha-da-caixa-1');

  await pessoa('admin-da-alfa', 'senha-da-alfa-1', alfa);
  tokenDaAlfa = await entrar('admin-da-alfa', 'senha-da-alfa-1');
});

after(async () => {
  await stopTestServers();
});

const escritas = () => [
  ['POST', '', corpoVendor('Plantado', 'Atacante.Path')],
  ['PUT', `/${vendorId}`, corpoVendor('Padrao', 'Atacante.Path')],
  ['POST', `/${vendorId}/reset`, undefined],
  ['DELETE', `/${vendorId}`, undefined],
  ['POST', '/wifi-security-configs', {
    product_class: 'PLANTADO-1', security_types: ['WPA2'], password_param_path: 'Atacante.Path'
  }],
  ['PUT', `/wifi-security-configs/${wifiId}`, {
    product_class: 'PADRAO-1', security_types: ['WPA2'], password_param_path: 'Atacante.Path'
  }],
  ['POST', `/wifi-security-configs/${wifiId}/reset`, undefined],
  ['DELETE', `/wifi-security-configs/${wifiId}`, undefined]
];

describe('o catálogo da caixa, por quem administra a equipe dela sem ser da plataforma', () => {
  it('não escreve em nenhuma das rotas, e nada muda', async () => {
    const antes = {
      vendors: await getDb()('vendors').where({ tenant_id: caixa }).orderBy('id'),
      wifi: await getDb()('wifi_security_config').where({ tenant_id: caixa }).orderBy('id')
    };
    for (const [method, path, body] of escritas()) {
      const resposta = await api(tokenMembro, path, { method, body });
      assert.equal(resposta.status, 403, `${method} ${path}: ${JSON.stringify(resposta.body)}`);
      assert.equal(resposta.body.code, 'platform_admin_only', `${method} ${path}`);
    }
    assert.deepEqual(await getDb()('vendors').where({ tenant_id: caixa }).orderBy('id'), antes.vendors);
    assert.deepEqual(await getDb()('wifi_security_config').where({ tenant_id: caixa }).orderBy('id'), antes.wifi);
  });

  it('mas lê, como antes', async () => {
    for (const path of ['', `/${vendorId}`, '/wifi-security-configs', `/wifi-security-configs/${wifiId}`]) {
      const resposta = await api(tokenMembro, path);
      assert.equal(resposta.status, 200, `${path}: ${JSON.stringify(resposta.body)}`);
    }
  });

  it('e a personificação da caixa também não escreve', async () => {
    const dona = await getDb()('users').where({ id: donaId }).first();
    const personificando = generateImpersonationToken(dona, caixa);
    const resposta = await api(personificando, `/${vendorId}`, {
      method: 'PUT', body: corpoVendor('Padrao', 'Atacante.Path')
    });
    assert.equal(resposta.status, 403, JSON.stringify(resposta.body));
    const linha = await getDb()('vendors').where({ id: vendorId }).first();
    assert.equal(linha.wifi_password_path, PATH_ORIGINAL);
  });
});

describe('o catálogo da caixa, por quem está no cadastro da plataforma', () => {
  it('escreve', async () => {
    const atualizado = await api(tokenDona, `/${vendorId}`, {
      method: 'PUT', body: corpoVendor('Padrao', 'WLANConfiguration.1.PreSharedKey.1.KeyPassphrase')
    });
    assert.equal(atualizado.status, 200, JSON.stringify(atualizado.body));
    const linha = await getDb()('vendors').where({ id: vendorId }).first();
    assert.equal(linha.wifi_password_path, 'WLANConfiguration.1.PreSharedKey.1.KeyPassphrase');

    const criado = await api(tokenDona, '/wifi-security-configs', {
      method: 'POST',
      body: { product_class: 'NOVO-1', security_types: ['WPA2'], password_param_path: PATH_ORIGINAL }
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
  });

  it('e o membro que entra no cadastro passa a escrever, na requisição seguinte', async () => {
    const membro = await getDb()('users').where({ username: 'admin-da-caixa' }).first();
    await getDb()('platform_admins').insert({ user_id: membro.id });
    try {
      const resposta = await api(tokenMembro, `/wifi-security-configs/${wifiId}`, {
        method: 'PUT',
        body: { product_class: 'PADRAO-1', security_types: ['WPA2'], password_param_path: PATH_ORIGINAL }
      });
      assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    } finally {
      await getDb()('platform_admins').where({ user_id: membro.id }).del();
    }
  });
});

describe('o catálogo de um provedor comum', () => {
  it('segue sendo de quem tem `catalogue.write` lá', async () => {
    const criado = await api(tokenDaAlfa, '', { method: 'POST', body: corpoVendor('DaAlfa') });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    const id = criado.body.data.id;
    const atualizado = await api(tokenDaAlfa, `/${id}`, {
      method: 'PUT', body: corpoVendor('DaAlfa', 'Outro.Path')
    });
    assert.equal(atualizado.status, 200, JSON.stringify(atualizado.body));
    assert.equal((await api(tokenDaAlfa, `/${id}`, { method: 'DELETE' })).status, 200);
  });
});
