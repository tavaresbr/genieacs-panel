import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * As métricas mês a mês do console (aba Receita) e o relatório mensal
 * automático (`monthly_report` na fila `platform_alerts`).
 *
 * A soma (`aggregateMonthly`) é pura e é nela que se fixam as decisões: o
 * mês de Brasília, o anual normalizado, o estorno no líquido e no MRR, o
 * churn e a inadimplência no fim do mês. As rotas e o relatório são provados
 * no app de verdade (edição SaaS), com os canais trocados por funções que
 * só anotam, como em `platform-alerts.test.js`.
 *
 * Datas ao segundo: o MySQL guarda ao segundo e ARREDONDA os milissegundos.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { BILLING_EVENT_TYPES } = await import('../src/models/BillingEvent.js');
const {
  aggregateMonthly, mesSp, mesesAte, parseMonths, monthly, MAX_MONTHS
} = await import('../src/services/platformMetricsService.js');
const { default: PlatformAlertService } = await import('../src/services/platformAlertService.js');
const { saveProfile, invalidatePlatformProfile, alertsConfig } = await import('../src/services/platformProfileService.js');

const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);

describe('métricas: meses de Brasília e o parâmetro', () => {
  it('a meia-noite de Brasília separa os meses (03:00 UTC)', () => {
    assert.equal(mesSp(Date.parse('2026-02-01T02:59:59Z')), '2026-01');
    assert.equal(mesSp(Date.parse('2026-02-01T03:00:00Z')), '2026-02');
    const [jan, fev] = mesesAte(new Date('2026-02-10T12:00:00Z'), 2);
    assert.equal(jan.month, '2026-01');
    assert.equal(jan.endMs, Date.parse('2026-02-01T03:00:00Z'));
    assert.equal(fev.startMs, jan.endMs);
    assert.equal(jan.nextFirstDay, '2026-02-01');
    // O antigo horário de verão (-02:00): o mês começava às 02:00 UTC.
    const [dez] = mesesAte(new Date('2018-12-15T12:00:00Z'), 1);
    assert.equal(dez.startMs, Date.parse('2018-12-01T02:00:00Z'));
  });

  it('months: padrão 12, inteiro de 1 a 24, ou invalid_months', () => {
    assert.equal(parseMonths(undefined), 12);
    assert.equal(parseMonths(''), 12);
    assert.equal(parseMonths('1'), 1);
    assert.equal(parseMonths('24'), MAX_MONTHS);
    for (const ruim of ['0', '25', 'abc', '1.5', '-3', '12a']) {
      assert.throws(() => parseMonths(ruim), (e) => e.code === 'invalid_months' && e.status === 400, ruim);
    }
  });
});

