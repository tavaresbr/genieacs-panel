import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * A suspensão automática por inadimplência (0102).
 *
 * `autoSuspendDays` (padrão 15) depois de o provedor passar a dever — a
 * renovação, o fim do teste ou a fatura de pró-rata vencidos —, o agendador
 * o suspende com `suspended_reason = 'auto_nonpayment'`; `autoSuspendWarnDays`
 * (padrão 3) antes, sai o aviso. O pagamento desfaz a suspensão automática
 * sozinho; a à mão continua exigindo o console.
 *
 * As datas são todas ao segundo: o MySQL guarda ao segundo e ARREDONDA os
 * milissegundos, e uma data com fração viraria outra no banco.
 */
// Sem `EDITION=saas`: o Asaas de mentira mora no loopback, que a guarda de egresso
// do SaaS recusa. Nada do que se testa aqui depende da edição.
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const { getDb, runInTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const {
  default: SubscriptionService, overdueSince, isBillableStatus, GATE_CODES
} = await import('../src/services/subscriptionService.js');
const { default: SubscriptionNoticeService } = await import('../src/services/subscriptionNoticeService.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: SubscriptionReminderSend } = await import('../src/models/SubscriptionReminderSend.js');
const {
  saveProfile, readProfile, autoSuspendConfig, invalidatePlatformProfile
} = await import('../src/services/platformProfileService.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');
const { default: SelfBillingService } = await import('../src/services/selfBillingService.js');

const DIA = 24 * 60 * 60 * 1000;
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let smtp;
let recebidas;
let gateway;
let pedidosAoGateway = [];

/** Um Asaas de mentira: toda cobrança pedida é criada. */
function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(bruto || '{}'); } catch { payload = {}; }
      pedidosAoGateway.push({ method: req.method, path: req.url.split('?')[0], payload });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `pay_suspenso_${pedidosAoGateway.length}`,
        status: 'PENDING',
        value: payload.value,
        dueDate: payload.dueDate,
        invoiceUrl: `https://gateway.exemplo.test/i/pay_suspenso_${pedidosAoGateway.length}`
      }));
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}
let alfa;
let pago;
let gratis;

