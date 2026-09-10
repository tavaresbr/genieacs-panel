import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O portão comercial: o que a assinatura de cada provedor deixa passar.
 *
 * O caso que este arquivo persegue com mais insistência não é nenhum dos
 * estados — é a ORDEM. Um portão montado em `app.use`, acima das rotas,
 * responde antes do 401, e aí um request sem token nenhum devolve 402 num
 * provedor inadimplente e 401 num provedor em dia: qualquer estranho passa a
 * poder varrer hosts perguntando quais ISPs estão atrasados na fatura. É a
 * mesma regra que `tenantController.getPublicProfile` já escrevia — não
 * distinguir "não existe" de "existe e está suspenso" — e o portão no lugar
 * errado a violaria de outro arquivo.
 *
 * O outro caso que vale por si é comercial e não técnico: em `past_due` o
 * PORTAL DO ASSINANTE continua de pé. Quem deve é o provedor; quem usa o portal
 * é o cliente final dele, que não deve nada e não tem como resolver.
 */

process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: TenantSubscription } = await import('../src/models/TenantSubscription.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);
const { SUBSCRIPTION_CODES } = await import('../src/config/subscription.js');

let panelUrl;
let portalUrl;
let token;
let tenantId;
const assinante = { customerId: 'CSG-QRSTUVW-991122', password: null, id: null };

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operador', password: 'senha-do-operador-1', email: 'operador@exemplo.test' }
  });
  token = setup.body.data.token;
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;

  const { password, record } = await CustomerPortalPasswordService.createRecord();
  assinante.password = password;
  assinante.id = await insertReturningId('customer_accounts', {
    customer_id: assinante.customerId,
    device_id: 'device-da-assinatura',
    identity_hash: 'hash-assinatura'.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: 'assinante-portao',
    active: true,
    ...record
  });
});

after(async () => {
  await stopTestServers();
});

const comoOperador = () => authHeaders(token);

/** Põe a assinatura deste provedor num estado, criando a linha se faltar. */
async function estado(status) {
  const existe = await TenantSubscription.findByTenantId(tenantId);
  if (!existe) await TenantSubscription.createFor(tenantId, { status });
  else await TenantSubscription.setStatus(tenantId, status, { reason: 'teste' });
}

const semAssinatura = () => getDb()('tenant_subscriptions')
  .where({ tenant_id: tenantId }).delete();

/** Uma sessão do portal, em cookie. */
async function sessaoDoPortal() {
  const resposta = await call(`${portalUrl}/api/customer/login`, {
    method: 'POST',
    body: { customerId: assinante.customerId, password: assinante.password }
  });
  const cookie = resposta.response.headers.getSetCookie()
    .find((c) => c.startsWith('skygp_portal_session='));
  return cookie ? cookie.split(';')[0] : null;
}

beforeEach(async () => {
  await semAssinatura();
});

describe('a ordem: 401 antes de 402', () => {
  it('sem token, um provedor suspenso responde igual a um em dia', async () => {
    // O caso que decide onde o portão pode morar. Se as duas respostas
    // divergirem, a fatura em atraso de um ISP virou fato consultável por
    // qualquer um que alcance o host.
    await estado('active');
    const emDia = await call(`${panelUrl}/api/devices`);
    await estado('suspended');
    const suspenso = await call(`${panelUrl}/api/devices`);
    assert.equal(emDia.status, 401);
    assert.equal(suspenso.status, emDia.status,
      `em dia respondeu ${emDia.status} e suspenso ${suspenso.status}`);
  });

  it('e um token inválido também responde igual', async () => {
    // O par do caso acima: um sondador não precisa de token VÁLIDO, só de algo
    // com formato de token, então a resposta a um token qualquer também não
    // pode variar com a fatura.
    const forjado = { Authorization: 'Bearer nao-e-um-token' };
    await estado('active');
    const emDia = await call(`${panelUrl}/api/devices`, { headers: forjado });
    await estado('suspended');
    const suspenso = await call(`${panelUrl}/api/devices`, { headers: forjado });
    assert.equal(emDia.status, suspenso.status,
      `em dia respondeu ${emDia.status} e suspenso ${suspenso.status}`);
  });
});

