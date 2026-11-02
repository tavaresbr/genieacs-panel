import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A exportação para a contabilidade.
 *
 * A montagem (`buildAccountingExport`) é pura, e é nela que se fixam as
 * decisões: a conta aberta de cada cobrança (cupom, crédito, excedente,
 * ajuste), o extrato do período em Brasília, os créditos e as notas — e que
 * os totais batem com o relatório de receita do mesmo período. Os formatos
 * (CSV brasileiro, XLSX lido de volta pelo `exceljs`), a rota, o "Enviar
 * agora", o envio mensal único e os anexos do e-mail vêm depois, com banco.
 *
 * As datas do banco são todas ao segundo: o MySQL guarda ao segundo e
 * ARREDONDA os milissegundos.
 */
// SaaS: o console (`/api/platform`) só existe nessa edição.
process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: ExcelJS } = await import('exceljs');
const { BILLING_EVENT_TYPES } = await import('../src/models/BillingEvent.js');
const {
  parseAccountingRange, buildAccountingExport, chargeBreakdown, toAccountingCsv, toAccountingXlsx,
  accountingAttachments, build, formatTaxId, inicioDoDiaSp
} = await import('../src/services/accountingExportService.js');
const {
  aggregateRevenue, buildRevenueReport, parseRange
} = await import('../src/services/revenueReportService.js');
const { default: PlatformAlertService } = await import('../src/services/platformAlertService.js');
const { saveProfile, invalidatePlatformProfile, accountingConfig } = await import('../src/services/platformProfileService.js');
const { mailAttachments } = await import('../src/services/mail/mailTransport.js');
const { mailTransport, resetMailTransport } = await import('../src/services/mail/index.js');

const NOW = new Date('2026-11-02T15:00:00Z');

describe('contabilidade: o período em Brasília', () => {
  it('o mês vai da meia-noite de Brasília do dia 1º à do mês seguinte', () => {
    const r = parseAccountingRange({ month: '2026-10' }, NOW);
    assert.equal(r.from, '2026-10-01');
    assert.equal(r.to, '2026-10-31');
    assert.equal(r.startMs, Date.UTC(2026, 9, 1, 3));
    assert.equal(r.endMs, Date.UTC(2026, 10, 1, 3));
    assert.equal(inicioDoDiaSp('2026-02-28'), Date.UTC(2026, 1, 28, 3));
  });

  it('sem nada, é o mês anterior ao de agora em Brasília — também na virada do mês', () => {
    assert.equal(parseAccountingRange({}, NOW).from, '2026-10-01');
    // 1º de novembro às 01:00 UTC ainda é 31 de outubro em Brasília.
    const virada = parseAccountingRange({}, new Date('2026-11-01T01:00:00Z'));
    assert.equal(virada.from, '2026-09-01');
    assert.equal(virada.to, '2026-09-30');
    const janeiro = parseAccountingRange({}, new Date('2027-01-10T12:00:00Z'));
    assert.equal(janeiro.from, '2026-12-01');
    assert.equal(janeiro.to, '2026-12-31');
  });

  it('from/to com as regras da receita, e um mês inválido recusado', () => {
    const r = parseAccountingRange({ from: '2026-01-15', to: '2026-02-10' }, NOW);
    assert.equal(r.startMs, Date.UTC(2026, 0, 15, 3));
    assert.equal(r.endMs, Date.UTC(2026, 1, 11, 3));
    const codigo = (query) => {
      try { parseAccountingRange(query, NOW); } catch (error) { return error.code; }
      return null;
    };
    assert.equal(codigo({ month: '2026-13' }), 'invalid_date');
    assert.equal(codigo({ month: 'outubro' }), 'invalid_date');
    assert.equal(codigo({ from: '2026-02-30', to: '2026-03-01' }), 'invalid_date');
    assert.equal(codigo({ from: '2026-05-01', to: '2026-04-01' }), 'invalid_range');
    assert.equal(codigo({ from: '2020-01-01', to: '2026-01-01' }), 'range_too_long');
  });
});