before(async () => {
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtp.address().port}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
  resetMailTransport();
  process.env.ASAAS_API_KEY = 'chave-de-teste-da-suspensao';
  process.env.ASAAS_BASE_URL = await subirGateway();

  await startTestServers();
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  await getDb()('tenants').where({ id: alfa }).update({ billing_email: 'financeiro@alfa.test' });
  pago = await Plan.create({
    code: 'suspende-pro', name: 'Pro', price_cents: 19990, currency: 'BRL', period_days: 30, trial_days: 7, active: true
  });
  gratis = await Plan.create({
    code: 'suspende-free', name: 'Free', price_cents: 0, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
});

after(async () => {
  resetMailTransport();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  await new Promise((done) => gateway.close(done));
  await stopTestServers();
  await new Promise((done) => smtp.close(done));
});

async function comAssinatura(patch) {
  await Subscription.upsertForTenant(alfa, {
    plan_id: pago.id, status: 'active', trial_ends_at: null, renews_at: null, canceled_at: null,
    expiry_warned_for: null, billing_exempt_at: null, coupon_id: null, coupon_cycles_left: null,
    coupon_applied_at: null, pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null,
    suspended_reason: null, ...patch
  });
  await SubscriptionService.invalidate(alfa);
}

const passada = (now) => runInTenant(alfa, () => SubscriptionNoticeService.autoSuspendCurrent({ now }));
const assinatura = () => Subscription.forTenant(alfa);
const ultima = () => decodificarQuotedPrintable(recebidas[recebidas.length - 1]);
const eventosDeStatus = () => getDb()('billing_events')
  .join('subscriptions', 'subscriptions.id', 'billing_events.subscription_id')
  .where('subscriptions.tenant_id', alfa)
  .where('billing_events.type', 'status.changed')
  .select('billing_events.*');

/** O prazo vencido em `vencimento`, e o instante `dias` depois dele. */
let vencimento;
const em = (dias) => new Date(vencimento.getTime() + dias * DIA);

beforeEach(async () => {
  recebidas.length = 0;
  vencimento = aoSegundo(Date.now() - 40 * DIA);
  await getDb()('billing_charges').del();
  await getDb()('subscription_reminder_sends').del();
  await getDb()('billing_events').del();
  await getDb()('platform_audit').del();
});

describe('quando suspende', () => {
  it('suspende no dia 15 depois do vencimento, e não antes', async () => {
    await comAssinatura({ renews_at: vencimento });
    const vespera = await passada(new Date(em(15).getTime() - 1000));
    assert.notEqual(vespera.action, 'suspended');
    assert.equal((await assinatura()).status, 'active');

    const resultado = await passada(em(15));
    assert.equal(resultado.action, 'suspended', JSON.stringify(resultado));
    assert.equal(resultado.overdueReason, 'renewal_expired');
    const depois = await assinatura();
    assert.equal(depois.status, 'suspended');
    assert.equal(depois.suspended_reason, 'auto_nonpayment');

    // O extrato e as trilhas.
    const [evento] = await eventosDeStatus();
    const detalhe = JSON.parse(evento.detail);
    assert.equal(detalhe.to, 'suspended');
    assert.equal(detalhe.reason, 'auto_nonpayment');
    assert.equal(detalhe.automatic, true);
    const trilha = await getDb()('platform_audit').where({ tenant_id: alfa, action: 'subscription.status_changed' });
    assert.equal(trilha.length, 1);

    // E o aviso de suspensão, com o link de pagar (o endereço do painel).
    assert.equal(resultado.notice.sent, true);
    assert.match(ultima(), /suspenso/);
    assert.match(ultima(), /painel\.test/);
  });

  it('o fim do teste também conta', async () => {
    await comAssinatura({ status: 'trial', trial_ends_at: vencimento });
    assert.equal((await passada(em(14))).action === 'suspended', false);
    assert.equal((await passada(em(15))).action, 'suspended');
    assert.equal((await assinatura()).suspended_reason, 'auto_nonpayment');
  });

  it('não suspende duas vezes', async () => {
    await comAssinatura({ renews_at: vencimento });
    const agora = em(16);
    const resultados = await Promise.all([passada(agora), passada(agora), passada(agora)]);
    assert.equal(resultados.filter((r) => r.action === 'suspended').length, 1, JSON.stringify(resultados));
    // E as voltas seguintes não acham mais nada a fazer.
    assert.equal((await passada(em(17))).action, 'none');
    assert.equal((await eventosDeStatus()).length, 1);
    assert.equal((await getDb()('platform_audit').where({ tenant_id: alfa })).length, 1);
    assert.equal(recebidas.length, 1, 'um aviso de suspensão só');
  });

  it('não suspende quem pagou no meio do caminho', async () => {
    await comAssinatura({ renews_at: vencimento });
    // O pagamento empurrou o prazo: a condição da gravação deixa de casar.
    const lida = await assinatura();
    await comAssinatura({ renews_at: aoSegundo(Date.now() + 20 * DIA) });
    const mudou = await Subscription.suspendForNonpayment(alfa, {
      fromStatus: lida.status, deadlineColumn: 'renews_at', deadlineBy: aoSegundo(em(16).getTime() - 15 * DIA)
    });
    assert.equal(mudou, false);
    assert.equal((await assinatura()).status, 'active');
  });
});

describe('quem não é suspenso', () => {
  it('o isento de cobrança', async () => {
    await comAssinatura({ renews_at: vencimento, billing_exempt_at: aoSegundo(Date.now()) });
    assert.equal((await passada(em(20))).action, 'none');
    assert.equal((await assinatura()).status, 'active');
  });

  it('o plano de graça', async () => {
    await comAssinatura({ plan_id: gratis.id, renews_at: vencimento });
    assert.equal((await passada(em(20))).action, 'none');
    assert.equal((await assinatura()).status, 'active');
  });

  it('o cancelado e o já suspenso à mão', async () => {
    await comAssinatura({ status: 'canceled', renews_at: vencimento });
    assert.equal((await passada(em(20))).action, 'none');
    assert.equal((await assinatura()).status, 'canceled');
    await comAssinatura({ status: 'suspended', suspended_reason: 'manual', renews_at: vencimento });
    assert.equal((await passada(em(20))).action, 'none');
    assert.equal((await assinatura()).suspended_reason, 'manual');
  });

  it('quem está em dia', async () => {
    await comAssinatura({ renews_at: aoSegundo(Date.now() + 10 * DIA) });
    assert.equal((await passada(new Date())).action, 'none');
  });
});

describe('o aviso antes', () => {
  it('sai no dia 12, uma vez só, e não no dia 11', async () => {
    await comAssinatura({ renews_at: vencimento });
    assert.equal((await passada(em(11))).action, 'none');
    assert.equal(recebidas.length, 0);

    const aviso = await passada(em(12));
    assert.equal(aviso.action, 'warned', JSON.stringify(aviso));
    assert.equal(recebidas.length, 1);
    const texto = ultima();
    assert.match(texto, /suspenso em/);
    assert.ok(texto.includes(ChargeIssuingService.periodKey(em(15))), 'a data da suspensão vai na mensagem');

    // As passadas seguintes, no mesmo dia e no seguinte, não repetem.
    assert.notEqual((await passada(new Date(em(12).getTime() + 60_000))).action, 'warned');
    assert.notEqual((await passada(em(13))).action, 'warned');
    assert.equal(recebidas.length, 1);

    // O console lê a etapa pelo nome dela, e não pelo da coluna.
    const lidos = await runInTenant(alfa, () => SubscriptionReminderSend.listSent());
    assert.deepEqual(lidos.map((l) => l.step), ['suspension_warning']);
    assert.equal((await getDb()('subscription_reminder_sends').where({ tenant_id: alfa }).first()).step, 'suspwarn');
  });
});

describe('o pagamento', () => {
  it('reativa a suspensão automática: ativo, período a partir do pagamento, motivo limpo', async () => {
    await comAssinatura({ renews_at: vencimento });
    assert.equal((await passada(em(16))).action, 'suspended');
    const agora = aoSegundo(Date.now());
    const resultado = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 19990, externalId: 'pay_reativa', now: agora
    }));
    assert.equal(resultado.duplicate, false);
    const depois = await assinatura();
    assert.equal(depois.status, 'active');
    assert.equal(depois.suspended_reason, null);
    assert.equal(new Date(depois.renews_at).getTime(), agora.getTime() + 30 * DIA);

    const pagamento = await getDb()('billing_events').where({ external_id: 'pay_reativa' }).first();
    const detalhe = JSON.parse(pagamento.detail);
    assert.equal(detalhe.statusBefore, 'suspended');
    assert.equal(detalhe.reactivated, true);
    assert.equal(detalhe.periodDays, 30);

    // E o estorno desfaz o período que ele comprou.
    const estorno = await runInTenant(alfa, () => SubscriptionService.reversePayment({ externalId: 'pay_reativa' }));
    assert.equal(estorno.basis, 'restored');
  });

  it('não reativa a suspensão à mão', async () => {
    await comAssinatura({ renews_at: vencimento });
    await runInTenant(alfa, () => SubscriptionService.setStatus({ status: 'suspended', reason: 'abuso' }));
    assert.equal((await assinatura()).suspended_reason, 'manual');
    await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 19990, externalId: 'pay_manual', now: aoSegundo(Date.now())
    }));
    const depois = await assinatura();
    assert.equal(depois.status, 'suspended');
    assert.equal(depois.suspended_reason, 'manual');
    assert.equal(new Date(depois.renews_at).getTime(), vencimento.getTime());
  });

  it('o console tirando da suspensão limpa o motivo; suspendendo, grava manual', async () => {
    await comAssinatura({ status: 'suspended', suspended_reason: 'auto_nonpayment', renews_at: vencimento });
    await runInTenant(alfa, () => SubscriptionService.setStatus({ status: 'active' }));
    assert.equal((await assinatura()).suspended_reason, null);
    await runInTenant(alfa, () => SubscriptionService.setStatus({ status: 'suspended' }));
    assert.equal((await assinatura()).suspended_reason, 'manual');
  });
});