/** Um cenário inteiro, sem banco. "Agora" é 15 de abril de 2026. */
function cenario() {
  const NOW = new Date('2026-04-15T12:00:00Z');
  const plans = [
    { id: 1, name: 'Pro', price_cents: 10000, period_days: 30 },
    { id: 2, name: 'Anual', price_cents: 12000, price_yearly_cents: 120000, period_days: 30 }
  ];
  const tenants = [
    { id: 1, name: 'Um', created_at: '2025-10-01 12:00:00' },
    { id: 2, name: 'Dois', created_at: '2026-01-15 12:00:00' },
    // A virada de janeiro para fevereiro em Brasília: um segundo antes, e na hora.
    { id: 3, name: 'Três', created_at: new Date('2026-02-01T03:00:00Z') },
    { id: 4, name: 'Quatro', created_at: new Date('2026-02-01T02:59:59Z') }
  ];
  const futuro = new Date('2026-05-10T00:00:00Z');
  const subscriptions = [
    { id: 11, tenant_id: 1, plan_id: 1, status: 'active', billing_cycle: 'monthly', renews_at: futuro },
    { id: 12, tenant_id: 2, plan_id: 2, status: 'active', billing_cycle: 'annual', renews_at: new Date('2027-02-01T03:00:00Z') },
    { id: 13, tenant_id: 3, plan_id: 1, status: 'canceled', billing_cycle: 'monthly', canceled_at: '2026-03-05 12:00:00' },
    { id: 14, tenant_id: 4, plan_id: 1, status: 'canceled', billing_cycle: 'monthly', canceled_at: '2026-03-02 12:00:00' }
  ];
  const prices = new Map([[11, 10000], [12, 120000], [13, 10000], [14, 10000]]);
  const pago = (tenantId, externalId, amount, createdAt, detail = null) => ({
    tenant_id: tenantId, type: BILLING_EVENT_TYPES.PAYMENT_RECORDED, external_id: externalId, amount_cents: amount,
    created_at: createdAt, detail: detail === null ? null : JSON.stringify(detail)
  });
  const events = [
    // O mensal do provedor 1: dez, jan, fev, mar (estornado), abr.
    pago(1, 'p1_dez', 10000, '2025-12-10 12:00:00', { planId: 1, baseCents: 10000, renewsAt: '2026-01-10T12:00:00.000Z' }),
    pago(1, 'p1_jan', 10000, '2026-01-10 12:00:00', { planId: 1, baseCents: 10000, renewsAt: '2026-02-10T12:00:00.000Z' }),
    pago(1, 'p1_fev', 10000, '2026-02-10 12:00:00', { planId: 1, baseCents: 10000, renewsAt: '2026-03-10T12:00:00.000Z' }),
    pago(1, 'p1_mar', 10000, '2026-03-10 12:00:00', { planId: 1, baseCents: 10000, renewsAt: '2026-04-10T12:00:00.000Z' }),
    {
      tenant_id: 1, type: BILLING_EVENT_TYPES.PAYMENT_REFUNDED, external_id: 'p1_mar:refund', amount_cents: 10000,
      created_at: '2026-03-20 12:00:00', detail: JSON.stringify({ reference: 'p1_mar' })
    },
    pago(1, 'p1_abr', 10000, '2026-04-10 12:00:00', { planId: 1, baseCents: 10000, renewsAt: '2026-05-10T12:00:00.000Z' }),
    // O anual do provedor 2, às 23:59:59 do dia 31 em Brasília: é de janeiro.
    pago(2, 'p2_ano', 120000, new Date('2026-02-01T02:59:59Z'), {
      planId: 2, billingCycle: 'annual', baseCents: 120000, renewsAt: '2027-02-01T03:00:00.000Z'
    }),
    // Uma pró-rata paga atrasada: entra no recebido, não no MRR.
    pago(2, 'p2_late', 5000, '2026-02-15 12:00:00', { planId: 2, proration: true }),
    // O provedor 4 paga à meia-noite de fevereiro em Brasília (fevereiro), e cancela em março.
    pago(4, 'p4_fev', 10000, new Date('2026-02-01T03:00:00Z'), { planId: 1, expectedCents: 10000, renewsAt: '2026-03-05T00:00:00.000Z' }),
    { tenant_id: 4, type: BILLING_EVENT_TYPES.STATUS_CHANGED, created_at: '2026-03-02 12:00:00', detail: JSON.stringify({ from: 'active', to: 'canceled' }) },
    // O provedor 3 (em teste) cancela em março — e um provedor de fora não conta.
    { tenant_id: 3, type: BILLING_EVENT_TYPES.STATUS_CHANGED, created_at: '2026-03-05 12:00:00', detail: JSON.stringify({ from: 'trial', to: 'canceled' }) },
    pago(99, 'x', 77700, '2026-02-10 12:00:00')
  ];
  const base = { currency: 'BRL', superseded_charges: null, subscription_id: null };
  const charges = [
    // Venceu em janeiro, paga em 15 de fevereiro: inadimplente no fim de janeiro só.
    { ...base, id: 1, tenant_id: 2, amount_cents: 5000, status: 'paid', gateway_charge_id: 'p2_late', due_date: '2026-01-20', created_at: '2026-01-05 12:00:00', updated_at: '2026-02-15 12:00:00' },
    // Cancelada em 15 de março, vencida em fevereiro: inadimplente no fim de fevereiro.
    { ...base, id: 2, tenant_id: 3, amount_cents: 10000, status: 'canceled', gateway_charge_id: 'c3', due_date: '2026-02-10', created_at: '2026-02-01 12:00:00', updated_at: '2026-03-15 12:00:00' },
    // Aberta e vencida em março: no fim de março e agora.
    { ...base, id: 3, tenant_id: 1, amount_cents: 10000, status: 'overdue', gateway_charge_id: 'c1', due_date: '2026-03-25', created_at: '2026-03-01 12:00:00', updated_at: '2026-03-26 12:00:00' },
    // Vence no fim do mês: não está vencida no fim de março.
    { ...base, id: 4, tenant_id: 1, amount_cents: 7000, status: 'pending', gateway_charge_id: 'c1b', due_date: '2026-04-01', created_at: '2026-03-01 12:00:00', updated_at: '2026-03-01 12:00:00' }
  ];
  return { NOW, plans, tenants, subscriptions, prices, events, charges };
}

