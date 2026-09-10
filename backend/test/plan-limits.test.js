import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Os tetos do plano, e por onde eles escapariam.
 *
 * O caso que mais importa aqui não é o óbvio (criar o operador N+1 e ser
 * recusado) — é o CONVITE. Conferir o teto só no cadastro direto deixa um
 * administrador emitir vinte links num plano de três: cada aceite, isolado, é o
 * primeiro a passar do teto, e chega quando quem emitiu já saiu da tela. Por
 * isso um convite em aberto conta como vaga prometida, e por isso o teto é
 * conferido de novo no aceite.
 *
 * O outro caso com forma própria é a varredura de contas de assinante. Ela roda
 * sem ninguém olhando, então parar de criar contas em silêncio é o assinante
 * ficar sem portal e ninguém saber por quê — o que ela deixou de criar é
 * registrado e aparece na tela de plano e uso.
 */

process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: TenantSubscription } = await import('../src/models/TenantSubscription.js');
const { default: PlanLimitService } = await import('../src/services/planLimitService.js');
const { default: CustomerService } = await import('../src/services/customerService.js');
const { PLANS, limitsFrom, planFor } = await import('../src/config/plans.js');

let panelUrl;
let token;
let tenantId;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dona', password: 'senha-da-dona-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  await stopTestServers();
});

const comoDona = () => authHeaders(token);

/** Põe este provedor num plano, com exceções opcionais. */
async function plano(code, { maxOperators = null, maxSubscriberAccounts = null } = {}) {
  if (!await TenantSubscription.findByTenantId(tenantId)) {
    await TenantSubscription.createFor(tenantId, { status: 'active' });
  }
  await getDb()('tenant_subscriptions').where({ tenant_id: tenantId }).update({
    status: 'active',
    plan_code: code,
    max_operators: maxOperators,
    max_subscriber_accounts: maxSubscriberAccounts
  });
}

const criarOperador = (nome) => call(`${panelUrl}/api/users`, {
  method: 'POST',
  headers: comoDona(),
  body: { username: nome, password: 'senha-do-operador-1', role: 'tech', email: `${nome}@exemplo.test` }
});

const criarConvite = () => call(`${panelUrl}/api/invites`, {
  method: 'POST', headers: comoDona(), body: { role: 'tech' }
});

beforeEach(async () => {
  // Volta ao estado limpo: uma pessoa (a dona), nenhum convite.
  await getDb()('tenant_invites').where({ tenant_id: tenantId }).delete();
  const dona = await getDb()('tenant_users').where({ tenant_id: tenantId })
    .orderBy('id', 'asc').first();
  await getDb()('tenant_users')
    .where({ tenant_id: tenantId }).whereNot({ id: dona.id }).delete();
  await getDb()('customer_accounts').where({ tenant_id: tenantId }).delete();
  await runInTenant(tenantId, () => PlanLimitService.recordSubscriberAccountsSkipped(0));
});

describe('o teto de operadores', () => {
  it('deixa cadastrar até o limite', async () => {
    await plano('unlimited', { maxOperators: 3 });
    assert.equal((await criarOperador('tecnico-a')).status, 201);
    assert.equal((await criarOperador('tecnico-b')).status, 201);
  });

  it('e recusa o seguinte, com um código estável', async () => {
    await plano('unlimited', { maxOperators: 2 });
    assert.equal((await criarOperador('tecnico-c')).status, 201);
    const recusado = await criarOperador('tecnico-d');
    assert.equal(recusado.status, 402);
    assert.equal(recusado.body.code, 'plan_limit_operators');
  });

  it('não deixa a pessoa recusada existir sem vínculo nenhum', async () => {
    // A conferência tem de vir ANTES de `User.create`, senão o nome de usuário
    // fica tomado no deploy inteiro por uma pessoa que não entrou em lugar
    // nenhum — e ninguém consegue reusar aquele nome depois.
    await plano('unlimited', { maxOperators: 1 });
    const recusado = await criarOperador('fantasma');
    assert.equal(recusado.status, 402);
    const orfa = await getDb()('users').where({ username: 'fantasma' }).first();
    assert.equal(orfa, undefined, 'a conta não podia ter sido criada');
  });

  it('ilimitado não recusa nada', async () => {
    await plano('unlimited');
    assert.equal((await criarOperador('tecnico-e')).status, 201);
    assert.equal((await criarOperador('tecnico-f')).status, 201);
    assert.equal((await criarOperador('tecnico-g')).status, 201);
  });
});

describe('o convite, que é por onde o teto escaparia', () => {
  it('um convite em aberto ocupa vaga', async () => {
    // Sem isto, vinte convites num plano de três só apareceriam como problema
    // quando as pessoas clicassem — uma a uma, longe de quem emitiu.
    await plano('unlimited', { maxOperators: 2 });
    assert.equal((await criarConvite()).status, 201);
    const segundo = await criarConvite();
    assert.equal(segundo.status, 402);
    assert.equal(segundo.body.code, 'plan_limit_operators');
  });

  it('e um convite emitido no limite ainda pode ser aceito', async () => {
    // O par que dá sentido ao caso acima: se o aceite somasse o próprio convite
    // de novo, o último convite de todo provedor no teto seria recusado — o
    // único que precisava passar.
    await plano('unlimited', { maxOperators: 2 });
    const { body } = await criarConvite();
    const aceite = await call(`${panelUrl}/api/invites/token/${body.data.token}/accept`, {
      method: 'POST',
      body: { username: 'convidada', password: 'senha-da-convidada-1', email: 'convidada@exemplo.test' }
    });
    assert.equal(aceite.status, 201, JSON.stringify(aceite.body));
  });

  it('mas um convite antigo é recusado se as vagas encheram no meio', async () => {
    await plano('unlimited', { maxOperators: 3 });
    const { body } = await criarConvite();
    // Alguém entrou por outro caminho enquanto o link estava no e-mail.
    assert.equal((await criarOperador('chegou-antes')).status, 201);
    await plano('unlimited', { maxOperators: 2 });
    const aceite = await call(`${panelUrl}/api/invites/token/${body.data.token}/accept`, {
      method: 'POST',
      body: { username: 'atrasada', password: 'senha-da-atrasada-1', email: 'atrasada@exemplo.test' }
    });
    assert.equal(aceite.status, 402);
  });
});

