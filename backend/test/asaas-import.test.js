import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { call, authHeaders, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: AsaasImportService } = await import('../src/services/asaasImportService.js');
const { default: AsaasProviderService } = await import('../src/services/asaasProviderService.js');
const { default: AsaasCustomer } = await import('../src/models/AsaasCustomer.js');
const { default: AsaasCharge } = await import('../src/models/AsaasCharge.js');
const { default: AppState } = await import('../src/models/AppState.js');
const { runInTenant } = await import('../src/config/tenantContext.js');

/**
 * A importação dos clientes e das cobranças da conta Asaas do provedor, contra
 * um gateway de mentira que serve de DOIS em DOIS — para provar que o laço lê
 * todas as páginas e que anda pelo que veio, e não pelo que pediu.
 */
const CHAVE = '$aact_hmlg_importacao-de-teste';

let gateway;
let base;
let panelUrl;
let tenantId;
let token;
let customers;
let pending;
let overdue;
let detail;
let rejectCharges;
let seen;

const dentro = (fn) => runInTenant(tenantId, fn);

function subirGateway() {
  gateway = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${url.pathname}${url.search}`);
    const responder = (status, corpo) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(corpo));
    };
    if (req.headers.access_token !== CHAVE) return responder(401, { errors: [{ code: 'invalid_access_token' }] });
    const offset = Number(url.searchParams.get('offset') || 0);
    const pagina = (lista) => ({
      object: 'list',
      hasMore: offset + 2 < lista.length,
      totalCount: lista.length,
      offset,
      limit: 2,
      // Sempre dois, não importa o `limit` pedido.
      data: lista.slice(offset, offset + 2)
    });
    if (url.pathname === '/customers') return responder(200, pagina(customers));
    if (url.pathname === '/payments') {
      if (rejectCharges) return responder(401, { errors: [{ code: 'invalid_access_token' }] });
      const status = url.searchParams.get('status');
      return responder(200, pagina(status === 'OVERDUE' ? overdue : pending));
    }
    const um = url.pathname.match(/^\/payments\/([^/]+)$/);
    if (um) {
      const corpo = detail[um[1]];
      return corpo ? responder(200, corpo) : responder(404, { errors: [{ code: 'not_found' }] });
    }
    return responder(404, {});
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

const cliente = (id, extra = {}) => ({
  id, name: `Cliente ${id}`, cpfCnpj: '11144477735', email: `${id}@exemplo.test`, mobilePhone: '(11) 98888-7777',
  postalCode: '01001000', address: 'Rua A', addressNumber: '10', province: 'Centro', cityName: 'São Paulo', state: 'SP',
  deleted: false, ...extra
});
const cobranca = (id, customer, status, extra = {}) => ({
  id, customer, status, value: 99.9, billingType: 'BOLETO', dueDate: '2026-11-10', deleted: false,
  invoiceUrl: `https://asaas.test/i/${id}`, ...extra
});

before(async () => {
  base = await subirGateway();
  ({ panelUrl } = await startTestServers());
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dona-beta', password: 'senha-da-dona-1', email: 'dona-beta@exemplo.test' }
  });
  const login = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'dona-beta', password: 'senha-da-dona-1' }
  });
  token = login.body?.data?.token ?? login.body?.token;
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  AsaasImportService.PAGE_PACE_MS = 0;
  // O gateway de mentira é HTTP e local; as bases reais são fixas no serviço.
  AsaasImportService.credentialFor = () => ({ apiKey: CHAVE, baseUrl: base });
});

after(async () => {
  if (gateway) await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  seen = [];
  rejectCharges = false;
  customers = [
    cliente('cus_1'),
    cliente('cus_2', { cpfCnpj: '123.456.789-09', mobilePhone: null, phone: '1133334444' }),
    cliente('cus_3', { cpfCnpj: null, deleted: false })
  ];
  pending = [cobranca('pay_1', 'cus_1', 'PENDING'), cobranca('pay_2', 'cus_2', 'PENDING'), cobranca('pay_3', 'cus_1', 'PENDING')];
  overdue = [cobranca('pay_4', 'cus_2', 'OVERDUE', { dueDate: '2026-10-01' })];
  detail = {};
  await getDb()('asaas_charges').del();
  await getDb()('asaas_customers').del();
  await dentro(async () => {
    await AsaasProviderService.saveConfig({
      enabled: true, environment: 'sandbox', apiKey: CHAVE,
      importCustomers: true, importCharges: true
    });
    await AppState.upsert('asaas_import_last_run', '');
    await AppState.upsert('asaas_import_last_error', '');
  });
});