/** Um mês inteiro (outubro de 2026), sem banco. */
function cenario() {
  const tenants = [
    { id: 1, name: 'Alfa', billing_legal_name: '=Alfa Telecom LTDA', billing_tax_id: '11222333000181' },
    { id: 2, name: 'Beta; "Net"', billing_legal_name: null, billing_tax_id: '12345678909' }
  ];
  const plans = [{ id: 1, name: 'Pro', price_cents: 10000, period_days: 30 }];
  const coupons = [{ id: 5, code: 'PROMO10' }];
  const base = { currency: 'BRL', superseded_charges: null, created_at: '2026-09-25 10:00:00', kind: 'renewal', plan_id: 1 };
  const charges = [
    // Cupom de 10% (base 9000), R$ 10 de excedente, R$ 20 de crédito: 9000 + 1000 − 2000.
    {
      ...base, id: 201, tenant_id: 1, coupon_id: 5, amount_cents: 8000, credit_reserved_cents: 2000, status: 'paid',
      due_date: '2026-10-05', gateway_charge_id: 'pay_201', billing_type: 'UNDEFINED',
      pricing_detail: JSON.stringify({ base: 9000, overage: [{ resource: 'devices', peak: 110, limit: 100, unitCents: 100, units: 10, cents: 1000 }] })
    },
    // Valor mudado à mão pelo console: 10000 → 7000.
    {
      ...base, id: 202, tenant_id: 2, amount_cents: 7000, status: 'pending', due_date: '2026-10-20',
      gateway_charge_id: 'pay_202', billing_type: 'CREDIT_CARD', amount_overridden_at: '2026-10-01 10:00:00',
      pricing_detail: JSON.stringify({ base: 10000, overage: [] })
    },
    // Paga no cartão e estornada; linha de antes da conta (sem `pricing_detail`).
    { ...base, id: 203, tenant_id: 1, plan_id: null, amount_cents: 10000, status: 'refunded', due_date: '2026-10-10', gateway_charge_id: 'pay_203' },
    // Cancelada: aparece, mas fora dos totais.
    { ...base, id: 204, tenant_id: 2, amount_cents: 10000, status: 'canceled', due_date: '2026-10-15', gateway_charge_id: 'pay_204' },
    // Fora da competência (vence em setembro e em novembro).
    { ...base, id: 205, tenant_id: 2, amount_cents: 5000, status: 'paid', due_date: '2026-09-30', gateway_charge_id: 'pay_205' },
    { ...base, id: 206, tenant_id: 1, amount_cents: 10000, status: 'pending', due_date: '2026-11-01', gateway_charge_id: 'pay_206' },
    // De um provedor fora da lista.
    { ...base, id: 207, tenant_id: 99, amount_cents: 10000, status: 'paid', due_date: '2026-10-05', gateway_charge_id: 'pay_207' }
  ];
  const evento = (tenantId, type, externalId, amount, createdAt, detail = null, provider = 'asaas') => ({
    tenant_id: tenantId, type, external_id: externalId, amount_cents: amount, created_at: createdAt, provider,
    detail: detail === null ? null : JSON.stringify(detail)
  });
  const PAGO = BILLING_EVENT_TYPES.PAYMENT_RECORDED;
  const events = [
    evento(1, PAGO, 'pay_201', 8000, '2026-10-04 15:00:00', { paymentMethod: 'PIX', paidOn: '2026-10-04', baseCents: 9000, expectedCents: 8000, planId: 1 }),
    evento(1, PAGO, 'pay_201:accepted', 0, '2026-10-04 16:00:00', { planId: 1 }),
    evento(1, PAGO, 'pay_203', 10000, '2026-10-09 12:00:00', { paymentMethod: 'CREDIT_CARD' }),
    evento(1, BILLING_EVENT_TYPES.PAYMENT_REFUNDED, 'pay_203:refund', 10000, '2026-10-20 12:00:00', { reference: 'pay_203' }),
    // 31/10 às 23:30 em Brasília (já 1º de novembro em UTC): é de outubro.
    evento(2, PAGO, 'pay_205', 5000, '2026-11-01 02:30:00', { paymentMethod: 'BOLETO', paidOn: '2026-10-31' }),
    // 30/09 às 23:00 em Brasília (já 1º de outubro em UTC): é de setembro.
    evento(2, PAGO, null, 4000, '2026-10-01 02:00:00', null, 'manual'),
    // De um provedor fora da lista.
    evento(99, PAGO, 'pay_207', 10000, '2026-10-05 12:00:00')
  ];
  const credits = [
    { id: 1, tenant_id: 1, amount_cents: 2000, source: 'referral', reference: 'indicação de Beta', created_at: '2026-10-02 10:00:00', canceled_at: null },
    { id: 2, tenant_id: 2, amount_cents: -500, source: 'manual', reference: 'correção', created_at: '2026-10-03 10:00:00', canceled_at: null },
    { id: 3, tenant_id: 1, amount_cents: 1500, source: 'referral', reference: null, created_at: '2026-08-01 10:00:00', canceled_at: '2026-10-21 10:00:00' }
  ];
  const allocations = [
    { id: 1, tenant_id: 1, credit_id: 1, charge_id: 201, amount_cents: 2000, status: 'consumed', updated_at: '2026-10-04 15:00:00' },
    { id: 2, tenant_id: 1, credit_id: 3, charge_id: 203, amount_cents: 1500, status: 'released', updated_at: '2026-10-20 12:00:00' },
    // Solta por reemissão (a cobrança não foi estornada): não é movimento.
    { id: 3, tenant_id: 2, credit_id: 2, charge_id: 202, amount_cents: 300, status: 'released', updated_at: '2026-10-10 12:00:00' }
  ];
  const invoices = [
    { id: 1, tenant_id: 1, charge_id: 201, status: 'authorized', number: '123', pdf_url: 'https://nf.example/1.pdf', xml_url: null, issued_at: '2026-10-05 10:00:00', created_at: '2026-10-04 15:00:00' },
    { id: 2, tenant_id: 2, charge_id: 205, status: 'error', number: null, pdf_url: null, xml_url: null, issued_at: null, created_at: '2026-09-30 10:00:00' }
  ];
  return {
    tenants, plans, coupons, charges, events, credits, allocations, invoices, subscriptions: [],
    company: { legalName: 'Plataforma SaaS LTDA', taxId: '11.444.777/0001-61' }
  };
}

