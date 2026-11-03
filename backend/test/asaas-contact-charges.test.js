import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: AsaasProviderService } = await import('../src/services/asaasProviderService.js');
const { default: AsaasProviderCustomerService } = await import('../src/services/asaasProviderCustomerService.js');
const { default: AsaasInvoiceService } = await import('../src/services/asaasInvoiceService.js');
const { default: AsaasCustomer } = await import('../src/models/AsaasCustomer.js');
const { default: AsaasCharge } = await import('../src/models/AsaasCharge.js');

/**
 * Os botões do Asaas na ficha do cliente: consultar/atualizar os boletos,
 * pegar o Pix e a linha digitável na hora, mandar o boleto por WhatsApp e gerar
 * uma cobrança nova. A cobrança nova é a única escrita: dinheiro de verdade,
 * opção própria desligada, e valor/vencimento conferidos aqui, antes do Asaas.
 */
const CHAVE = '$aact_hmlg_ficha-boletos';
const DOC = '52998224725';
const LINHA = '23793381286000782713695000063305975520000012990';
const PIX = '00020126580014BR.GOV.BCB.PIX0136ficha-chave5204000053039865802BR';

let panelUrl;
let token;
let gateway;
let base;
let pedidos;
let remotas;       // cobranças do cliente no Asaas (corpo do gateway)
let contatoKey;

const dia = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
};
const dentro = (fn) => asTenant(fn);
const api = (path, options = {}) => call(`${panelUrl}/api/contacts/${encodeURIComponent(contatoKey)}${path}`, { headers: authHeaders(token), ...options });