describe('métricas: a soma', () => {
  const { NOW, ...dados } = cenario();
  const r = aggregateMonthly({ months: 4, now: NOW, ...dados });
  const mes = (m) => r.months.find((x) => x.month === m);

  it('quatro meses, do mais antigo ao atual, em BRL', () => {
    assert.deepEqual(r.months.map((m) => m.month), ['2026-01', '2026-02', '2026-03', '2026-04']);
    assert.equal(r.currency, 'BRL');
    assert.equal(mes('2026-04').current, true);
    assert.equal(mes('2026-04').mrrApproximate, false);
    assert.equal(mes('2026-03').mrrApproximate, true);
  });

  it('recebido pelo mês de Brasília, líquido do estorno', () => {
    // Janeiro: o mensal + o anual pago às 23:59:59 do dia 31.
    assert.equal(mes('2026-01').receivedCents, 130000);
    // Fevereiro: o mensal, o provedor 4 à meia-noite e a pró-rata.
    assert.equal(mes('2026-02').receivedCents, 25000);
    assert.equal(mes('2026-02').payments, 3);
    // Março: pago e estornado no mesmo mês.
    assert.equal(mes('2026-03').grossCents, 10000);
    assert.equal(mes('2026-03').refundedCents, 10000);
    assert.equal(mes('2026-03').receivedCents, 0);
  });

  it('MRR: o anual normalizado, o estornado e o cancelado de fora', () => {
    const anual = Math.round((120000 * 30) / 365);
    assert.equal(mes('2026-01').mrrCents, 10000 + anual);
    assert.equal(mes('2026-01').payingCount, 2);
    assert.equal(mes('2026-02').mrrCents, 20000 + anual);
    assert.equal(mes('2026-02').payingCount, 3);
    // Março: o pagamento do 1 voltou, o 4 cancelou — só o anual.
    assert.equal(mes('2026-03').mrrCents, anual);
    assert.equal(mes('2026-03').payingCount, 1);
    // Abril (agora): a foto do relatório de receita.
    assert.equal(mes('2026-04').mrrCents, 10000 + anual);
    assert.equal(mes('2026-04').payingCount, 2);
  });

  it('novos, cancelados e churn', () => {
    assert.equal(mes('2026-01').newTenants, 2);
    assert.equal(mes('2026-02').newTenants, 1);
    assert.equal(mes('2026-03').canceledTenants, 2);
    // Sobre os 3 pagantes do fim de fevereiro.
    assert.equal(mes('2026-03').churnRate, 0.6667);
    assert.equal(mes('2026-02').churnRate, 0);
    // Janeiro divide pelo pagante do fim de dezembro (o mês escondido).
    assert.equal(mes('2026-01').churnRate, 0);
  });

  it('inadimplência no fim de cada mês', () => {
    assert.deepEqual(
      ['2026-01', '2026-02', '2026-03'].map((m) => [mes(m).overdueCents, mes(m).overdueCount, mes(m).overdueTenants]),
      [[5000, 1, 1], [10000, 1, 1], [10000, 1, 1]]
    );
    // Agora: só a vencida (a de 1º de abril também já venceu em 15 de abril).
    assert.equal(mes('2026-04').overdueCents, 17000);
    assert.equal(mes('2026-04').overdueCount, 2);
    assert.equal(mes('2026-04').overdueTenants, 1);
  });

  it('receita por plano do último mês', () => {
    assert.equal(r.revenueByPlanMonth, '2026-04');
    const pro = r.revenueByPlan.find((l) => l.planId === 1);
    const anual = r.revenueByPlan.find((l) => l.planId === 2);
    assert.deepEqual(pro, { planId: 1, name: 'Pro', receivedCents: 10000, mrrCents: 10000, payingCount: 1 });
    assert.equal(anual.receivedCents, 0);
    assert.equal(anual.mrrCents, Math.round((120000 * 30) / 365));
  });
});