describe('contabilidade: a montagem', () => {
  const range = parseAccountingRange({ month: '2026-10' }, NOW);
  const exp = buildAccountingExport({ range, now: NOW, ...cenario() });

  it('abre a conta de cada cobrança: bruto − cupom − crédito + ajuste = líquido', () => {
    const porId = new Map(exp.sheets.cobrancas.map((l) => [l.id, l]));
    assert.deepEqual([...porId.keys()], [201, 203, 204, 202]);
    const a = porId.get(201);
    assert.deepEqual(
      [a.grossCents, a.couponDiscountCents, a.creditCents, a.overageCents, a.adjustmentCents, a.netCents],
      [11000, 1000, 2000, 1000, 0, 8000]
    );
    assert.equal(a.coupon, 'PROMO10');
    assert.equal(a.provider, '=Alfa Telecom LTDA');
    assert.equal(a.taxId, '11.222.333/0001-81');
    assert.equal(a.paymentMethod, 'Pix');
    assert.equal(a.paidAtMs, Date.UTC(2026, 9, 4, 15));
    assert.equal(a.invoiceNumber, '123');
    assert.equal(a.kind, 'Renovação');
    const b = porId.get(202);
    assert.deepEqual([b.grossCents, b.adjustmentCents, b.netCents], [10000, -3000, 7000]);
    assert.equal(b.taxId, '123.456.789-09');
    assert.equal(b.provider, 'Beta; "Net"');
    assert.equal(b.billingType, 'Cartão de crédito');
    for (const l of exp.sheets.cobrancas) {
      assert.equal(l.grossCents - l.couponDiscountCents - l.creditCents + l.adjustmentCents, l.netCents, `cobrança ${l.id}`);
    }
    assert.equal(porId.get(203).status, 'Estornada');
    assert.equal(porId.get(203).paymentMethod, 'Cartão de crédito');
  });

  it('a conta sem `pricing_detail` é o próprio valor', () => {
    assert.deepEqual(chargeBreakdown({ amount_cents: 5000 }), {
      grossCents: 5000, couponDiscountCents: 0, creditCents: 0, overageCents: 0, adjustmentCents: 0, netCents: 5000
    });
  });

  it('o extrato do período em Brasília: a borda de 31/10 entra, a de 30/09 não', () => {
    assert.deepEqual(exp.sheets.pagamentos.map((l) => l.amountCents), [8000, 10000, 5000]);
    const borda = exp.sheets.pagamentos.at(-1);
    assert.equal(borda.paidOn, '2026-10-31');
    assert.equal(borda.method, 'Boleto');
    assert.equal(borda.chargeId, 205);
    assert.equal(exp.sheets.estornos.length, 1);
    assert.deepEqual(
      { amount: exp.sheets.estornos[0].amountCents, charge: exp.sheets.estornos[0].chargeId, ref: exp.sheets.estornos[0].reference },
      { amount: 10000, charge: 203, ref: 'pay_203' }
    );
  });

  it('créditos: concessões, cancelamento, consumo e a devolução do estorno', () => {
    const tipos = exp.sheets.creditos.map((l) => [l.type, l.amountCents]);
    assert.deepEqual(tipos, [
      ['Concessão (indicação)', 2000],
      ['Ajuste manual', -500],
      ['Consumo', -2000],
      ['Devolução (estorno)', 1500],
      ['Cancelamento', -1500]
    ]);
    assert.equal(exp.totals.creditsGrantedCents, 1500);
    assert.equal(exp.totals.creditsConsumedCents, 2000);
  });

  it('NFS-e do período, com número, status e link', () => {
    assert.equal(exp.sheets.nfse.length, 1);
    assert.deepEqual(
      [exp.sheets.nfse[0].number, exp.sheets.nfse[0].status, exp.sheets.nfse[0].pdfUrl, exp.sheets.nfse[0].amountCents],
      ['123', 'Emitida', 'https://nf.example/1.pdf', 8000]
    );
    assert.equal(exp.totals.invoicesIssued, 1);
  });

  it('o resumo soma as cobranças sem as canceladas, e bate com o relatório de receita do mesmo período', () => {
    const t = exp.totals;
    assert.equal(t.chargesCount, 3);
    assert.equal(t.canceledCount, 1);
    assert.equal(t.grossCents, 11000 + 10000 + 10000);
    assert.equal(t.couponDiscountCents, 1000);
    assert.equal(t.creditCents, 2000);
    assert.equal(t.overageCents, 1000);
    assert.equal(t.adjustmentCents, -3000);
    assert.equal(t.netCents, 8000 + 7000 + 10000);
    assert.equal(t.receivedCents, 23000);
    assert.equal(t.refundedCents, 10000);
    assert.equal(t.netReceivedCents, 13000);
    const dados = cenario();
    const receita = aggregateRevenue({ range, now: NOW, prices: new Map(), ...dados });
    assert.equal(t.receivedCents, receita.receivedCents);
    assert.equal(t.refundedCents, receita.refundedCents);
    const empresa = exp.sheets.resumo.find((l) => l.label === 'Empresa');
    assert.equal(empresa.value, 'Plataforma SaaS LTDA — 11.444.777/0001-61');
  });
});