describe('quem ainda paga', () => {
  it('a suspensão automática continua cobrável; a à mão, não', async () => {
    assert.equal(isBillableStatus({ status: 'suspended', suspended_reason: 'auto_nonpayment' }), true);
    assert.equal(isBillableStatus({ status: 'suspended', suspended_reason: 'manual' }), false);
    assert.equal(isBillableStatus({ status: 'suspended', suspended_reason: null }), false);
    assert.equal(isBillableStatus({ status: 'canceled' }), false);

    await getDb()('tenants').where({ id: alfa }).update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_do_alfa' });
    pedidosAoGateway = [];
    try {
      // A suspensão à mão: nem a emissão nem o "pagar agora".
      await comAssinatura({ status: 'suspended', suspended_reason: 'manual', renews_at: vencimento });
      const recusada = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent({ manual: true }));
      assert.equal(recusada.reason, 'not_billable');
      await assert.rejects(runInTenant(alfa, () => SelfBillingService.payNow()), { code: 'not_billable' });
      assert.equal(pedidosAoGateway.length, 0);

      // A automática: o agendador emite, e o "pagar agora" devolve o link.
      await comAssinatura({ status: 'suspended', suspended_reason: 'auto_nonpayment', renews_at: vencimento });
      const emitida = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
      assert.equal(emitida.issued, true, JSON.stringify(emitida));
      const paga = await runInTenant(alfa, () => SelfBillingService.payNow());
      assert.ok(paga.charge?.invoice_url, JSON.stringify(paga));
      assert.equal(pedidosAoGateway.filter((p) => p.method === 'POST' && p.path === '/payments').length, 1);

      // E o pagamento dela pelo webhook (`recordPayment`) reativa.
      await runInTenant(alfa, () => SubscriptionService.recordPayment({
        amountCents: 19990, provider: 'asaas', externalId: paga.charge.gateway_charge_id, now: aoSegundo(Date.now())
      }));
      assert.equal((await assinatura()).status, 'active');
    } finally {
      await getDb()('tenants').where({ id: alfa }).update({ billing_gateway: null, billing_customer_ref: null });
    }
  });

  it('o gate barra (402 de suspenso) e a tela sabe o porquê', async () => {
    const sub = { status: 'suspended', suspended_reason: 'auto_nonpayment', renews_at: vencimento };
    assert.equal(SubscriptionService.decide(sub, { method: 'GET' }).code, GATE_CODES.SUSPENDED);
    const visto = SubscriptionService.present({ subscription: sub, plan: null });
    assert.equal(visto.reason, 'auto_nonpayment');
    assert.equal(visto.suspendedReason, 'auto_nonpayment');
  });
});

