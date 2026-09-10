import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O extrato comercial, e a coluna que precisa existir antes de ser usada.
 *
 * O que este arquivo persegue com mais insistência é a IDEMPOTÊNCIA. Hoje quem
 * marca pago somos nós, pelo console, e uma reentrega é improvável. Quando
 * entrar um gateway ela deixa de ser improvável e passa a ser a regra: todo
 * gateway reentrega webhook. Sem `external_id`, cada reentrega empurraria o
 * período pago mais trinta dias — e acrescentar idempotência depois que o
 * dinheiro já está passando significa reconciliar à mão, com o cliente do
 * outro lado da linha.
 *
 * O segundo caso que vale por si é a ORDEM: o fato é escrito antes de a
 * assinatura se mover. Uma assinatura ativa sem o pagamento que a ativou é um
 * cliente que ninguém sabe por que está em dia — e, no fechamento do mês,
 * dinheiro que não existe.
 */

process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: TenantSubscription } = await import('../src/models/TenantSubscription.js');
const { default: TenantBillingEvent } = await import('../src/models/TenantBillingEvent.js');
const { ManualBillingProvider } = await import('../src/services/subscriptionBillingService.js');

const DONO = { username: 'dono', password: 'senha-do-dono-123', email: 'dono@exemplo.test' };

let panelUrl;
let token;
let alfa;
let beta;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: DONO });
  token = setup.body.data.token;
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  if (!(await getDb()('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  beta = await insertReturningId('tenants', {
    slug: 'vizinho-cobranca', name: 'Vizinho', status: 'active'
  });
  await TenantSubscription.createFor(beta, { status: 'active' });
});

after(async () => {
  await stopTestServers();
});

const comoPlataforma = () => authHeaders(token);

const marcarPago = (tenantId, body) => call(
  `${panelUrl}/api/platform/tenants/${tenantId}/billing`,
  { method: 'POST', headers: comoPlataforma(), body }
);

const extrato = (tenantId) => call(
  `${panelUrl}/api/platform/tenants/${tenantId}/billing`,
  { headers: comoPlataforma() }
);

beforeEach(async () => {
  await getDb()('tenant_billing_events').delete();
  await getDb()('tenant_subscriptions').where({ tenant_id: alfa }).delete();
  await TenantSubscription.createFor(alfa, { status: 'past_due' });
});

describe('a reentrega, que é a regra e não a exceção', () => {
  it('o mesmo id de evento não é aplicado duas vezes', async () => {
    const corpo = { amountCents: 19900, externalId: 'evt_do_gateway_1' };
    const primeira = await marcarPago(alfa, corpo);
    assert.equal(primeira.status, 201);
    assert.equal(primeira.body.data.duplicate, false);

    const segunda = await marcarPago(alfa, corpo);
    // 200 e não erro: o gateway que reenviou não fez nada de errado, e um erro
    // faria ele tentar de novo, para sempre.
    assert.equal(segunda.status, 200);
    assert.equal(segunda.body.data.duplicate, true);

    const linhas = await getDb()('tenant_billing_events').where({ tenant_id: alfa, kind: 'payment' });
    assert.equal(linhas.length, 1, 'a reentrega escreveu um segundo pagamento');
  });

  it('e não empurra o período pago mais uma vez', async () => {
    // A consequência que a contagem de linhas acima não pega: mesmo com uma
    // linha só, aplicar de novo moveria a assinatura.
    const corpo = { amountCents: 19900, externalId: 'evt_do_gateway_2' };
    await marcarPago(alfa, corpo);
    const depoisDaPrimeira = await TenantSubscription.findByTenantId(alfa);
    await marcarPago(alfa, corpo);
    const depoisDaSegunda = await TenantSubscription.findByTenantId(alfa);
    assert.equal(
      new Date(depoisDaSegunda.current_period_end).getTime(),
      new Date(depoisDaPrimeira.current_period_end).getTime(),
      'a reentrega deu trinta dias de graça'
    );
  });

  it('mas duas marcas SEM id de evento são dois pagamentos', async () => {
    // O par que dá sentido aos dois acima: nulos não colidem no índice único, e
    // é isso que deixa a marca manual conviver com a idempotência do gateway.
    // Se colidissem, o segundo pagamento manual de um cliente seria recusado.
    await marcarPago(alfa, { amountCents: 100 });
    await marcarPago(alfa, { amountCents: 100 });
    const linhas = await getDb()('tenant_billing_events').where({ tenant_id: alfa, kind: 'payment' });
    assert.equal(linhas.length, 2);
  });
});

