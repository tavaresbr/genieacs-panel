import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { tinsertReturningId } = await import('../src/config/database.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { asaasBilling } = await import('../src/services/billing/asaasBillingProvider.js');
const { clearPaymentInfoCache } = await import('../src/services/tenantChargeService.js');
const { esc } = await import('../src/services/chargeReceiptService.js');

/**
 * As faturas do provedor: a segunda via (link, linha digitável e QR do Pix,
 * lidos do gateway agora), o recibo da paga e os filtros da lista.
 *
 * Self-hosted, pelo motivo de `tenant-self-billing.test.js`: só fora da SaaS o
 * cliente do gateway aceita `127.0.0.1`, e o gateway aqui é de mentira. A
 * porta da assinatura, que só existe na SaaS, é conferida em
 * `tenant-charges.test.js`.
 *
 * O que não pode dar errado:
 *
 * 1. **A cobrança do vizinho.** O id de outro provedor é 404 nas duas rotas —
 *    sem uma chamada sequer ao gateway.
 * 2. **O gateway fora do ar corromper a linha.** A segunda via só lê; a falha
 *    é 502 e a cobrança fica exatamente como estava.
 * 3. **O nome digitado virar script no recibo.** Todo texto sai escapado, e a
 *    CSP da resposta não deixa rodar nada.
 */
const CHAVE = 'chave-das-faturas';
const LINHA = '23793381286000000000300000000401184340000019900';
const PIX = '00020101021226820014br.gov.bcb.pix2560pix.exemplo.test/qr/v2/abc5204000053039865406199.005802BR';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let gateway;
let recebidas = [];
/** O que o gateway de mentira devolve para cada cobrança, por id. */
const noGateway = new Map();
let panelUrl;
let alfa;
let beta;
let token;

function subirGateway() {
  gateway = http.createServer((req, res) => {
    const caminho = req.url.split('?')[0];
    recebidas.push({ method: req.method, path: caminho });
    const responder = (status, corpo) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(corpo));
    };
    if (req.headers.access_token !== CHAVE) return responder(401, {});
    const achado = caminho.match(/^\/payments\/([^/]+)(?:\/(pixQrCode|identificationField))?$/);
    if (req.method !== 'GET' || !achado) return responder(404, {});
    const id = decodeURIComponent(achado[1]);
    const cobranca = noGateway.get(id);
    if (!cobranca) return responder(404, {});
    if (cobranca.fora) return responder(500, { errors: [{ description: 'fora do ar' }] });
    if (achado[2] === 'pixQrCode') {
      if (cobranca.semPix) return responder(400, { errors: [{ description: 'sem Pix' }] });
      return responder(200, { encodedImage: PNG, payload: PIX, expirationDate: '2026-04-30 23:59:59' });
    }
    if (achado[2] === 'identificationField') {
      if (cobranca.semBoleto) return responder(400, { errors: [{ description: 'não é boleto' }] });
      return responder(200, { identificationField: LINHA, nossoNumero: '6543', barCode: '23799840000019900' });
    }
    return responder(200, {
      id,
      status: cobranca.status ?? 'PENDING',
      value: 199,
      billingType: cobranca.billingType,
      dueDate: '2026-04-10',
      invoiceUrl: `https://gateway.exemplo.test/i/${id}`,
      bankSlipUrl: `https://gateway.exemplo.test/b/${id}.pdf`
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  beta = await Tenant.create({ slug: 'beta-faturas', name: 'Provedor Beta' });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

afterEach(async () => {
  await getDb()('billing_events').del();
  await getDb()('billing_charges').del();
  noGateway.clear();
  recebidas = [];
  clearPaymentInfoCache();
});

let periodo = 0;
/** Uma cobrança escrita direto, com período próprio (a chave única é por período). */
async function cobranca(tenantId, patch = {}) {
  periodo += 1;
  return runInTenant(tenantId, () => tinsertReturningId('billing_charges', {
    period_end: `2025-${String((periodo % 12) + 1).padStart(2, '0')}-${String(10 + (periodo % 18)).padStart(2, '0')}`,
    amount_cents: 19900,
    currency: 'BRL',
    provider: 'asaas',
    status: 'pending',
    invoice_url: 'https://gateway.exemplo.test/i/velha',
    due_date: '2026-04-10',
    ...patch
  }));
}

/** Um pagamento no extrato, como o webhook o grava. */
async function pagamento(tenantId, externalId, detail = {}, patch = {}) {
  return runInTenant(tenantId, () => tinsertReturningId('billing_events', {
    type: 'payment.recorded',
    amount_cents: 19900,
    currency: 'BRL',
    provider: 'asaas',
    external_id: externalId,
    detail: JSON.stringify(detail),
    ...patch
  }));
}

const segundaVia = (id) => call(`${panelUrl}/api/tenant/charges/${id}/payment-info`, { headers: authHeaders(token) });
const recibo = (id, headers = {}) => fetch(`${panelUrl}/api/tenant/charges/${id}/receipt`, {
  headers: { ...authHeaders(token), ...headers }
});

describe('a segunda via', () => {
  it('do boleto traz a linha digitável, o QR do Pix e a página atual', async () => {
    const id = await cobranca(alfa, { gateway_charge_id: 'pay_boleto', status: 'overdue' });
    noGateway.set('pay_boleto', { billingType: 'BOLETO' });
    const r = await segundaVia(id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const info = r.body.data.paymentInfo;
    assert.equal(info.chargeId, id);
    assert.equal(info.status, 'overdue');
    assert.equal(info.billingType, 'BOLETO');
    // A página de AGORA, e não a gravada na linha.
    assert.equal(info.invoiceUrl, 'https://gateway.exemplo.test/i/pay_boleto');
    assert.equal(info.boleto.identificationField, LINHA);
    assert.equal(info.boleto.bankSlipUrl, 'https://gateway.exemplo.test/b/pay_boleto.pdf');
    assert.equal(info.pix.payload, PIX);
    assert.equal(info.pix.encodedImage, PNG);
  });

  it('do Pix não pede linha digitável', async () => {
    const id = await cobranca(alfa, { gateway_charge_id: 'pay_pix' });
    noGateway.set('pay_pix', { billingType: 'PIX' });
    const r = await segundaVia(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.paymentInfo.boleto, null);
    assert.equal(r.body.data.paymentInfo.pix.payload, PIX);
    assert.ok(!recebidas.some((x) => x.path.endsWith('/identificationField')));
  });

  it('do cartão só tem a página', async () => {
    const id = await cobranca(alfa, { gateway_charge_id: 'pay_cartao', billing_type: 'CREDIT_CARD' });
    noGateway.set('pay_cartao', { billingType: 'CREDIT_CARD' });
    const r = await segundaVia(id);
    assert.equal(r.status, 200);
    const info = r.body.data.paymentInfo;
    assert.equal(info.billingType, 'CREDIT_CARD');
    assert.equal(info.boleto, null);
    assert.equal(info.pix, null);
    assert.equal(info.invoiceUrl, 'https://gateway.exemplo.test/i/pay_cartao');
    assert.equal(recebidas.length, 1, 'só a leitura da cobrança');
  });

  it('a recusa de uma das leituras extras não esconde a outra', async () => {
    const id = await cobranca(alfa, { gateway_charge_id: 'pay_misto' });
    noGateway.set('pay_misto', { billingType: 'UNDEFINED', semBoleto: true });
    const r = await segundaVia(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.paymentInfo.boleto, null);
    assert.equal(r.body.data.paymentInfo.pix.payload, PIX);
  });

  it('guarda a resposta por um minuto: o segundo clique não vai ao gateway', async () => {
    const id = await cobranca(alfa, { gateway_charge_id: 'pay_cache' });
    noGateway.set('pay_cache', { billingType: 'UNDEFINED' });
    assert.equal((await segundaVia(id)).status, 200);
    const depoisDaPrimeira = recebidas.length;
    assert.equal((await segundaVia(id)).status, 200);
    assert.equal(recebidas.length, depoisDaPrimeira);
  });

  it('com o gateway fora do ar, 502 gateway_failed — e a linha fica como estava', async () => {
    const id = await cobranca(alfa, { gateway_charge_id: 'pay_fora' });
    noGateway.set('pay_fora', { fora: true });
    const antes = await getDb()('billing_charges').where({ id }).first();
    const r = await segundaVia(id);
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'gateway_failed');
    const depois = await getDb()('billing_charges').where({ id }).first();
    assert.deepEqual(depois, antes);
  });

  it('a cobrança que o gateway já tem como paga é 409 already_paid, sem marcar nada', async () => {
    const id = await cobranca(alfa, { gateway_charge_id: 'pay_ja_paga' });
    noGateway.set('pay_ja_paga', { billingType: 'PIX', status: 'RECEIVED' });
    const r = await segundaVia(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'already_paid');
    assert.equal((await getDb()('billing_charges').where({ id }).first()).status, 'pending');
  });

  it('qualquer estado do gateway fora de PENDING/OVERDUE é 409, sem marcar nada', async () => {
    const casos = [
      ['CONFIRMED', 'already_paid'], ['RECEIVED_IN_CASH', 'already_paid'],
      ['REFUNDED', 'not_open'], ['DELETED', 'not_open'], ['REFUND_REQUESTED', 'not_open'],
      ['CHARGEBACK_REQUESTED', 'not_open'], ['ESTADO_NOVO', 'not_open']
    ];
    for (const [status, code] of casos) {
      // eslint-disable-next-line no-await-in-loop
      const id = await cobranca(alfa, { gateway_charge_id: `pay_${status}` });
      noGateway.set(`pay_${status}`, { billingType: 'BOLETO', status });
      // eslint-disable-next-line no-await-in-loop
      const r = await segundaVia(id);
      assert.equal(r.status, 409, status);
      assert.equal(r.body.code, code, status);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await getDb()('billing_charges').where({ id }).first()).status, 'pending', status);
    }
    // Sem a leitura do boleto nem do Pix: não há o que mostrar.
    assert.ok(!recebidas.some((x) => x.path.endsWith('/pixQrCode') || x.path.endsWith('/identificationField')));
  });

  it('a linha que saiu do aberto descarta a segunda via guardada', async () => {
    const id = await cobranca(alfa, { gateway_charge_id: 'pay_quitada' });
    noGateway.set('pay_quitada', { billingType: 'PIX' });
    assert.equal((await segundaVia(id)).status, 200);
    // O webhook quitou a linha: a guardada não sai mais.
    await getDb()('billing_charges').where({ id }).update({ status: 'paid' });
    const paga = await segundaVia(id);
    assert.equal(paga.status, 409);
    assert.equal(paga.body.code, 'not_open');
    // E se ela voltar ao aberto (estorno do pagamento, por exemplo), a próxima
    // leitura vai ao gateway de novo, e não ao que estava guardado.
    await getDb()('billing_charges').where({ id }).update({ status: 'pending' });
    const antes = recebidas.length;
    assert.equal((await segundaVia(id)).status, 200);
    assert.ok(recebidas.length > antes);
  });

  it('recusa a que não está em aberto e a que não chegou ao gateway', async () => {
    const paga = await cobranca(alfa, { gateway_charge_id: 'pay_x', status: 'paid' });
    const r1 = await segundaVia(paga);
    assert.equal(r1.status, 409);
    assert.equal(r1.body.code, 'not_open');
    const semGateway = await cobranca(alfa);
    const r2 = await segundaVia(semGateway);
    assert.equal(r2.status, 409);
    assert.equal(r2.body.code, 'no_gateway_charge');
    assert.equal(recebidas.length, 0);
  });

  it('a cobrança do vizinho é 404, sem chamada ao gateway', async () => {
    const doVizinho = await cobranca(beta, { gateway_charge_id: 'pay_vizinho' });
    noGateway.set('pay_vizinho', { billingType: 'BOLETO' });
    const r = await segundaVia(doVizinho);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'charge_not_found');
    assert.equal(recebidas.length, 0);
    assert.equal((await segundaVia(999999)).status, 404);
    assert.equal((await segundaVia('abc')).status, 404);
  });
});

describe('o recibo', () => {
  it('da cobrança paga sai em HTML, com CSP estrita, o meio e o dia do pagamento', async () => {
    const id = await cobranca(alfa, { gateway_charge_id: 'pay_recibo', status: 'paid' });
    await pagamento(alfa, 'pay_recibo', { paymentMethod: 'PIX', paidOn: '2026-03-20' });
    const r = await recibo(id);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/);
    const html = await r.text();
    assert.match(html, /Recibo de pagamento/);
    assert.match(html, /20\/03\/2026/);
    assert.match(html, />Pix</);
    assert.match(html, /R\$\s?199,00/);
    assert.match(html, new RegExp(`#${id}`));
    assert.doesNotMatch(html, /<script/i);
  });

  it('escapa o nome do provedor: um <script> sai impresso, não executado', async () => {
    const original = await Tenant.findById(alfa);
    await getDb()('tenants').where({ id: alfa }).update({
      name: '<script>alert(1)</script>', billing_legal_name: '"><img src=x onerror=alert(2)>'
    });
    try {
      const id = await cobranca(alfa, { status: 'paid' });
      const html = await (await recibo(id)).text();
      assert.doesNotMatch(html, /<script>alert/);
      assert.doesNotMatch(html, /<img src=x/);
      assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
      assert.match(html, /&quot;&gt;/);
    } finally {
      await getDb()('tenants').where({ id: alfa }).update({
        name: original.name, billing_legal_name: original.billing_legal_name ?? null
      });
    }
  });

  it('no idioma pedido', async () => {
    const id = await cobranca(alfa, { status: 'paid' });
    const html = await (await recibo(id, { 'Accept-Language': 'en' })).text();
    assert.match(html, /Payment receipt/);
    assert.match(html, /<html lang="en"/);
  });

  it('da cobrança que não está paga é 409 not_paid', async () => {
    for (const status of ['pending', 'overdue', 'refunded', 'canceled']) {
      const id = await cobranca(alfa, { status });
      const r = await recibo(id);
      assert.equal(r.status, 409, status);
      assert.equal((await r.json()).code, 'not_paid');
    }
  });

  it('da cobrança do vizinho é 404', async () => {
    const doVizinho = await cobranca(beta, { status: 'paid' });
    const r = await recibo(doVizinho);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, 'charge_not_found');
  });

  it('o escape cobre os cinco caracteres', () => {
    assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    assert.equal(esc(null), '');
  });
});