describe('a importação de clientes', () => {
  it('lê todas as páginas, normaliza CPF e telefone e não duplica na segunda passada', async () => {
    const primeira = await dentro(() => AsaasImportService.syncAll());
    assert.equal(primeira.customers.total, 3);
    assert.equal(primeira.customers.created, 3);

    const lista = await dentro(() => AsaasCustomer.listByDocument('111.444.777-35'));
    assert.equal(lista.length, 1);
    assert.equal(lista[0].document, '11144477735');
    assert.equal(lista[0].phone_e164, '5511988887777');
    assert.equal(lista[0].city, 'São Paulo');

    const outra = await dentro(() => AsaasCustomer.listByDocument('12345678909'));
    assert.equal(outra[0].phone_e164, '551133334444', 'sem celular, vale o fixo');

    const segunda = await dentro(() => AsaasImportService.syncAll());
    assert.equal(segunda.customers.created, 0);
    assert.equal(segunda.customers.updated, 3);
    const [{ n }] = await getDb()('asaas_customers').count({ n: '*' });
    assert.equal(Number(n), 3);
  });

  it('anda pelo que o gateway devolveu: duas por página, três clientes, duas páginas', async () => {
    await dentro(() => AsaasImportService.syncAll());
    const pedidos = seen.filter((linha) => linha.includes('/customers'));
    assert.equal(pedidos.length, 2);
    assert.match(pedidos[1], /offset=2/);
  });
});

describe('a importação de cobranças', () => {
  it('guarda as abertas, com o CPF do cliente copiado para a linha', async () => {
    const resumo = await dentro(() => AsaasImportService.syncAll());
    assert.equal(resumo.charges.total, 4);
    assert.equal(resumo.charges.withoutCustomer, 0);

    const abertas = await dentro(() => AsaasCharge.listOpenByDocument('11144477735'));
    assert.deepEqual(abertas.map((c) => c.asaas_id).sort(), ['pay_1', 'pay_3']);
    assert.equal(Number(abertas[0].value_cents), 9990);
    assert.equal(abertas[0].invoice_url, 'https://asaas.test/i/pay_1');
    assert.equal(await dentro(() => AsaasCharge.countOverdue()), 1);
  });

  it('a que saiu da lista é conferida: paga vira RECEIVED, apagada vira removida', async () => {
    await dentro(() => AsaasImportService.syncAll());
    // pay_1 foi paga; pay_2 sumiu do gateway; as demais continuam abertas.
    pending = [cobranca('pay_3', 'cus_1', 'PENDING')];
    overdue = [cobranca('pay_4', 'cus_2', 'OVERDUE', { dueDate: '2026-10-01' })];
    detail = { pay_1: { id: 'pay_1', status: 'RECEIVED', paymentDate: '2026-11-02', dueDate: '2026-11-10' } };

    const resumo = await dentro(() => AsaasImportService.syncAll());
    assert.equal(resumo.charges.reconciled, 1);
    assert.equal(resumo.charges.gone, 1);

    const pay1 = await getDb()('asaas_charges').where({ asaas_id: 'pay_1' }).first();
    assert.equal(pay1.status, 'RECEIVED');
    assert.equal(pay1.payment_date, '2026-11-02');
    const pay2 = await getDb()('asaas_charges').where({ asaas_id: 'pay_2' }).first();
    assert.ok(pay2.deleted === true || Number(pay2.deleted) === 1);

    const abertas = await dentro(() => AsaasCharge.listOpenByDocument('11144477735'));
    assert.deepEqual(abertas.map((c) => c.asaas_id), ['pay_3'], 'a paga não pode continuar cobrável');
  });

  it('sem importar clientes, a cobrança entra sem documento e a passada diz quantas', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ importCustomers: false }));
    const resumo = await dentro(() => AsaasImportService.syncAll());
    assert.equal(resumo.customers.total, 0);
    assert.equal(resumo.charges.withoutCustomer, 4);
  });
});

