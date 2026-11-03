import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: AsaasProviderService } = await import('../src/services/asaasProviderService.js');
const { default: AsaasCustomer } = await import('../src/models/AsaasCustomer.js');
const { default: AsaasCharge } = await import('../src/models/AsaasCharge.js');
const { runInTenant } = await import('../src/config/tenantContext.js');

/**
 * A entrega do webhook da conta Asaas do provedor. O que importa provar:
 * o provedor sai do TOKEN (e nunca vaza para outro), as respostas não dizem
 * mais do que devem, e uma entrega atrasada não reabre o que já foi pago.
 */
const CHAVE = '$aact_hmlg_webhook-de-teste';
const DOC = '52998224725';

let panelUrl;
let token;
let alfa;
let beta;
let tokenAlfa;
let tokenBeta;

const dentro = (id, fn) => runInTenant(id, fn);
const entregar = (corpo, tokenHeader) => call(`${panelUrl}/api/asaas-webhook`, {
  method: 'POST',
  headers: tokenHeader === undefined ? {} : { 'asaas-access-token': tokenHeader },
  body: corpo
});
const evento = (event, payment) => ({ event, payment: { object: 'payment', ...payment } });
const pay = (extra = {}) => ({
  id: 'pay_1', customer: 'cus_1', status: 'PENDING', value: 99.9, billingType: 'BOLETO',
  dueDate: '2026-11-10', invoiceUrl: 'https://asaas.test/i/pay_1', ...extra
});
const linha = (id, asaasId = 'pay_1') => getDb()('asaas_charges').where({ tenant_id: id, asaas_id: asaasId }).first();

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-delta', password: 'senha-da-dona-1', email: 'dona-delta@exemplo.test' }
  });
  token = setup.body.data.token;
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta-asaas', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta-asaas' }).first()).id;
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('asaas_charges').del();
  await getDb()('asaas_customers').del();
  for (const id of [alfa, beta]) {
    await dentro(id, async () => {
      await AsaasProviderService.saveConfig({ enabled: true, environment: 'sandbox', apiKey: CHAVE });
      await AsaasProviderService.saveConfig({ webhookEnabled: false });
    });
  }
  tokenAlfa = (await dentro(alfa, () => AsaasProviderService.rotateWebhookToken())).token;
  tokenBeta = (await dentro(beta, () => AsaasProviderService.rotateWebhookToken())).token;
  await dentro(alfa, () => AsaasProviderService.saveConfig({ webhookEnabled: true }));
  await dentro(beta, () => AsaasProviderService.saveConfig({ webhookEnabled: true }));
  await dentro(alfa, () => AsaasCustomer.upsertFromAsaas({ id: 'cus_1', name: 'Maria', document: DOC }, { seenAt: new Date() }));
});

describe('quem pode entregar', () => {
  it('sem ninguém com a entrega ligada, 404', async () => {
    await dentro(alfa, () => AsaasProviderService.saveConfig({ webhookEnabled: false }));
    await dentro(beta, () => AsaasProviderService.saveConfig({ webhookEnabled: false }));
    assert.equal((await entregar(evento('PAYMENT_CREATED', pay()), tokenAlfa)).status, 404);
  });

  it('token errado, ausente ou vazio: 401 uniforme, sem dizer qual parte falhou', async () => {
    const corpo = evento('PAYMENT_CREATED', pay());
    for (const t of ['errado', '', undefined]) {
      const res = await entregar(corpo, t);
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'invalid_token');
    }
    assert.equal(await linha(alfa), undefined, 'nada pode ser gravado sem token');
  });

  it('o token escolhe o provedor: a cobrança cai no dele e no do vizinho nada acontece', async () => {
    const res = await entregar(evento('PAYMENT_CREATED', pay()), tokenAlfa);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(await linha(alfa));
    assert.equal(await linha(beta), undefined);

    await entregar(evento('PAYMENT_CREATED', pay({ id: 'pay_b' })), tokenBeta);
    assert.ok(await linha(beta, 'pay_b'));
    assert.equal(await linha(alfa, 'pay_b'), undefined);
  });

  it('dois provedores com o MESMO token: 401, porque a entrega não pode ser atribuída', async () => {
    const segredo = await dentro(alfa, () => AsaasProviderService.getConfig());
    // Força o token repetido direto no blob do vizinho.
    const raw = JSON.parse(await dentro(beta, async () => (await import('../src/models/AppState.js')).default.get('asaas_provider_config')));
    const alfaRaw = JSON.parse(await dentro(alfa, async () => (await import('../src/models/AppState.js')).default.get('asaas_provider_config')));
    await dentro(beta, async () => (await import('../src/models/AppState.js')).default.upsert(
      'asaas_provider_config', JSON.stringify({ ...raw, webhookToken: alfaRaw.webhookToken })
    ));
    await dentro(beta, () => AsaasProviderService.invalidateConfigCache());
    void segredo;
    const res = await entregar(evento('PAYMENT_CREATED', pay()), tokenAlfa);
    assert.equal(res.status, 401);
    assert.equal(await linha(alfa), undefined);
  });
});

