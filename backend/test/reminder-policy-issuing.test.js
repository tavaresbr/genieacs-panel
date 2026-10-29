import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * A emissão puxada pela régua de cobrança (0121): com um `before` mais cedo
 * que `LEAD_DAYS`, a fatura Pix/boleto sai um dia antes dele, para o primeiro
 * lembrete já levar o link. Emitir mais cedo não muda a chave da cobrança
 * (`period_end`): uma cobrança por período, uma chamada ao gateway.
 *
 * O gateway é um servidor de mentira em `127.0.0.1`, como em
 * `billing-charge.test.js`.
 */

const { call, getDb, runInTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: SubscriptionNoticeService } = await import('../src/services/subscriptionNoticeService.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { saveProfile, invalidatePlatformProfile } = await import('../src/services/platformProfileService.js');
const { normalizeReminderPolicy, defaultReminderPolicy } = await import('../src/services/reminderPolicy.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');

const DIA = 86_400_000;

let gateway;
let pedidos = [];
let alfa;
let planoPago;
let smtp;
let recebidas;

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(bruto || '{}'); } catch { payload = {}; }
      pedidos.push({ method: req.method, path: req.url.split('?')[0], payload });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: `pay_regua_${pedidos.length}`,
        status: 'PENDING',
        value: payload.value,
        dueDate: payload.dueDate,
        invoiceUrl: `https://gateway.exemplo.test/i/pay_regua_${pedidos.length}`
      }));
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

before(async () => {
  const base = await subirGateway();
  process.env.ASAAS_API_KEY = 'chave-da-api-deste-deploy';
  process.env.ASAAS_BASE_URL = base;
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtp.address().port}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
  resetMailTransport();

  const { panelUrl } = await startTestServers();
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').where({ id: alfa }).update({
    billing_gateway: 'asaas', billing_customer_ref: 'cus_do_alfa', name: 'Provedor Alfa', billing_email: 'fin@alfa.test'
  });
  await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  invalidatePlatformProfile();
  planoPago = await runInTenant(alfa, () => Plan.create({
    code: 'pago-regua', name: 'Pago', price_cents: 19990, currency: 'BRL', period_days: 30, active: true
  }));
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  resetMailTransport();
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => smtp.close(r));
  await stopTestServers();
});

/** No segundo inteiro: o MySQL arredonda os milissegundos. */
const seg = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let prazo;

async function assinar(renewsAt) {
  prazo = renewsAt;
  await runInTenant(alfa, async () => {
    await Subscription.upsertForTenant(alfa, {
      plan_id: planoPago.id, status: 'active', renews_at: renewsAt, trial_ends_at: null
    });
    SubscriptionService.cache.invalidate();
  });
}

const emitir = (now) => runInTenant(alfa, async () => ChargeIssuingService.issueCurrent({ now }));
const cobrancas = () => getDb()('billing_charges').where({ tenant_id: alfa }).orderBy('id');
const passo = (id, kind, offsetDays, extra = {}) => ({
  id, kind, offsetDays, channels: ['email'], enabled: true, ...extra
});

beforeEach(async () => {
  pedidos = [];
  recebidas.length = 0;
  await getDb()('billing_charges').del();
  await getDb()('subscription_reminder_sends').del();
  await saveProfile({ reminderPolicy: null });
});

describe('a antecedência da emissão pela régua', () => {
  it('leadDaysFor: a padrão continua em LEAD_DAYS; o before mais cedo puxa um dia antes dele, com teto', () => {
    const com = (steps) => ChargeIssuingService.leadDaysFor(normalizeReminderPolicy({ steps }));
    assert.equal(ChargeIssuingService.leadDaysFor(defaultReminderPolicy()), ChargeIssuingService.LEAD_DAYS);
    assert.equal(com([]), ChargeIssuingService.LEAD_DAYS);
    assert.equal(com([passo('a', 'before', -3)]), ChargeIssuingService.LEAD_DAYS);
    assert.equal(com([passo('a', 'before', -6)]), 7);
    assert.equal(com([passo('a', 'before', -10), passo('b', 'before', -2)]), 11);
    assert.equal(com([passo('a', 'before', -10, { enabled: false })]), ChargeIssuingService.LEAD_DAYS);
    assert.equal(com([passo('a', 'before', -30)]), ChargeIssuingService.ISSUE_LEAD_MAX_DAYS);
    assert.equal(com([passo('a', 'after', 30)]), ChargeIssuingService.LEAD_DAYS);
  });

  it('com a régua padrão, nove dias antes ainda não emite; cinco antes, sim', async () => {
    const agora = seg(Date.now());
    await assinar(seg(agora.getTime() + 9 * DIA));
    assert.equal((await emitir(agora)).reason, 'not_due_yet');
    const r = await emitir(new Date(prazo.getTime() - 5 * DIA + 60_000));
    assert.equal(r.issued, true, JSON.stringify(r));
  });

  it('com um before a −10, emite onze dias antes — uma cobrança só, por mais passadas que haja', async () => {
    await saveProfile({ reminderPolicy: { steps: [passo('d10', 'before', -10), passo('due', 'due', 0)] } });
    const agora = seg(Date.now());
    await assinar(seg(agora.getTime() + 12 * DIA));
    assert.equal((await emitir(agora)).reason, 'not_due_yet', 'doze dias antes ainda não');

    const quando = new Date(prazo.getTime() - 10.5 * DIA);
    const primeira = await emitir(quando);
    assert.equal(primeira.issued, true, JSON.stringify(primeira));
    // As passadas seguintes (o agendador, de minuto em minuto) não emitem outra.
    for (const minutos of [1, 2, 60, 24 * 60]) {
      // eslint-disable-next-line no-await-in-loop
      const deNovo = await emitir(new Date(quando.getTime() + minutos * 60_000));
      assert.equal(deNovo.issued, false, JSON.stringify(deNovo));
    }
    const linhas = await cobrancas();
    assert.equal(linhas.length, 1, 'uma cobrança por período');
    assert.equal(String(linhas[0].period_end).slice(0, 10), ChargeIssuingService.periodKey(prazo), 'a chave é o prazo, não o dia da emissão');
    assert.equal(pedidos.filter((p) => p.method === 'POST' && p.path === '/payments').length, 1, 'uma chamada ao gateway');
    // O vencimento no gateway continua sendo o do prazo.
    assert.equal(pedidos[0].payload.dueDate, ChargeIssuingService.isoDate(prazo));

    // E o primeiro lembrete (−10) já leva o link da fatura.
    const aviso = await runInTenant(alfa, () => SubscriptionNoticeService.notifyCurrent({ now: new Date(prazo.getTime() - 9.9 * DIA) }));
    assert.equal(aviso.sent, true, JSON.stringify(aviso));
    assert.equal(aviso.stepId, 'd10');
    assert.match(decodificarQuotedPrintable(recebidas[recebidas.length - 1]), /gateway\.exemplo\.test\/i\/pay_regua_1/);
  });

  it('voltar à régua padrão depois de emitida não emite de novo', async () => {
    await saveProfile({ reminderPolicy: { steps: [passo('d10', 'before', -10)] } });
    const agora = seg(Date.now());
    await assinar(seg(agora.getTime() + 9 * DIA));
    assert.equal((await emitir(agora)).issued, true);
    await saveProfile({ reminderPolicy: null });
    const depois = await emitir(new Date(prazo.getTime() - 4 * DIA));
    assert.equal(depois.issued, false, JSON.stringify(depois));
    assert.equal((await cobrancas()).length, 1);
    assert.equal(pedidos.filter((p) => p.path === '/payments' && p.method === 'POST').length, 1);
  });
});