describe('contabilidade: os formatos', () => {
  const range = parseAccountingRange({ month: '2026-10' }, NOW);
  const exp = buildAccountingExport({ range, now: NOW, ...cenario() });

  it('CSV brasileiro: BOM, `;`, vírgula decimal, datas dd/mm/aaaa e fórmula neutralizada', () => {
    const csv = toAccountingCsv(exp, 'cobrancas');
    assert.ok(csv.startsWith('﻿Cobrança;Provedor (razão social);CNPJ/CPF;'));
    const linhas = csv.trim().split('\r\n');
    assert.equal(linhas.length, 5);
    assert.ok(linhas[1].startsWith("201;'=Alfa Telecom LTDA;11.222.333/0001-81;Renovação;Pro;Mensal;110,00;PROMO10;10,00;20,00;10,00;0,00;80,00;05/10/2026;Paga;Pix ou boleto;04/10/2026 12:00;Pix;pay_201;123"), linhas[1]);
    // O nome com `;` e aspas vai entre aspas; o ajuste negativo é número, sem apóstrofo.
    const beta = linhas.find((l) => l.startsWith('202;'));
    assert.ok(beta.startsWith('202;"Beta; ""Net""";123.456.789-09;'), beta);
    assert.ok(beta.includes(';-30,00;70,00;20/10/2026;Em aberto;Cartão de crédito;'), beta);
    const pagamentos = toAccountingCsv(exp, 'pagamentos').trim().split('\r\n');
    assert.equal(pagamentos.length, 4);
    assert.ok(pagamentos[3].startsWith('31/10/2026 23:30;31/10/2026;"Beta; ""Net""";123.456.789-09;50,00;Boleto;205;'), pagamentos[3]);
    const resumo = toAccountingCsv(exp, 'resumo');
    assert.ok(resumo.includes('Recebido;230,00\r\n'), resumo);
    assert.throws(() => toAccountingCsv(exp, 'outra'));
  });

  it('XLSX com as seis abas, lido de volta pelo exceljs', async () => {
    const buffer = await toAccountingXlsx(exp);
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.load(buffer);
    assert.deepEqual(livro.worksheets.map((w) => w.name), ['Cobranças', 'Pagamentos', 'Estornos', 'Créditos', 'NFS-e', 'Resumo']);
    const cobrancas = livro.getWorksheet('Cobranças');
    assert.equal(cobrancas.getRow(1).getCell(7).value, 'Valor bruto');
    assert.equal(cobrancas.getRow(2).getCell(1).value, 201);
    // Texto continua texto: a fórmula não vira fórmula.
    assert.equal(cobrancas.getRow(2).getCell(2).value, '=Alfa Telecom LTDA');
    assert.equal(cobrancas.getRow(2).getCell(7).value, 110);
    assert.equal(cobrancas.getRow(2).getCell(7).numFmt, '#,##0.00');
    assert.equal(cobrancas.getRow(2).getCell(14).value.getTime(), Date.UTC(2026, 9, 5));
    const pagamentos = livro.getWorksheet('Pagamentos');
    // A hora de Brasília escrita como está no relógio.
    assert.equal(pagamentos.getRow(2).getCell(1).value.getTime(), Date.UTC(2026, 9, 4, 12));
    assert.equal(pagamentos.rowCount, 4);
    let soma = 0;
    pagamentos.eachRow((row, n) => { if (n > 1) soma += Number(row.getCell(5).value); });
    assert.equal(Math.round(soma * 100), exp.totals.receivedCents);
    const resumo = livro.getWorksheet('Resumo');
    const recebido = resumo.getRows(2, resumo.rowCount - 1).find((r) => r.getCell(1).value === 'Recebido');
    assert.equal(recebido.getCell(2).value, 230);
  });

  it('os anexos: um XLSX, ou seis CSVs', async () => {
    const xlsx = await accountingAttachments(exp, 'xlsx');
    assert.equal(xlsx.length, 1);
    assert.equal(xlsx[0].filename, 'contabilidade-2026-10-01-a-2026-10-31.xlsx');
    assert.ok(Buffer.isBuffer(xlsx[0].content));
    const csvs = await accountingAttachments(exp, 'csv');
    assert.deepEqual(csvs.map((a) => a.filename), [
      'contabilidade-cobrancas-2026-10-01-a-2026-10-31.csv', 'contabilidade-pagamentos-2026-10-01-a-2026-10-31.csv',
      'contabilidade-estornos-2026-10-01-a-2026-10-31.csv', 'contabilidade-creditos-2026-10-01-a-2026-10-31.csv',
      'contabilidade-nfse-2026-10-01-a-2026-10-31.csv', 'contabilidade-resumo-2026-10-01-a-2026-10-31.csv'
    ]);
  });

  it('formata CNPJ e CPF, e deixa o resto como veio', () => {
    assert.equal(formatTaxId('11222333000181'), '11.222.333/0001-81');
    assert.equal(formatTaxId('123.456.789-09'), '123.456.789-09');
    assert.equal(formatTaxId(null), '');
  });
});