describe('o que a entrega faz', () => {
  it('grava a cobrança com o CPF do cliente que a importação já trouxe', async () => {
    await entregar(evento('PAYMENT_CREATED', pay()), tokenAlfa);
    const row = await linha(alfa);
    assert.equal(row.document, DOC);
    assert.equal(row.status, 'PENDING');
    assert.equal(Number(row.value_cents), 9990);
    assert.equal((await dentro(alfa, () => AsaasCharge.listOpenByDocument(DOC))).length, 1);
  });

  it('PAYMENT_RECEIVED tira a cobrança das abertas na hora', async () => {
    await entregar(evento('PAYMENT_CREATED', pay()), tokenAlfa);
    await entregar(evento('PAYMENT_RECEIVED', pay({ status: 'RECEIVED', paymentDate: '2026-11-02' })), tokenAlfa);
    assert.equal((await linha(alfa)).status, 'RECEIVED');
    assert.equal((await linha(alfa)).payment_date, '2026-11-02');
    assert.equal((await dentro(alfa, () => AsaasCharge.listOpenByDocument(DOC))).length, 0);
  });

  it('uma entrega ATRASADA (UPDATED pendente depois do pago) não reabre a cobrança', async () => {
    await entregar(evento('PAYMENT_RECEIVED', pay({ status: 'RECEIVED', paymentDate: '2026-11-02' })), tokenAlfa);
    const res = await entregar(evento('PAYMENT_UPDATED', pay({ status: 'PENDING' })), tokenAlfa);
    assert.equal(res.status, 200, 'ignorar é 2xx');
    assert.equal(res.body.handled, false);
    assert.equal((await linha(alfa)).status, 'RECEIVED');
  });

  it('só o evento que DESFAZ o pagamento reabre', async () => {
    await entregar(evento('PAYMENT_RECEIVED', pay({ status: 'RECEIVED' })), tokenAlfa);
    await entregar(evento('PAYMENT_RECEIVED_IN_CASH_UNDONE', pay({ status: 'PENDING' })), tokenAlfa);
    assert.equal((await linha(alfa)).status, 'PENDING');
  });

  it('PAYMENT_DELETED marca a cobrança como removida; de uma que não conhece, 200 sem efeito', async () => {
    await entregar(evento('PAYMENT_CREATED', pay()), tokenAlfa);
    await entregar(evento('PAYMENT_DELETED', pay()), tokenAlfa);
    const row = await linha(alfa);
    assert.ok(row.deleted === true || Number(row.deleted) === 1);
    const desconhecida = await entregar(evento('PAYMENT_DELETED', pay({ id: 'pay_nunca_vista' })), tokenAlfa);
    assert.equal(desconhecida.status, 200);
    assert.equal(desconhecida.body.handled, false);
  });

  it('a mesma entrega duas vezes é inócua', async () => {
    const corpo = evento('PAYMENT_RECEIVED', pay({ status: 'RECEIVED' }));
    await entregar(corpo, tokenAlfa);
    await entregar(corpo, tokenAlfa);
    const [{ n }] = await getDb()('asaas_charges').where({ tenant_id: alfa }).count({ n: '*' });
    assert.equal(Number(n), 1);
  });

  it('um evento que não é de cobrança é aceito com 200 e ignorado', async () => {
    const res = await entregar({ event: 'CUSTOMER_CREATED', customer: { id: 'cus_9' } }, tokenAlfa);
    assert.equal(res.status, 200);
    assert.equal(res.body.handled, false);
  });

  it('cobrança de cliente ainda não importado entra sem documento', async () => {
    await entregar(evento('PAYMENT_CREATED', pay({ id: 'pay_novo', customer: 'cus_desconhecido' })), tokenAlfa);
    assert.equal((await linha(alfa, 'pay_novo')).document, null);
  });
});

describe('a configuração do webhook', () => {
  it('o token é cifrado no banco e nunca volta na configuração pública', async () => {
    const publica = await dentro(alfa, () => AsaasProviderService.getPublicConfig());
    assert.equal(publica.webhookTokenConfigured, true);
    assert.ok(!JSON.stringify(publica).includes(tokenAlfa));
    const bruto = await dentro(alfa, async () => (await import('../src/models/AppState.js')).default.get('asaas_provider_config'));
    assert.ok(!bruto.includes(tokenAlfa), 'o token está em claro no banco');
    assert.equal(publica.webhookPath, '/api/asaas-webhook');
  });

  it('salvar a configuração depois não perde o token', async () => {
    await dentro(alfa, () => AsaasProviderService.saveConfig({ botLookup: true }));
    assert.equal((await dentro(alfa, () => AsaasProviderService.getConfig())).webhookToken, tokenAlfa);
  });

  it('ligar sem token é recusado', async () => {
    const semToken = (await getDb()('tenants').insert({ slug: 'gama-asaas', name: 'Gama', status: 'active' }), (await getDb()('tenants').where({ slug: 'gama-asaas' }).first()).id);
    await dentro(semToken, () => AsaasProviderService.saveConfig({ enabled: true, apiKey: CHAVE }));
    await assert.rejects(
      dentro(semToken, () => AsaasProviderService.saveConfig({ webhookEnabled: true })),
      (error) => error.code === 'webhook_token_required'
    );
  });

  it('girar o token invalida o anterior e mostra o novo uma vez, pela rota', async () => {
    const res = await call(`${panelUrl}/api/asaas/webhook/token`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.data.webhookToken, /^[0-9a-f]{64}$/);
    const lida = await call(`${panelUrl}/api/asaas/config`, { headers: authHeaders(token) });
    assert.ok(!JSON.stringify(lida.body).includes(res.body.data.webhookToken), 'a leitura seguinte não pode devolver o token');
  });
});