describe('as contas de assinante', () => {
  const device = (i) => ({
    _id: `ont-${i}`, softwareId: 'V1.0.0', pppoe: `assinante-${i}@provedor`
  });

  it('a varredura para no teto em vez de criar sem fim', async () => {
    await plano('unlimited', { maxSubscriberAccounts: 2 });
    await runInTenant(tenantId, () => CustomerService.syncDevices(
      [device(1), device(2), device(3), device(4)], { enabled: true }
    ));
    const ativas = await runInTenant(tenantId, () => PlanLimitService.subscriberAccountCount());
    assert.equal(ativas, 2);
  });

  it('e registra o que deixou de criar, porque ninguém está olhando', async () => {
    await plano('unlimited', { maxSubscriberAccounts: 1 });
    await runInTenant(tenantId, () => CustomerService.syncDevices(
      [device(5), device(6), device(7)], { enabled: true }
    ));
    const barrados = await runInTenant(tenantId, () => PlanLimitService.subscriberAccountsSkipped());
    assert.equal(barrados, 2, 'o número precisa chegar à tela de plano e uso');
  });

  it('uma ONT que troca de titular passa mesmo no teto', async () => {
    // O saldo de contas ATIVAS é zero: aposenta uma, cria outra. Barrar essa
    // deixaria o assinante novo sem portal enquanto a linha do antigo, que já
    // não vale, continuaria ocupando a vaga.
    await plano('unlimited', { maxSubscriberAccounts: 1 });
    await runInTenant(tenantId, () => CustomerService.syncDevices([device(8)], { enabled: true }));
    const antes = await getDb()('customer_accounts')
      .where({ tenant_id: tenantId, active: true }).first();

    await runInTenant(tenantId, () => CustomerService.syncDevices(
      [{ _id: 'ont-8', softwareId: 'V1.0.0', pppoe: 'outro-titular@provedor' }], { enabled: true }
    ));
    const depois = await getDb()('customer_accounts')
      .where({ tenant_id: tenantId, active: true }).first();
    assert.ok(depois, 'o novo titular tinha de ter conta');
    assert.notEqual(depois.customer_id, antes.customer_id, 'era para ser outra conta');
    const ativas = await runInTenant(tenantId, () => PlanLimitService.subscriberAccountCount());
    assert.equal(ativas, 1, 'o saldo de ativas continua um');

    // E a metade que faz a contagem ser de ATIVAS e não de linhas: a conta
    // aposentada continua na tabela, como histórico. Contando linhas, o
    // provedor "cresceria" a cada troca de titular sem nunca ter ganhado um
    // assinante — e encostaria no teto sem ter vendido nada.
    const linhas = await getDb()('customer_accounts').where({ tenant_id: tenantId });
    assert.equal(linhas.length, 2, 'a linha aposentada tinha de continuar lá');
  });
});

describe('a rota de plano e uso', () => {
  it('responde o plano, o usado e o teto', async () => {
    await plano('starter');
    const { status, body } = await call(`${panelUrl}/api/tenant/usage`, { headers: comoDona() });
    assert.equal(status, 200);
    assert.equal(body.data.usage.plan, 'starter');
    assert.equal(body.data.usage.operators.limit, PLANS.starter.maxOperators);
    assert.ok(body.data.usage.operators.used >= 1);
  });

  it('e não responde a quem não tem sessão', async () => {
    // Quantos operadores um ISP tem é assunto de dentro da casa — a `/public`
    // existe porque a tela de login precisa do nome antes de haver quem
    // autenticar, e esta não tem essa desculpa.
    const { status } = await call(`${panelUrl}/api/tenant/usage`);
    assert.equal(status, 401);
  });
});

describe('o catálogo', () => {
  it('um plano que ninguém reconhece é ilimitado, e não o menor', async () => {
    // Mesmo motivo pelo qual a ausência de assinatura libera: um dado estranho
    // no banco não pode virar um bloqueio comercial que ninguém contratou.
    assert.equal(planFor('plano-que-nao-existe').code, 'unlimited');
    assert.equal(limitsFrom({ plan_code: 'plano-que-nao-existe' }).maxOperators, null);
  });

  it('a exceção negociada sobrescreve o plano, inclusive para baixo', () => {
    assert.equal(limitsFrom({ plan_code: 'pro', max_operators: 40 }).maxOperators, 40);
    assert.equal(limitsFrom({ plan_code: 'pro', max_operators: 2 }).maxOperators, 2);
    assert.equal(limitsFrom({ plan_code: 'pro' }).maxOperators, PLANS.pro.maxOperators);
  });

  it('não há teto de ONTs, e a ausência é a decisão', () => {
    // Não existe ponto de escrita para uma ONT: quando a contagem passa, o
    // equipamento já informou ao ACS do provedor. Fingir que é limite levaria a
    // esconder a rede do próprio dono. É medição, e a cobrança é o caminho.
    for (const plano of Object.values(PLANS)) {
      assert.equal(plano.maxDevices, undefined, `${plano.code} não pode ter teto de ONTs`);
    }
  });
});