describe('e-mail: anexos', () => {
  it('só nome, conteúdo em memória e tipo passam — nunca `path` nem `href`', () => {
    const aceitos = mailAttachments([
      { filename: 'a.csv', content: 'x;y', contentType: 'text/csv' },
      { filename: '../../etc/passwd', path: '/etc/passwd' },
      { filename: 'b.xlsx', content: Buffer.from('zz'), href: 'http://evil.example/' },
      { content: 'sem nome' },
      null
    ]);
    assert.deepEqual(aceitos.map((a) => a.filename), ['a.csv', 'b.xlsx']);
    assert.equal('href' in aceitos[1], false);
    assert.deepEqual(mailAttachments(undefined), []);
  });

  it('o SMTP repassa os anexos ao nodemailer, e quem não manda anexo continua igual', async () => {
    process.env.SMTP_URL = 'smtp://usuario:senha@127.0.0.1:1?ignoreTLS=true';
    process.env.MAIL_FROM = 'Painel <nao-responda@exemplo.test>';
    resetMailTransport();
    try {
      const transporte = mailTransport();
      const enviados = [];
      transporte.transporter.sendMail = async (opcoes) => { enviados.push(opcoes); return {}; };
      assert.equal(await transporte.send({ to: 'a@exemplo.test', subject: 's', text: 't' }), true);
      assert.equal('attachments' in enviados[0], false);
      assert.equal(await transporte.send({
        to: 'a@exemplo.test', subject: 's', text: 't',
        attachments: [{ filename: 'x.csv', content: 'a;b', contentType: 'text/csv', path: '/etc/passwd' }]
      }), true);
      assert.deepEqual(enviados[1].attachments, [{ filename: 'x.csv', content: 'a;b', contentType: 'text/csv' }]);
    } finally {
      delete process.env.SMTP_URL;
      delete process.env.MAIL_FROM;
      resetMailTransport();
    }
  });
});

// ── Com banco ──────────────────────────────────────────────────────────────