// ── O app de verdade: a rota, o relatório mensal e o envio manual ─────────

let panelUrl;
let token;
let comumToken;
let enviados = [];
let falhar = { whatsapp: false, email: false };
const sendersOriginais = PlatformAlertService.senders;

const perfil = (options = {}) => call(`${panelUrl}/api/platform/settings/profile`, {
  ...options, headers: { ...authHeaders(token), ...(options.headers || {}) }
});
const mensais = () => getDb()('platform_alerts').where({ event: 'monthly_report' }).orderBy('id');

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'metricas', password: 'metricas-senha-1', email: 'metricas@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  const contratado = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { username: 'comum-metricas', password: 'senha-do-comum-1', role: 'admin', email: 'comum-m@exemplo.test' }
  });
  assert.equal(contratado.status, 201, JSON.stringify(contratado.body));
  const entrou = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'comum-metricas', password: 'senha-do-comum-1' }
  });
  comumToken = entrou.body?.data?.token;
  assert.ok(comumToken);
  await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  invalidatePlatformProfile();
  PlatformAlertService.senders = {
    whatsapp: async (to, msg) => { enviados.push({ canal: 'whatsapp', to, ...msg }); return !falhar.whatsapp; },
    email: async (to, msg) => { enviados.push({ canal: 'email', to, ...msg }); return !falhar.email; }
  };
});

after(async () => {
  PlatformAlertService.senders = sendersOriginais;
  await stopTestServers();
});

beforeEach(async () => {
  enviados = [];
  falhar = { whatsapp: false, email: false };
  await getDb()('platform_alerts').del();
  await saveProfile({
    notifyWhatsapp: '93991935695',
    notifyEmail: 'ops@plataforma.test',
    alerts: { dailyDigest: { enabled: false, hour: 8 }, monthlyReport: { enabled: false, channels: ['whatsapp', 'email'], hour: 8 } }
  });
  invalidatePlatformProfile();
});