describe('o painel, por estado', () => {
  for (const status of ['trial', 'active']) {
    it(`${status} lê e escreve`, async () => {
      await estado(status);
      const leitura = await call(`${panelUrl}/api/map-settings`, { headers: comoOperador() });
      assert.notEqual(leitura.status, 402);
      const escrita = await call(`${panelUrl}/api/map-settings`, {
        method: 'PUT', headers: comoOperador(), body: { centerLat: -23.5, centerLng: -46.6, zoom: 12 }
      });
      assert.notEqual(escrita.status, 402, `escrita respondeu ${escrita.status}`);
    });
  }

  it('past_due lê', async () => {
    await estado('past_due');
    const { status } = await call(`${panelUrl}/api/map-settings`, { headers: comoOperador() });
    assert.notEqual(status, 402);
  });

  it('past_due NÃO escreve, e diz por quê num código estável', async () => {
    await estado('past_due');
    const resposta = await call(`${panelUrl}/api/map-settings`, {
      method: 'PUT', headers: comoOperador(), body: { centerLat: -23.5, centerLng: -46.6, zoom: 12 }
    });
    assert.equal(resposta.status, 402);
    assert.equal(resposta.body.code, SUBSCRIPTION_CODES.READ_ONLY);
    assert.equal(resposta.body.subscriptionStatus, 'past_due');
  });

  for (const status of ['suspended', 'canceled']) {
    it(`${status} não lê nem escreve`, async () => {
      await estado(status);
      const leitura = await call(`${panelUrl}/api/map-settings`, { headers: comoOperador() });
      assert.equal(leitura.status, 402);
      assert.equal(leitura.body.code, SUBSCRIPTION_CODES.BLOCKED);
    });
  }
});

describe('o portal do assinante', () => {
  it('continua de pé em past_due — a regra comercial desta fase', async () => {
    // Quem está devendo é o provedor. Quem usa isto é o cliente final dele, que
    // não deve nada e não tem como resolver.
    await estado('past_due');
    const cookie = await sessaoDoPortal();
    assert.ok(cookie, 'o assinante tinha de conseguir entrar');
    const { status } = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: cookie }
    });
    assert.notEqual(status, 402, 'o portal não pode cair por atraso de fatura do provedor');
  });

  it('e cai em suspended, quando o contrato acabou de fato', async () => {
    // O par que dá sentido ao caso acima: sem ele, um portal que nunca fecha
    // passaria lá.
    await estado('active');
    const cookie = await sessaoDoPortal();
    await estado('suspended');
    const { status, body } = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: cookie }
    });
    assert.equal(status, 402);
    assert.equal(body.code, SUBSCRIPTION_CODES.BLOCKED);
  });
});

describe('o que o portão nunca fecha', () => {
  it('a exportação do próprio cadastro, mesmo cancelado', async () => {
    // Recusar a um cliente cancelado o cadastro dele é reter dado de terceiro
    // como alavanca de cobrança. Corta-se o serviço; o que ele cadastrou
    // continua sendo dele.
    await estado('canceled');
    const { status } = await call(`${panelUrl}/api/tenant/export`, { headers: comoOperador() });
    assert.notEqual(status, 402, 'a portabilidade não pode depender da fatura');
  });

  it('e o login, que é por onde se descobre o bloqueio', async () => {
    await estado('suspended');
    const { status } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador', password: 'senha-do-operador-1' }
    });
    assert.equal(status, 200, 'bloquear o login é esconder a cobrança de quem ia pagá-la');
  });
});

describe('a ausência de linha libera', () => {
  it('um provedor sem assinatura trabalha normalmente', async () => {
    // A escolha está escrita no middleware: fechar por engano trava um cliente
    // que pagou; abrir por engano custa dinheiro, que é recuperável.
    await semAssinatura();
    const { status } = await call(`${panelUrl}/api/map-settings`, {
      method: 'PUT', headers: comoOperador(), body: { centerLat: -23.5, centerLng: -46.6, zoom: 12 }
    });
    assert.notEqual(status, 402);
  });

  it('e um estado que ninguém reconhece também', async () => {
    await estado('active');
    await getDb()('tenant_subscriptions')
      .where({ tenant_id: tenantId }).update({ status: 'inventado' });
    const { status } = await call(`${panelUrl}/api/map-settings`, { headers: comoOperador() });
    assert.notEqual(status, 402);
  });
});

describe('a assinatura é de cada provedor', () => {
  it('a suspensão de um vizinho não fecha o painel deste', async () => {
    const beta = await insertReturningId('tenants', {
      slug: 'vizinho-da-fatura', name: 'Vizinho', status: 'active'
    });
    await TenantSubscription.createFor(beta, { status: 'suspended' });
    await estado('active');
    const { status } = await call(`${panelUrl}/api/map-settings`, { headers: comoOperador() });
    assert.notEqual(status, 402);

    // E a direção que a checagem acima NÃO cobre. Uma leitura sem escopo
    // devolve a primeira linha da tabela, que é a do alfa — então o caso de
    // cima passaria mesmo com o filtro de provedor removido. Perguntando de
    // dentro do beta, a resposta certa é a do beta.
    const doBeta = await runInTenant(beta, () => TenantSubscription.current());
    assert.equal(doBeta?.status, 'suspended');
    assert.equal(Number(doBeta?.tenant_id), Number(beta));
  });
});