let panelUrl;
let token;
let comumToken;
let enviados = [];
let falhar = false;
const sendersOriginais = PlatformAlertService.senders;
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const contabeis = () => getDb()('platform_alerts').where({ event: 'accounting_export' }).orderBy('id');
const perfil = (options = {}) => call(`${panelUrl}/api/platform/settings/profile`, {
  ...options, headers: { ...authHeaders(token), ...(options.headers || {}) }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'contadora', password: 'contadora-senha-1', email: 'contadora@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  const contratado = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { username: 'comum-contabil', password: 'senha-do-comum-1', role: 'admin', email: 'comum-c@exemplo.test' }
  });
  assert.equal(contratado.status, 201, JSON.stringify(contratado.body));
  const entrou = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'comum-contabil', password: 'senha-do-comum-1' }
  });
  comumToken = entrou.body?.data?.token;
  assert.ok(comumToken);
  if (!(await db('tenants').where({ kind: 'platform' }).first())) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  }
  invalidatePlatformProfile();
  PlatformAlertService.senders = {
    whatsapp: async (to, msg) => { enviados.push({ canal: 'whatsapp', to, ...msg }); return true; },
    email: async (to, msg) => { enviados.push({ canal: 'email', to, ...msg }); return !falhar; }
  };

  // Um provedor com uma cobrança paga e uma estornada em março de 2020, longe
  // de qualquer outra linha.
  await db('tenants').insert({
    slug: 'contabil', name: 'Contábil Net', status: 'active', billing_legal_name: 'Contábil Net LTDA', billing_tax_id: '11222333000181'
  });
  const tenant = (await db('tenants').where({ slug: 'contabil' }).first()).id;
  for (const [id, status, periodo] of [['pay_cont_1', 'paid', '2020-03-05'], ['pay_cont_2', 'refunded', '2020-03-15']]) {
    // eslint-disable-next-line no-await-in-loop
    await db('billing_charges').insert({
      tenant_id: tenant, period_end: periodo, amount_cents: 15000, currency: 'BRL', provider: 'asaas',
      gateway_charge_id: id, status, due_date: periodo, kind: 'renewal'
    });
  }
  const pago = (externalId, valor, quando, type = BILLING_EVENT_TYPES.PAYMENT_RECORDED, detail = null) => ({
    tenant_id: tenant, type, amount_cents: valor, currency: 'BRL', provider: 'asaas', external_id: externalId,
    detail: detail ? JSON.stringify(detail) : null, created_at: aoSegundo(quando)
  });
  await db('billing_events').insert([
    pago('pay_cont_1', 15000, Date.UTC(2020, 2, 6, 14), BILLING_EVENT_TYPES.PAYMENT_RECORDED, { paymentMethod: 'PIX' }),
    pago('pay_cont_2', 15000, Date.UTC(2020, 2, 16, 14)),
    pago('pay_cont_2:refund', 15000, Date.UTC(2020, 2, 20, 14), BILLING_EVENT_TYPES.PAYMENT_REFUNDED, { reference: 'pay_cont_2' })
  ]);
});

after(async () => {
  PlatformAlertService.senders = sendersOriginais;
  await stopTestServers();
});

beforeEach(async () => {
  enviados = [];
  falhar = false;
  await getDb()('platform_alerts').del();
  await saveProfile({
    legalName: 'Plataforma SaaS LTDA',
    accounting: { enabled: false, email: null, format: 'xlsx' },
    alerts: { dailyDigest: { enabled: false, hour: 8 }, monthlyReport: { enabled: false, channels: ['whatsapp', 'email'], hour: 8 } }
  });
  invalidatePlatformProfile();
});

describe('contabilidade: com banco', () => {
  it('os totais do banco batem com o relatório de receita do mesmo mês', async () => {
    const exp = await build(parseAccountingRange({ month: '2020-03' }));
    const receita = await buildRevenueReport(parseRange({ from: '2020-03-01', to: '2020-03-31' }));
    assert.equal(exp.totals.receivedCents, 30000);
    assert.equal(exp.totals.receivedCents, receita.receivedCents);
    assert.equal(exp.totals.refundedCents, receita.refundedCents);
    assert.equal(exp.sheets.cobrancas.length, 2);
    assert.equal(exp.sheets.cobrancas[0].provider, 'Contábil Net LTDA');
    assert.equal(exp.sheets.pagamentos[0].method, 'Pix');
  });
});