describe('métricas: a rota', () => {
  const consulta = (caminho, tok) => call(`${panelUrl}/api/platform${caminho}`, { headers: tok ? authHeaders(tok) : {} });

  it('responde a série do banco, com o pagamento no mês de Brasília (ao segundo)', async () => {
    const db = getDb();
    await db('tenants').insert({ slug: 'metrica-um', name: 'Métrica Um', status: 'active' });
    const tenant = await db('tenants').where({ slug: 'metrica-um' }).first();
    // Um segundo antes da meia-noite de Brasília que abriu o mês corrente: é do mês anterior.
    const [anterior, atual] = mesesAte(new Date(), 2);
    await db('billing_events').insert({
      tenant_id: tenant.id, type: BILLING_EVENT_TYPES.PAYMENT_RECORDED, amount_cents: 4321, currency: 'BRL',
      provider: 'manual', external_id: 'metrica-borda', created_at: aoSegundo(atual.startMs - 1000)
    });
    const resposta = await consulta('/metrics/monthly?months=2', token);
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const dados = resposta.body.data;
    assert.equal(dados.months.length, 2);
    assert.equal(dados.currency, 'BRL');
    assert.equal(dados.months[0].month, anterior.month);
    assert.equal(dados.months[0].receivedCents, 4321);
    assert.equal(dados.months[1].receivedCents, 0);
    const padrao = await consulta('/metrics/monthly', token);
    assert.equal(padrao.body.data.months.length, 12);
    // A mesma conta da função, sem a rota.
    const direto = await monthly({ months: 2 });
    assert.equal(direto.months[0].receivedCents, 4321);
  });

  it('a cobrança velha paga há pouco ainda conta (a leitura é limitada, o número não muda)', async () => {
    const db = getDb();
    await db('tenants').insert({ slug: 'metrica-velha', name: 'Métrica Velha', status: 'active' });
    const tenant = await db('tenants').where({ slug: 'metrica-velha' }).first();
    const antes = await monthly({ months: 2 });
    const tresAnos = aoSegundo(Date.now() - 3 * 365 * 24 * 3600_000);
    const base = { tenant_id: tenant.id, currency: 'BRL', provider: 'manual', due_date: tresAnos, created_at: tresAnos };
    // Vencida há três anos e paga AGORA: no fim do mês passado ela devia.
    await db('billing_charges').insert({ ...base, period_end: '2023-01-01', amount_cents: 3333, status: 'paid', updated_at: aoSegundo(Date.now()) });
    // Vencida e paga há três anos: fora da leitura, e fora de qualquer mês da janela.
    await db('billing_charges').insert({ ...base, period_end: '2023-02-01', amount_cents: 7777, status: 'paid', updated_at: tresAnos });
    const depois = await monthly({ months: 2 });
    assert.equal(depois.months[0].overdueCents - antes.months[0].overdueCents, 3333);
    assert.equal(depois.months[1].overdueCents, antes.months[1].overdueCents);
    await db('billing_charges').where({ tenant_id: tenant.id }).del();
  });

  it('400 invalid_months fora de 1..24', async () => {
    for (const ruim of ['0', '25', 'doze']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await consulta(`/metrics/monthly?months=${ruim}`, token);
      assert.equal(r.status, 400, ruim);
      assert.equal(r.body.code, 'invalid_months');
    }
  });

  it('não existe para quem não é do console, nem sem sessão', async () => {
    for (const [metodo, caminho] of [['GET', '/metrics/monthly'], ['POST', '/metrics/monthly-report/send']]) {
      // eslint-disable-next-line no-await-in-loop
      const comum = await call(`${panelUrl}/api/platform${caminho}`, { method: metodo, body: metodo === 'POST' ? {} : undefined, headers: authHeaders(comumToken) });
      assert.equal(comum.status, 404, caminho);
      // eslint-disable-next-line no-await-in-loop
      const anonimo = await call(`${panelUrl}/api/platform${caminho}`, { method: metodo, body: metodo === 'POST' ? {} : undefined });
      assert.equal(anonimo.status, 401, caminho);
    }
    assert.equal(enviados.length, 0);
  });
});