function subir() {
  gateway = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
      pedidos.push({ method: req.method, path: url.pathname, query: url.search, payload, key: req.headers.access_token });
      const responder = (s, c) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(c)); };
      if (req.headers.access_token !== CHAVE) return responder(401, {});
      if (req.method === 'GET' && url.pathname === '/customers/cus_ficha') {
        return responder(200, { id: 'cus_ficha', name: 'Maria Atualizada', cpfCnpj: DOC, mobilePhone: '93981110000' });
      }
      if (req.method === 'GET' && url.pathname === '/payments') {
        return responder(200, { object: 'list', hasMore: false, data: remotas });
      }
      if (req.method === 'POST' && url.pathname === '/payments') {
        const nova = { id: 'pay_nova', customer: payload.customer, status: 'PENDING', value: payload.value,
          billingType: payload.billingType, dueDate: payload.dueDate, invoiceUrl: 'https://asaas.test/i/pay_nova', externalReference: payload.externalReference };
        remotas = [nova, ...remotas];
        return responder(200, nova);
      }
      const um = url.pathname.match(/^\/payments\/([^/]+)$/);
      if (req.method === 'GET' && um) {
        const c = remotas.find((r) => r.id === um[1]);
        return c ? responder(200, c) : responder(404, {});
      }
      if (url.pathname.endsWith('/identificationField')) return responder(200, { identificationField: LINHA, barCode: '1' });
      if (url.pathname.endsWith('/pixQrCode')) return responder(200, { payload: PIX, encodedImage: 'x' });
      return responder(404, {});
    });
  });
  return new Promise((r) => gateway.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${gateway.address().port}`)));
}

before(async () => {
  base = await subir();
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-eps', password: 'senha-da-dona-1', email: 'dona-eps@exemplo.test' }
  });
  token = setup.body.data.token;
  const cred = () => ({ apiKey: CHAVE, baseUrl: base });
  AsaasProviderCustomerService.credentialFor = cred;
  AsaasInvoiceService.credentialFor = cred;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  pedidos = [];
  remotas = [
    { id: 'pay_aberta', customer: 'cus_ficha', status: 'OVERDUE', value: 99.9, billingType: 'BOLETO', dueDate: dia(-3), invoiceUrl: 'https://asaas.test/i/pay_aberta' },
    { id: 'pay_futura', customer: 'cus_ficha', status: 'PENDING', value: 50, billingType: 'BOLETO', dueDate: dia(10), invoiceUrl: 'https://asaas.test/i/pay_futura' },
    { id: 'pay_paga', customer: 'cus_ficha', status: 'RECEIVED', value: 80, billingType: 'PIX', dueDate: dia(-40), paymentDate: dia(-39), invoiceUrl: 'https://asaas.test/i/pay_paga' }
  ];
  const db = getDb();
  for (const t of ['asaas_charges', 'asaas_customers', 'sgp_contacts', 'sgp_clients']) await db(t).del();
  await dentro(() => AsaasProviderService.saveConfig({
    enabled: true, environment: 'sandbox', apiKey: CHAVE, allowWriteCustomers: true, allowWriteCharges: true
  }));
  const res = await call(`${panelUrl}/api/contacts`, {
    method: 'POST', headers: authHeaders(token),
    body: { name: 'Maria Souza', document: DOC, personType: 'PF', whatsappPhone: '(93) 98111-0000' }
  });
  contatoKey = res.body.data.key;
  await dentro(() => AsaasCustomer.upsertFromAsaas({ id: 'cus_ficha', name: 'Maria', document: DOC }, { seenAt: new Date() }));
});

describe('consultar e atualizar os boletos do cliente', () => {
  it('relê o cadastro e as cobranças no Asaas: em aberto primeiro (a mais antiga), depois as outras', async () => {
    const res = await api('/asaas/refresh', { method: 'POST' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.charges.map((c) => c.id), ['pay_aberta', 'pay_futura', 'pay_paga']);
    assert.equal(res.body.data.charges[0].open, true);
    assert.equal(res.body.data.charges[2].open, false);
    assert.equal(res.body.data.charges[0].amount, 99.9);
    assert.ok(pedidos.every((p) => p.key === CHAVE), 'tem de usar a credencial do provedor');

    // E guarda a cópia: o cadastro foi relido e as cobranças estão no banco com o CPF.
    const cliente = await dentro(() => AsaasCustomer.getByAsaasId('cus_ficha'));
    assert.equal(cliente.name, 'Maria Atualizada');
    assert.equal((await dentro(() => AsaasCharge.listOpenByDocument(DOC))).length, 2);
  });

  it('uma cobrança que o Asaas já deu como paga sai das abertas na cópia do painel', async () => {
    await api('/asaas/refresh', { method: 'POST' });
    remotas = remotas.map((r) => (r.id === 'pay_aberta' ? { ...r, status: 'RECEIVED', paymentDate: dia(0) } : r));
    await api('/asaas/refresh', { method: 'POST' });
    const abertas = await dentro(() => AsaasCharge.listOpenByDocument(DOC));
    assert.deepEqual(abertas.map((c) => c.asaas_id), ['pay_futura']);
  });

  it('cliente que ainda não está no Asaas: 409 com código', async () => {
    await getDb()('asaas_customers').del();
    const res = await api('/asaas/refresh', { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'customer_not_linked');
  });

  it('contato que não existe é 404, antes de qualquer outra coisa', async () => {
    const res = await call(`${panelUrl}/api/contacts/c:99999/asaas/refresh`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(res.status, 404);
  });
});

describe('o Pix e a linha digitável', () => {
  it('lê do Asaas na hora, para uma cobrança em aberto deste cliente', async () => {
    await api('/asaas/refresh', { method: 'POST' });
    const res = await api('/asaas/charges/pay_aberta/codes');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.digitableLine, LINHA);
    assert.equal(res.body.data.pix, PIX);
  });

  it('uma cobrança que acabou de ser paga no Asaas é 409 charge_closed', async () => {
    await api('/asaas/refresh', { method: 'POST' });
    remotas = remotas.map((r) => (r.id === 'pay_aberta' ? { ...r, status: 'RECEIVED' } : r));
    const res = await api('/asaas/charges/pay_aberta/codes');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'charge_closed');
  });

  it('a cobrança de OUTRO CPF é "não encontrada"', async () => {
    await api('/asaas/refresh', { method: 'POST' });
    await dentro(() => AsaasCharge.upsertFromAsaas({ id: 'pay_alheia', customerId: 'cus_x', status: 'PENDING', billingType: 'BOLETO', valueCents: 1000, dueDate: dia(5) }, { document: '11144477735', seenAt: new Date() }));
    const res = await api('/asaas/charges/pay_alheia/codes');
    assert.equal(res.status, 404);
  });
});

describe('mandar o boleto do Asaas por WhatsApp', () => {
  it('a prévia traz o valor, o vencimento e os códigos de agora, sem citar contrato', async () => {
    await api('/asaas/refresh', { method: 'POST' });
    const res = await api('/invoices/pay_aberta/whatsapp');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.data.text, /99,90/);
    assert.ok(res.body.data.text.includes(LINHA) && res.body.data.text.includes(PIX));
    assert.ok(!/contrato/i.test(res.body.data.text), 'fatura do Asaas não tem contrato');
    assert.equal(res.body.data.contract, null);
  });

  it('uma cobrança já paga no Asaas não vira boleto para o cliente', async () => {
    await api('/asaas/refresh', { method: 'POST' });
    remotas = remotas.map((r) => (r.id === 'pay_aberta' ? { ...r, status: 'RECEIVED' } : r));
    const res = await api('/invoices/pay_aberta/whatsapp');
    assert.equal(res.status, 404);
  });
});

describe('gerar uma cobrança nova (a escrita com dinheiro)', () => {
  const corpo = (extra = {}) => ({ value: 120.5, dueDate: dia(7), billingType: 'BOLETO', description: 'Taxa de religação', ...extra });

  it('cria no Asaas com a credencial do provedor e guarda a cópia', async () => {
    const res = await api('/asaas/charges', { method: 'POST', body: corpo() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.charge.id, 'pay_nova');
    assert.equal(res.body.data.charge.open, true);

    const post = pedidos.find((p) => p.method === 'POST' && p.path === '/payments');
    assert.equal(post.key, CHAVE);
    assert.equal(post.payload.customer, 'cus_ficha');
    assert.equal(post.payload.value, 120.5);
    assert.equal(post.payload.billingType, 'BOLETO');
    assert.equal(post.payload.description, 'Taxa de religação');
    assert.match(post.payload.externalReference, /^painel:/);
    assert.ok(!('fine' in post.payload) && !('interest' in post.payload), 'multa e juros são do dono da conta, não nossos');

    assert.equal((await dentro(() => AsaasCharge.getByAsaasId('pay_nova'))).document, DOC);
  });

  it('com a opção desligada nada é criado e o Asaas nem é chamado', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ allowWriteCharges: false }));
    const res = await api('/asaas/charges', { method: 'POST', body: corpo() });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'write_disabled');
    assert.equal(pedidos.length, 0);
  });

  it('recusa valor abaixo de R$ 5,00, vencimento passado, tipo inválido — antes de ir ao Asaas', async () => {
    for (const [extra, code] of [
      [{ value: 4.99 }, 'invalid_value'],
      [{ value: 'abc' }, 'invalid_value'],
      [{ dueDate: dia(-1) }, 'invalid_due_date'],
      [{ dueDate: '2026-02-30' }, 'invalid_due_date'],
      [{ billingType: 'CREDIT_CARD' }, 'invalid_billing_type']
    ]) {
      const res = await api('/asaas/charges', { method: 'POST', body: corpo(extra) });
      assert.equal(res.status, 400, JSON.stringify([extra, res.body]));
      assert.equal(res.body.code, code);
    }
    assert.ok(!pedidos.some((p) => p.method === 'POST'), 'nada pode ter sido criado');
  });

  it('cliente que ainda não está no Asaas: 409, sem criar cobrança', async () => {
    await getDb()('asaas_customers').del();
    const res = await api('/asaas/charges', { method: 'POST', body: corpo() });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'customer_not_linked');
    assert.equal(pedidos.length, 0);
  });

  it('a recusa do Asaas chega com o motivo dele', async () => {
    // Um cliente que o Asaas não conhece: o POST volta 400 do gateway.
    const original = gateway.listeners('request')[0];
    gateway.removeAllListeners('request');
    gateway.on('request', (req, res) => {
      if (req.method === 'POST') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ errors: [{ code: 'invalid_customer', description: 'Cliente inválido ou não encontrado.' }] }));
      }
      return original(req, res);
    });
    try {
      const res = await api('/asaas/charges', { method: 'POST', body: corpo() });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.message, /Cliente inválido/);
    } finally {
      gateway.removeAllListeners('request');
      gateway.on('request', original);
    }
  });
});