describe('contabilidade: a rota', () => {
  const baixar = (query, tok = token) => fetch(`${panelUrl}/api/platform/reports/accounting${query}`, {
    headers: tok ? authHeaders(tok) : {}
  });

  it('baixa o XLSX, legível, e fica na trilha', async () => {
    const resposta = await baixar('?month=2020-03&format=xlsx');
    assert.equal(resposta.status, 200);
    assert.match(resposta.headers.get('content-type'), /spreadsheetml/);
    assert.equal(resposta.headers.get('content-disposition'), 'attachment; filename="contabilidade-2020-03-01-a-2020-03-31.xlsx"');
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.load(Buffer.from(await resposta.arrayBuffer()));
    assert.equal(livro.getWorksheet('Cobranças').rowCount, 3);
    const trilha = await getDb()('platform_audit').where({ action: 'platform.accounting_exported' }).orderBy('id', 'desc').first();
    assert.ok(trilha);
    assert.deepEqual(JSON.parse(trilha.detail), { from: '2020-03-01', to: '2020-03-31', format: 'xlsx' });
  });

  it('baixa uma aba em CSV', async () => {
    const resposta = await baixar('?from=2020-03-01&to=2020-03-31&format=csv&sheet=pagamentos');
    assert.equal(resposta.status, 200);
    assert.match(resposta.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    const texto = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await resposta.arrayBuffer());
    assert.ok(texto.startsWith('﻿Registrado em;'));
    assert.ok(texto.includes('06/03/2020 11:00;06/03/2020;Contábil Net LTDA;11.222.333/0001-81;150,00;Pix;'), texto);
  });

  it('recusa formato, aba e período inválidos', async () => {
    for (const [query, code] of [
      ['?format=pdf', 'invalid_format'], ['?format=csv&sheet=x', 'invalid_sheet'], ['?month=2020-13', 'invalid_date'],
      ['?from=2020-05-01&to=2020-04-01', 'invalid_range']
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await baixar(query);
      assert.equal(r.status, 400, query);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await r.json()).code, code, query);
    }
  });

  it('não existe para quem não é do console', async () => {
    assert.equal((await baixar('?month=2020-03', comumToken)).status, 404);
    assert.equal((await baixar('?month=2020-03', null)).status, 401);
    const envio = await call(`${panelUrl}/api/platform/reports/accounting/send`, { method: 'POST', body: {}, headers: authHeaders(comumToken) });
    assert.equal(envio.status, 404);
  });
});