describe('quando o gateway falha no meio', () => {
  it('o que foi lido fica salvo, a passada é dita parcial e o erro é gravado como chave', async () => {
    rejectCharges = true;
    await assert.rejects(dentro(() => AsaasImportService.syncAll()), (error) => {
      assert.equal(error.translationKey, 'asaas.error.unauthorized');
      return true;
    });
    const [{ n }] = await getDb()('asaas_customers').count({ n: '*' });
    assert.equal(Number(n), 3, 'os clientes lidos antes da falha ficam');

    const status = await dentro(() => AsaasImportService.getStatus());
    assert.equal(status.lastRun.partial, true);
    assert.equal(status.lastError.translationKey, 'asaas.error.unauthorized');
    assert.equal(status.running, false, 'o bloqueio é solto mesmo na falha');
  });

  it('uma passada incompleta não confere as cobranças que "sumiram"', async () => {
    await dentro(() => AsaasImportService.syncAll());
    rejectCharges = true;
    await assert.rejects(dentro(() => AsaasImportService.syncAll()));
    const pay1 = await getDb()('asaas_charges').where({ asaas_id: 'pay_1' }).first();
    assert.equal(pay1.status, 'PENDING');
    assert.ok(!seen.some((linha) => /GET \/payments\/pay_/.test(linha)), 'não pode ler cobrança por cobrança');
  });
});

describe('a situação da importação', () => {
  it('conta quem também está no SGP, quem não tem documento e o CPF duplicado', async () => {
    customers = [...customers, cliente('cus_4', { cpfCnpj: '11144477735' })];
    await getDb()('sgp_contacts').where({ tenant_id: tenantId }).del();
    await getDb()('sgp_contacts').insert({
      tenant_id: tenantId, contract: 'C-1', document: '11144477735', client_name: 'Fulano', state: 'active'
    });
    await dentro(() => AsaasImportService.syncAll());

    const status = await dentro(() => AsaasImportService.getStatus());
    assert.equal(status.totals.customers, 4);
    assert.equal(status.totals.withoutDocument, 1);
    assert.equal(status.totals.duplicateDocuments, 1);
    assert.equal(status.totals.matchingSgp, 2, 'cus_1 e cus_4 têm o CPF do contato do SGP; cus_2 não');
  });

  it('recusa importar sem a integração ligada ou sem nada para importar', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ importCustomers: false, importCharges: false }));
    await assert.rejects(dentro(() => AsaasImportService.start()), (e) => e.code === 'nothing_to_import');
    await dentro(() => AsaasProviderService.saveConfig({ apiKey: '' }));
    await assert.rejects(dentro(() => AsaasImportService.start()), (e) => e.code === 'not_configured');
  });
});

describe('as rotas /api/asaas/import', () => {
  it('GET devolve a situação e POST inicia e responde 202', async () => {
    const get = await call(`${panelUrl}/api/asaas/import`, { headers: authHeaders(token) });
    assert.equal(get.status, 200, JSON.stringify(get.body));
    assert.equal(get.body.data.totals.customers, 0);

    const post = await call(`${panelUrl}/api/asaas/import/sync`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(post.status, 202, JSON.stringify(post.body));
    // Espera a passada em segundo plano terminar antes de fechar o servidor.
    for (let i = 0; i < 50; i += 1) {
      const s = await call(`${panelUrl}/api/asaas/import`, { headers: authHeaders(token) });
      if (!s.body.data.running && s.body.data.lastRun) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const depois = await call(`${panelUrl}/api/asaas/import`, { headers: authHeaders(token) });
    assert.equal(depois.body.data.totals.customers, 3);
  });

  it('POST com a integração desligada é 409 com código', async () => {
    await call(`${panelUrl}/api/asaas/config`, {
      method: 'PUT', headers: authHeaders(token), body: { enabled: false }
    });
    const post = await call(`${panelUrl}/api/asaas/import/sync`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(post.status, 409, JSON.stringify(post.body));
    assert.equal(post.body.code, 'not_configured');
  });
});