describe('relatório mensal: a configuração', () => {
  it('vem desligada, com os dois canais e às 8h, e grava pelo PUT', async () => {
    const lido = await perfil();
    assert.deepEqual(lido.body.data.alerts.monthlyReport, { enabled: false, channels: ['whatsapp', 'email'], hour: 8 });
    const put = await perfil({ method: 'PUT', body: { alerts: { monthlyReport: { enabled: true, channels: ['email'], hour: 9 } } } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.data.alerts.monthlyReport, { enabled: true, channels: ['email'], hour: 9 });
    // O que não veio fica como estava.
    const parcial = await perfil({ method: 'PUT', body: { alerts: { monthlyReport: { hour: 7 } } } });
    assert.deepEqual(parcial.body.data.alerts.monthlyReport, { enabled: true, channels: ['email'], hour: 7 });
  });

  it('recusa o inválido', async () => {
    for (const monthlyReport of [
      'sim', [], { enabled: 'sim' }, { channels: ['sms'] }, { channels: 'email' }, { hour: 24 }, { hour: 7.5 },
      { enabled: true, channels: [] }
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await perfil({ method: 'PUT', body: { alerts: { monthlyReport } } });
      assert.equal(r.status, 400, JSON.stringify(monthlyReport));
      assert.equal(r.body.field, 'monthlyReport');
    }
  });

  it('ligado nunca fica sem canal: nem tirando os canais, nem ligando o que ficou sem', async () => {
    const ligado = await perfil({ method: 'PUT', body: { alerts: { monthlyReport: { enabled: true, channels: ['email'] } } } });
    assert.equal(ligado.status, 200);
    const semCanal = await perfil({ method: 'PUT', body: { alerts: { monthlyReport: { channels: [] } } } });
    assert.equal(semCanal.status, 400);
    assert.equal(semCanal.body.field, 'monthlyReport');
    // Desligado e sem canal pode; ligar depois, sem canal, não.
    const desligado = await perfil({ method: 'PUT', body: { alerts: { monthlyReport: { enabled: false, channels: [] } } } });
    assert.equal(desligado.status, 200);
    const religar = await perfil({ method: 'PUT', body: { alerts: { monthlyReport: { enabled: true } } } });
    assert.equal(religar.status, 400);
    assert.equal(religar.body.field, 'monthlyReport');
    assert.deepEqual((await perfil()).body.data.alerts.monthlyReport.channels, []);
  });
});

describe('relatório mensal: o agendador', () => {
  const ligar = async (extra = {}) => {
    await saveProfile({ alerts: { monthlyReport: { enabled: true, channels: ['whatsapp', 'email'], hour: 8, ...extra } } });
    invalidatePlatformProfile();
  };
  // 1º de novembro de 2026, 08:00 em Brasília.
  const OITO = new Date('2026-11-01T11:00:00Z');

  it('desligado não enfileira', async () => {
    const r = await PlatformAlertService.checkMonthlyReport({ now: OITO });
    assert.equal(r.reason, 'disabled');
    assert.equal((await mensais()).length, 0);
  });

  it('no dia 1º, a partir da hora, UMA linha por mês — mesmo com duas passadas e dois processos', async () => {
    await ligar();
    const cedo = await PlatformAlertService.checkMonthlyReport({ now: new Date('2026-11-01T10:59:59Z') });
    assert.equal(cedo.reason, 'waiting');
    const [a, b] = await Promise.all([
      PlatformAlertService.checkMonthlyReport({ now: OITO }),
      PlatformAlertService.checkMonthlyReport({ now: OITO })
    ]);
    assert.equal([a, b].filter((x) => x.enqueued).length, 1);
    const depois = await PlatformAlertService.checkMonthlyReport({ now: new Date('2026-11-02T15:00:00Z') });
    assert.equal(depois.reason, 'duplicate');
    const linhas = await mensais();
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].dedupe_key, 'monthly:2026-10');
    assert.deepEqual(JSON.parse(linhas[0].payload), { month: '2026-10' });
  });

  it('recupera nos dias 2 e 3, e não depois', async () => {
    await ligar();
    const quatro = await PlatformAlertService.checkMonthlyReport({ now: new Date('2026-11-04T12:00:00Z') });
    assert.equal(quatro.reason, 'outside_window');
    // Dia 3 às 00:30 de Brasília (antes da hora, mas o 1º já passou).
    const tres = await PlatformAlertService.checkMonthlyReport({ now: new Date('2026-11-03T03:30:00Z') });
    assert.equal(tres.enqueued, true);
    assert.equal(tres.month, '2026-10');
    // A virada do ano: o 1º de janeiro fala de dezembro.
    const ano = await PlatformAlertService.checkMonthlyReport({ now: new Date('2027-01-01T12:00:00Z') });
    assert.equal(ano.month, '2026-12');
  });

  it('a passada manda pelos canais da configuração, com HTML no e-mail, uma vez', async () => {
    await ligar({ channels: ['email'] });
    const r = await PlatformAlertService.schedulerPass({ now: OITO });
    assert.equal(r.monthlyReport.enqueued, true);
    assert.equal(r.send.monthly.sent, 1);
    assert.equal(enviados.length, 1);
    const [email] = enviados;
    assert.equal(email.canal, 'email');
    assert.equal(email.to, 'ops@plataforma.test');
    assert.match(email.subject, /^Relatório mensal: outubro de 2026/);
    assert.match(email.text, /MRR: R\$/);
    assert.match(email.text, /Churn: /);
    assert.match(email.html, /<table/);
    const [linha] = await mensais();
    assert.equal(linha.status, 'sent');
    enviados = [];
    await PlatformAlertService.schedulerPass({ now: new Date(OITO.getTime() + 3600_000) });
    assert.equal(enviados.length, 0);
  });

  it('com o resumo diário ligado, o relatório sai sozinho e não entra no resumo', async () => {
    await saveProfile({ alerts: { dailyDigest: { enabled: true, hour: 23 } } });
    await ligar({ channels: ['whatsapp'] });
    const r = await PlatformAlertService.schedulerPass({ now: OITO });
    assert.equal(r.send.monthly.sent, 1);
    assert.deepEqual(enviados.map((e) => e.canal), ['whatsapp']);
    const [linha] = await mensais();
    assert.equal(linha.status, 'sent');
  });

  it('a falha tenta de novo com espera, como qualquer alerta', async () => {
    await ligar();
    falhar = { whatsapp: true, email: true };
    await PlatformAlertService.schedulerPass({ now: OITO });
    const [linha] = await mensais();
    assert.equal(linha.status, 'pending');
    assert.equal(Number(linha.attempts), 1);
    assert.ok(linha.next_attempt_at);
  });

  it('desligado depois de enfileirado vira skipped', async () => {
    await ligar();
    await PlatformAlertService.checkMonthlyReport({ now: OITO });
    await saveProfile({ alerts: { monthlyReport: { enabled: false } } });
    invalidatePlatformProfile();
    await PlatformAlertService.processDue({ now: OITO });
    const [linha] = await mensais();
    assert.equal(linha.status, 'skipped');
    assert.equal(enviados.length, 0);
    assert.equal((await alertsConfig()).monthlyReport.enabled, false);
  });
});