describe('contabilidade: a configuração', () => {
  it('valida e grava `accounting` no perfil', async () => {
    const lido = await perfil();
    assert.deepEqual(lido.body.data.accounting, { enabled: false, email: null, format: 'xlsx' });
    for (const [accounting, code] of [
      [{ enabled: true }, 'email_required'],
      [{ email: 'não é e-mail' }, 'invalid_email'],
      [{ format: 'pdf' }, 'invalid_format'],
      [{ enabled: 'sim' }, undefined],
      ['ligado', undefined]
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await perfil({ method: 'PUT', body: { accounting } });
      assert.equal(r.status, 400, JSON.stringify(accounting));
      assert.equal(r.body.field, 'accounting');
      if (code) assert.equal(r.body.code, code);
    }
    const ok = await perfil({ method: 'PUT', body: { accounting: { enabled: true, email: 'contador@escritorio.test', format: 'csv' } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data.accounting, { enabled: true, email: 'contador@escritorio.test', format: 'csv' });
    assert.ok(ok.body.data.changed.includes('accounting'));
    // Apagar o e-mail com o envio ligado é recusado; desligar e apagar, não.
    const sem = await perfil({ method: 'PUT', body: { accounting: { email: '' } } });
    assert.equal(sem.status, 400);
    const desligado = await perfil({ method: 'PUT', body: { accounting: { enabled: false, email: '' } } });
    assert.equal(desligado.status, 200);
    assert.deepEqual(await accountingConfig(), { enabled: false, email: null, format: 'csv' });
  });
});

describe('contabilidade: enviar agora', () => {
  const enviar = (body = {}) => call(`${panelUrl}/api/platform/reports/accounting/send`, {
    method: 'POST', body, headers: authHeaders(token)
  });

  it('sem e-mail do contador é 409', async () => {
    const r = await enviar();
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'no_destination');
  });

  it('manda o mês pedido com o anexo, mesmo desligado, e fica na trilha sem o e-mail', async () => {
    await saveProfile({ accounting: { email: 'contador@escritorio.test', format: 'xlsx' } });
    const r = await enviar({ month: '2020-03' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data, { month: '2020-03', format: 'xlsx' });
    assert.equal(enviados.length, 1);
    const [email] = enviados;
    assert.equal(email.canal, 'email');
    assert.equal(email.to, 'contador@escritorio.test');
    assert.match(email.subject, /^Exportação contábil: março de 2020/);
    assert.match(email.text, /Recebido: R\$\s?300,00/);
    assert.equal(email.attachments.length, 1);
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.load(email.attachments[0].content);
    assert.equal(livro.getWorksheet('Pagamentos').rowCount, 3);
    const [linha] = await contabeis();
    assert.equal(linha.status, 'sent');
    const trilha = await getDb()('platform_audit').where({ action: 'platform.accounting_sent' }).orderBy('id', 'desc').first();
    assert.ok(trilha);
    assert.equal(trilha.detail.includes('contador@'), false);
    // A passada do agendador não a manda de novo.
    enviados = [];
    await PlatformAlertService.processDue({ now: new Date(Date.now() + 24 * 3600_000) });
    assert.equal(enviados.length, 0);
  });

  it('em CSV vão as seis abas; a falha é 502; mês inválido é 400', async () => {
    await saveProfile({ accounting: { email: 'contador@escritorio.test', format: 'csv' } });
    const r = await enviar({ month: '2020-03' });
    assert.equal(r.status, 200);
    assert.equal(enviados[0].attachments.length, 6);
    assert.ok(enviados[0].attachments.every((a) => a.filename.endsWith('.csv')));
    falhar = true;
    const falhou = await enviar({ month: '2020-03' });
    assert.equal(falhou.status, 502);
    assert.equal(falhou.body.code, 'send_failed');
    assert.equal((await contabeis()).at(-1).status, 'failed');
    const ruim = await enviar({ month: '03/2020' });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.code, 'invalid_date');
  });
});

describe('contabilidade: o envio mensal', () => {
  // 1º de novembro de 2026, 08:00 em Brasília.
  const OITO = new Date('2026-11-01T11:00:00Z');
  const ligar = async (extra = {}) => {
    await saveProfile({ accounting: { enabled: true, email: 'contador@escritorio.test', format: 'xlsx', ...extra } });
    invalidatePlatformProfile();
  };

  it('desligado não enfileira', async () => {
    const r = await PlatformAlertService.checkAccountingExport({ now: OITO });
    assert.equal(r.reason, 'disabled');
    assert.equal((await contabeis()).length, 0);
  });

  it('UMA linha por mês, à hora do relatório mensal, mesmo com duas passadas e dois processos', async () => {
    await ligar();
    const cedo = await PlatformAlertService.checkAccountingExport({ now: new Date('2026-11-01T10:59:59Z') });
    assert.equal(cedo.reason, 'waiting');
    const [a, b] = await Promise.all([
      PlatformAlertService.checkAccountingExport({ now: OITO }),
      PlatformAlertService.checkAccountingExport({ now: OITO })
    ]);
    assert.equal([a, b].filter((x) => x.enqueued).length, 1);
    const linhas = await contabeis();
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].dedupe_key, 'accounting:2026-10');
    const quatro = await PlatformAlertService.checkAccountingExport({ now: new Date('2026-11-04T12:00:00Z') });
    assert.equal(quatro.reason, 'outside_window');
  });

  it('a passada manda uma vez, por e-mail com o anexo — fora do resumo diário', async () => {
    await saveProfile({ alerts: { dailyDigest: { enabled: true, hour: 23 } } });
    await ligar();
    const r = await PlatformAlertService.schedulerPass({ now: OITO });
    assert.equal(r.accounting.enqueued, true);
    assert.equal(r.send.accounting.sent, 1);
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].to, 'contador@escritorio.test');
    assert.equal(enviados[0].attachments[0].filename, 'contabilidade-2026-10-01-a-2026-10-31.xlsx');
    const [linha] = await contabeis();
    assert.equal(linha.status, 'sent');
    enviados = [];
    await PlatformAlertService.schedulerPass({ now: new Date(OITO.getTime() + 3600_000) });
    await PlatformAlertService.schedulerPass({ now: new Date('2026-11-02T12:00:00Z') });
    assert.equal(enviados.length, 0);
    assert.equal((await contabeis()).length, 1);
  });

  it('a falha tenta de novo com espera; desligado depois de enfileirado vira skipped', async () => {
    await ligar();
    falhar = true;
    await PlatformAlertService.schedulerPass({ now: OITO });
    let [linha] = await contabeis();
    assert.equal(linha.status, 'pending');
    assert.equal(Number(linha.attempts), 1);
    await saveProfile({ accounting: { enabled: false } });
    await PlatformAlertService.processDue({ now: new Date(OITO.getTime() + 3600_000) });
    [linha] = await contabeis();
    assert.equal(linha.status, 'skipped');
    assert.equal(linha.last_error, 'disabled');
  });

  it('aparece no histórico com o mês por extenso', async () => {
    await ligar();
    await PlatformAlertService.checkAccountingExport({ now: OITO });
    const historico = await PlatformAlertService.history({ event: 'accounting_export' });
    assert.equal(historico.total, 1);
    assert.equal(historico.alerts[0].summary, 'Exportação contábil: outubro de 2026');
  });
});