describe('a lista de faturas', () => {
  const listar = (query = '') => call(`${panelUrl}/api/tenant/charges${query}`, { headers: authHeaders(token) });

  it('mostra o dia e o meio do pagamento, o desconto e o cupom', async () => {
    const paga = await cobranca(alfa, { gateway_charge_id: 'pay_lista', status: 'paid' });
    await pagamento(alfa, 'pay_lista', {
      paymentMethod: 'BOLETO',
      earlyPaymentDiscount: { discountCents: 995, discountedCents: 18905, paidOn: '2026-03-05', limitDate: '2026-03-05' },
      coupon: { id: 7, code: 'BEMVINDO' }
    });
    const manual = await cobranca(alfa, { status: 'paid' });
    await pagamento(alfa, `charge:${manual}`, {}, { provider: 'manual' });
    const aberta = await cobranca(alfa, { gateway_charge_id: 'pay_aberta' });

    const r = await listar();
    assert.equal(r.status, 200);
    const porId = new Map(r.body.data.charges.map((c) => [c.id, c]));
    const a = porId.get(paga);
    assert.equal(a.paymentMethod, 'BOLETO');
    assert.equal(a.paidAt, '2026-03-05');
    assert.equal(a.earlyDiscountCents, 995);
    assert.equal(a.couponCode, 'BEMVINDO');
    assert.equal(a.receiptAvailable, true);
    assert.equal(a.paymentInfoAvailable, false);
    assert.equal(porId.get(manual).paymentMethod, 'MANUAL');
    assert.ok(porId.get(manual).paidAt, 'sem dia gravado, vale o do registro');
    assert.equal(porId.get(aberta).paymentInfoAvailable, true);
    assert.equal(porId.get(aberta).receiptAvailable, false);
    // O id no gateway continua fora da tela do provedor.
    assert.equal(a.gatewayChargeId, undefined);
    assert.ok(r.body.data.years.includes(new Date().getUTCFullYear()));
  });

  it('filtra por estado e por ano', async () => {
    const paga = await cobranca(alfa, { status: 'paid' });
    const vencida = await cobranca(alfa, { status: 'overdue' });
    const antiga = await cobranca(alfa, { status: 'paid', created_at: new Date(Date.UTC(2024, 5, 15, 12)) });

    const pagas = (await listar('?status=paid')).body.data.charges.map((c) => c.id);
    assert.deepEqual(pagas.sort(), [paga, antiga].sort());
    const abertas = (await listar('?status=open')).body.data.charges.map((c) => c.id);
    assert.deepEqual(abertas, [vencida]);

    const de2024 = await listar('?year=2024');
    assert.deepEqual(de2024.body.data.charges.map((c) => c.id), [antiga]);
    assert.deepEqual(de2024.body.data.filters, { year: 2024, status: null });
    const anos = de2024.body.data.years;
    assert.ok(anos.includes(2024) && anos.includes(new Date().getUTCFullYear()));
    assert.deepEqual(anos, [...anos].sort((x, y) => y - x));

    const pagasDoAno = (await listar(`?year=${new Date().getUTCFullYear()}&status=paid`)).body.data.charges.map((c) => c.id);
    assert.deepEqual(pagasDoAno, [paga]);
  });

  it('não mistura as do vizinho, nem nos anos', async () => {
    await cobranca(beta, { status: 'paid', created_at: new Date(Date.UTC(2021, 0, 10, 12)) });
    const r = await listar('?year=2021');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.charges, []);
    assert.ok(!r.body.data.years.includes(2021));
  });

  it('recusa filtro inválido com 400', async () => {
    for (const q of ['?year=abc', '?year=1999', '?status=quitada']) {
      const r = await listar(q);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.code, 'invalid_filter');
    }
  });
});

describe('o pagamento do gateway grava o meio e o dia', () => {
  it('no extrato, para a lista e o recibo lerem depois', async () => {
    const plano = await Plan.create({ code: 'faturas-pro', name: 'Pro', price_cents: 19900, currency: 'BRL', period_days: 30, active: true });
    await Subscription.upsertForTenant(alfa, { status: 'active', plan_id: plano.id, renews_at: new Date(Math.floor((Date.now() + 86_400_000) / 1000) * 1000) });
    await SubscriptionService.invalidate(alfa);
    await runInTenant(alfa, () => asaasBilling.recordPayment({
      amountCents: 19900, currency: 'BRL', externalId: 'pay_meio', paidOn: '2026-03-21', paymentMethod: 'PIX'
    }));
    const evento = await getDb()('billing_events').where({ external_id: 'pay_meio' }).first();
    const detalhe = JSON.parse(evento.detail);
    assert.equal(detalhe.paymentMethod, 'PIX');
    assert.equal(detalhe.paidOn, '2026-03-21');
  });
});