describe('relatório mensal: enviar agora', () => {
  const enviar = (body) => call(`${panelUrl}/api/platform/metrics/monthly-report/send`, {
    method: 'POST', body, headers: authHeaders(token)
  });

  it('manda o mês anterior agora, mesmo desligado e já enviado, e fica na trilha', async () => {
    const res = await enviar({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.channels, { whatsapp: true, email: true });
    assert.match(res.body.data.month, /^\d{4}-\d{2}$/);
    assert.deepEqual(enviados.map((e) => e.canal).sort(), ['email', 'whatsapp']);
    // De novo: fora da deduplicação do agendador.
    const outra = await enviar({ channels: ['email'] });
    assert.equal(outra.status, 200);
    assert.equal((await mensais()).length, 2);
    const trilha = await getDb()('platform_audit').where({ action: 'platform.monthly_report_sent' }).orderBy('id', 'desc').first();
    assert.ok(trilha);
    assert.equal(JSON.parse(trilha.detail).month, res.body.data.month);
    assert.equal(trilha.detail.includes('ops@plataforma.test'), false, 'o destino não vai para a trilha');
    // A passada do agendador não as manda de novo.
    enviados = [];
    await PlatformAlertService.processDue({ now: new Date(Date.now() + 24 * 3600_000) });
    assert.equal(enviados.length, 0);
  });

  it('o "Enviar agora" que o processo largou no meio não sai de novo pela passada', async () => {
    await saveProfile({ alerts: { monthlyReport: { enabled: true, channels: ['whatsapp', 'email'], hour: 8 } } });
    invalidatePlatformProfile();
    // A linha como o botão a grava, com a garra já vencida: o processo caiu
    // depois de gravá-la — e talvez depois de mandar.
    const agora = aoSegundo(Date.now());
    await getDb()('platform_alerts').insert({
      event: 'monthly_report', tenant_id: null, payload: JSON.stringify({ month: '2026-09', manual: true }),
      dedupe_key: 'monthly:2026-09:manual:caiu', status: 'pending', attempts: 0,
      next_attempt_at: new Date(agora.getTime() - 60_000), created_at: agora
    });
    const r = await PlatformAlertService.processDue({ now: new Date(agora.getTime() + 1000) });
    assert.equal(r.monthly.failed, 1);
    assert.equal(enviados.length, 0);
    const [linha] = await mensais();
    assert.equal(linha.status, 'failed');
    assert.equal(linha.last_error, 'interrupted');
  });

  it('sem destino é 409; canal inválido é 400; falha é 502', async () => {
    await saveProfile({ notifyWhatsapp: '', notifyEmail: '' });
    const sem = await enviar({});
    assert.equal(sem.status, 409);
    assert.equal(sem.body.code, 'no_destination');
    await saveProfile({ notifyWhatsapp: '93991935695', notifyEmail: 'ops@plataforma.test' });
    for (const channels of [['sms'], 'email', []]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await enviar({ channels });
      assert.equal(r.status, 400, JSON.stringify(channels));
      assert.equal(r.body.code, 'invalid_channels');
    }
    falhar = { whatsapp: true, email: true };
    const res = await enviar({});
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'send_failed');
    const ultima = (await mensais()).at(-1);
    assert.equal(ultima.status, 'failed');
  });
});