describe('o pagamento move a assinatura', () => {
  it('põe em dia quem estava atrasado', async () => {
    const { status } = await marcarPago(alfa, { amountCents: 19900 });
    assert.equal(status, 201);
    const assinatura = await TenantSubscription.findByTenantId(alfa);
    assert.equal(assinatura.status, 'active');
    assert.ok(new Date(assinatura.current_period_end) > new Date());
  });

  it('pagar adiantado soma ao que já estava pago, em vez de recomeçar', async () => {
    // Recomeçar a contagem de hoje cobra o cliente pelo tempo que ele já tinha
    // comprado — o erro silencioso de quem paga antes do vencimento.
    await marcarPago(alfa, { amountCents: 19900 });
    const primeiro = new Date((await TenantSubscription.findByTenantId(alfa)).current_period_end);
    await marcarPago(alfa, { amountCents: 19900 });
    const segundo = new Date((await TenantSubscription.findByTenantId(alfa)).current_period_end);
    const dias = (segundo - primeiro) / (24 * 3600_000);
    assert.ok(dias > 29 && dias < 31, `o segundo período somou ${dias} dias`);
  });

  it('e o fato é escrito ANTES de a assinatura se mover', async () => {
    // Com o livro fora do ar, a assinatura não pode andar: uma assinatura ativa
    // sem o pagamento que a ativou é dinheiro que não existe na conciliação.
    const original = TenantBillingEvent.record;
    TenantBillingEvent.record = async () => { throw new Error('livro fora do ar'); };
    try {
      await assert.rejects(() => ManualBillingProvider.applyPayment({
        tenantId: alfa, amountCents: 100
      }));
      const assinatura = await TenantSubscription.findByTenantId(alfa);
      assert.equal(assinatura.status, 'past_due', 'a assinatura andou sem o fato registrado');
    } finally {
      TenantBillingEvent.record = original;
    }
  });
});

describe('o extrato conta a história inteira', () => {
  it('a mudança de estado entra junto com os pagamentos', async () => {
    // Só os pagamentos não explicam nada: a história é pagou, atrasou,
    // suspendemos, pagou.
    await call(`${panelUrl}/api/platform/tenants/${alfa}/subscription`, {
      method: 'PATCH', headers: comoPlataforma(), body: { status: 'suspended', reason: 'sem pagar' }
    });
    await marcarPago(alfa, { amountCents: 19900 });

    const { status, body } = await extrato(alfa);
    assert.equal(status, 200);
    const tipos = body.data.events.map((e) => e.kind);
    assert.ok(tipos.includes('status_change'), 'faltou a mudança de estado');
    assert.ok(tipos.includes('payment'), 'faltou o pagamento');
  });

  it('e vem do mais recente para o mais antigo', async () => {
    await marcarPago(alfa, { amountCents: 100, externalId: 'evt_a' });
    await marcarPago(alfa, { amountCents: 200, externalId: 'evt_b' });
    const { body } = await extrato(alfa);
    const instantes = body.data.events.map((e) => new Date(e.occurredAt).getTime());
    const ordenado = [...instantes].sort((a, b) => b - a);
    assert.deepEqual(instantes, ordenado);
  });
});

describe('o extrato é de cada provedor', () => {
  it('o pagamento de um não aparece no do vizinho', async () => {
    await marcarPago(alfa, { amountCents: 19900, externalId: 'evt_do_alfa' });
    const { body } = await extrato(beta);
    const ids = body.data.events.map((e) => e.externalId);
    assert.ok(!ids.includes('evt_do_alfa'), 'o extrato do alfa vazou para o beta');
  });

  it('e a leitura escopada do beta enxerga só o dele', async () => {
    await marcarPago(alfa, { amountCents: 100, externalId: 'evt_so_do_alfa' });
    await marcarPago(beta, { amountCents: 200, externalId: 'evt_so_do_beta' });
    const doBeta = await runInTenant(beta, () => TenantBillingEvent.list());
    assert.ok(doBeta.length >= 1);
    for (const linha of doBeta) {
      assert.equal(Number(linha.tenant_id), Number(beta), 'linha de outro provedor no extrato');
    }
  });
});

describe('o que a rota recusa', () => {
  it('um valor negativo, porque estorno é outro fato', async () => {
    // Aceitar pagamento com sinal trocado faria a soma do extrato mentir.
    const { status } = await marcarPago(alfa, { amountCents: -100 });
    assert.equal(status, 400);
  });

  it('mas aceita zero, que é cortesia e é legítimo', async () => {
    const { status } = await marcarPago(alfa, { amountCents: 0 });
    assert.equal(status, 201);
  });

  it('e um provedor sem assinatura, porque não há o que pôr em dia', async () => {
    await getDb()('tenant_subscriptions').where({ tenant_id: alfa }).delete();
    const { status } = await marcarPago(alfa, { amountCents: 100 });
    assert.equal(status, 404);
  });

  it('e quem não é da plataforma não alcança o extrato', async () => {
    const { status } = await call(`${panelUrl}/api/platform/tenants/${alfa}/billing`);
    assert.equal(status, 401);
  });
});