describe('a pró-rata vencida também conta', () => {
  it('é a âncora quando é a dívida mais antiga', () => {
    const agora = aoSegundo(Date.now());
    const emDia = { status: 'active', renews_at: new Date(agora.getTime() + 10 * DIA) };
    assert.equal(overdueSince(emDia, agora), null);
    const proRata = new Date(agora.getTime() - 16 * DIA);
    const devendo = overdueSince(emDia, agora, { prorationDueAt: proRata });
    assert.equal(devendo.reason, 'proration_overdue');
    assert.equal(devendo.since.getTime(), proRata.getTime());

    const etapa = SubscriptionService.autoSuspensionStep(emDia, agora, pago, { days: 15, warnDays: 3 }, { prorationDueAt: proRata });
    assert.equal(etapa.step, 'suspend');
    const cedo = SubscriptionService.autoSuspensionStep(
      emDia, agora, pago, { days: 15, warnDays: 3 }, { prorationDueAt: new Date(agora.getTime() - 13 * DIA) }
    );
    assert.equal(cedo.step, 'suspension_warning');

    // Com a renovação também vencida, vale a mais antiga.
    const vencida = { status: 'active', renews_at: new Date(agora.getTime() - 20 * DIA) };
    assert.equal(overdueSince(vencida, agora, { prorationDueAt: proRata }).reason, 'renewal_expired');
  });

  it('e suspende pelo mesmo caminho', async () => {
    await comAssinatura({ renews_at: aoSegundo(Date.now() + 10 * DIA) });
    const agora = aoSegundo(Date.now());
    const resultado = await runInTenant(alfa, () => SubscriptionService.autoSuspend({
      now: agora, config: { days: 15, warnDays: 3 }, prorationDueAt: new Date(agora.getTime() - 15 * DIA)
    }));
    assert.equal(resultado.suspended, true, JSON.stringify(resultado));
    assert.equal(resultado.overdueReason, 'proration_overdue');
    assert.equal((await assinatura()).suspended_reason, 'auto_nonpayment');
  });
});

describe('a configuração', () => {
  before(async () => {
    if (!(await getDb()('tenants').where({ kind: 'platform' }).first())) {
      await getDb()('tenants').insert({ slug: 'plataforma-suspende', name: 'Plataforma', status: 'active', kind: 'platform' });
    }
    invalidatePlatformProfile();
  });

  it('o padrão é 15 e 3', async () => {
    assert.deepEqual(await autoSuspendConfig(), { days: 15, warnDays: 3 });
    const { billing } = await readProfile();
    assert.deepEqual(billing, { autoSuspendDays: 15, autoSuspendWarnDays: 3 });
  });

  it('grava, valida e volta ao padrão', async () => {
    assert.deepEqual(await saveProfile({ autoSuspendDays: 20, autoSuspendWarnDays: 5 }), ['autoSuspendDays', 'autoSuspendWarnDays']);
    assert.deepEqual(await autoSuspendConfig(), { days: 20, warnDays: 5 });
    await assert.rejects(saveProfile({ autoSuspendDays: -1 }), { field: 'autoSuspendDays' });
    await assert.rejects(saveProfile({ autoSuspendDays: 1.5 }), { field: 'autoSuspendDays' });
    await assert.rejects(saveProfile({ autoSuspendWarnDays: 20 }), { field: 'autoSuspendWarnDays' });
    await saveProfile({ autoSuspendDays: null, autoSuspendWarnDays: null });
    assert.deepEqual(await autoSuspendConfig(), { days: 15, warnDays: 3 });
  });

  it('zero desliga', async () => {
    await saveProfile({ autoSuspendDays: 0, autoSuspendWarnDays: 0 });
    try {
      await comAssinatura({ renews_at: vencimento });
      assert.equal((await passada(em(30))).reason, 'disabled');
      assert.equal((await assinatura()).status, 'active');
    } finally {
      await saveProfile({ autoSuspendDays: null, autoSuspendWarnDays: null });
    }
  });
});
