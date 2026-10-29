import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A régua de cobrança configurável (0121): Configurações → Régua de cobrança.
 *
 * O que este arquivo guarda:
 *
 * - a régua padrão faz EXATAMENTE os envios de antes (comparada, instante a
 *   instante, com a função de antes da 0121);
 * - passos personalizados, mais de um `before`, canais por passo, textos com
 *   variáveis (limpos, sem HTML);
 * - a deduplicação por passo (`step_key`): a troca de configuração não
 *   reenvia o que já saiu, e o registro antigo (`before`) conta como o passo
 *   `before` da régua padrão;
 * - a validação do PUT do perfil, com os códigos;
 * - o "Enviar teste para mim".
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: SubscriptionNoticeService } = await import('../src/services/subscriptionNoticeService.js');
const { default: PlatformNotifyService } = await import('../src/services/platformNotifyService.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');
const { saveProfile, invalidatePlatformProfile, readProfile } = await import('../src/services/platformProfileService.js');
const {
  defaultReminderPolicy, normalizeReminderPolicy, renderReminderTemplate, reminderStepColumn, reminderWindows,
  ReminderPolicyError
} = await import('../src/services/reminderPolicy.js');
const { migrations } = await import('../src/config/migrations.js');

const DIA = 24 * 60 * 60 * 1000;

let smtp;
let recebidas;
let smtpPort;
let panelUrl;
let token;
let alfa;
let pago;
let whatsapps = [];
const sendWhatsappOriginal = PlatformNotifyService.sendWhatsapp;

/** O segundo inteiro: o MySQL arredonda os milissegundos. */
const seg = (ms) => new Date(Math.floor(ms / 1000) * 1000);

before(async () => {
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  smtpPort = smtp.address().port;
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtpPort}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
  resetMailTransport();

  ({ panelUrl } = await startTestServers());
  const db = getDb();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').where({ id: alfa }).update({ name: 'Provedor <b>Alfa</b>' });
  await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  invalidatePlatformProfile();
  pago = await Plan.create({
    code: 'regua-pro', name: 'Pro', price_cents: 19990, currency: 'BRL', period_days: 30, trial_days: 7, active: true
  });
  // O WhatsApp da plataforma, de mentira: registra o que sairia.
  PlatformNotifyService.sendWhatsapp = async (phone, text) => {
    whatsapps.push({ phone, text });
    return true;
  };
});

after(async () => {
  PlatformNotifyService.sendWhatsapp = sendWhatsappOriginal;
  resetMailTransport();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  await stopTestServers();
  await new Promise((done) => smtp.close(done));
});

async function comAssinatura(patch) {
  await Subscription.upsertForTenant(alfa, {
    plan_id: pago.id, status: 'active', trial_ends_at: null, renews_at: null, canceled_at: null,
    expiry_warned_for: null, billing_exempt_at: null, coupon_id: null, coupon_cycles_left: null,
    coupon_applied_at: null, pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null, ...patch
  });
  await SubscriptionService.invalidate(alfa);
}

const avisar = (now) => runInTenant(alfa, () => SubscriptionNoticeService.notifyCurrent({ now }));
const enviados = () => getDb()('subscription_reminder_sends').where({ tenant_id: alfa }).orderBy('id');
const ultima = () => decodificarQuotedPrintable(recebidas[recebidas.length - 1]);

const passo = (id, kind, offsetDays, extra = {}) => ({
  id, kind, offsetDays, channels: ['whatsapp', 'email'], enabled: true, ...extra
});

async function regua(steps) {
  await saveProfile({ reminderPolicy: steps === null ? null : { steps } });
}

beforeEach(async () => {
  recebidas.length = 0;
  whatsapps = [];
  await getDb()('tenants').where({ id: alfa }).update({ billing_email: 'financeiro@alfa.test', billing_phone: null });
  await getDb()('billing_charges').del();
  await getDb()('subscription_reminder_sends').del();
  await regua(null);
});

/**
 * A função de antes da 0121, copiada como era: a régua padrão tem de dar o
 * mesmo passo que ela em todo instante.
 */
function pendingReminderDeAntes(subscription, now, plano) {
  if (!subscription || subscription.billing_exempt_at) return null;
  if (!(SubscriptionService.cyclePriceCents(subscription, plano) > 0)) return null;
  const stored = subscription.status;
  if (stored !== 'trial' && stored !== 'active' && stored !== 'past_due') return null;
  const prazo = stored === 'trial'
    ? (subscription.trial_ends_at ? new Date(subscription.trial_ends_at) : null)
    : (subscription.renews_at ? new Date(subscription.renews_at) : (subscription.trial_ends_at ? new Date(subscription.trial_ends_at) : null));
  if (!prazo) return null;
  const desde = now.getTime() - prazo.getTime();
  let step = null;
  if (desde >= -5 * DIA && desde < 0) step = 'before';
  else if (desde >= 0 && desde < 3 * DIA) step = 'due';
  else if (desde >= 3 * DIA && desde < 10 * DIA) {
    if (SubscriptionService.effectiveStatus(subscription, now).status === 'past_due') step = 'after';
  }
  return step ? { kind: stored === 'trial' ? 'trial' : 'renewal', step, expired: desde >= 0 } : null;
}

describe('a régua padrão faz os envios de antes', () => {
  const plano = { price_cents: 100 };
  const prazo = new Date('2026-10-10T15:00:00Z');
  const cenarios = [
    { status: 'active', renews_at: prazo },
    { status: 'trial', trial_ends_at: prazo },
    { status: 'past_due', renews_at: prazo },
    { status: 'past_due', renews_at: null, trial_ends_at: prazo },
    { status: 'suspended', renews_at: prazo },
    { status: 'active', renews_at: prazo, billing_exempt_at: new Date() }
  ];

  it('instante a instante, de doze dias antes a doze depois', () => {
    for (const sub of cenarios) {
      for (let horas = -12 * 24; horas <= 12 * 24; horas += 1) {
        const now = new Date(prazo.getTime() + horas * 3_600_000);
        const antes = pendingReminderDeAntes(sub, now, plano);
        const agora = SubscriptionService.pendingReminder(sub, now, plano);
        assert.equal(agora?.step ?? null, antes?.step ?? null, `${sub.status} em ${horas}h`);
        if (antes) {
          assert.equal(agora.kind, antes.kind);
          assert.equal(agora.expired, antes.expired);
          // O id do passo padrão é o nome antigo: a mesma chave de deduplicação.
          assert.equal(agora.stepId, antes.step);
          assert.deepEqual(agora.channels, ['whatsapp', 'email']);
        }
      }
    }
  });

  it('a régua gravada igual à padrão dá o mesmo que nenhuma régua', () => {
    const politica = defaultReminderPolicy();
    for (let horas = -12 * 24; horas <= 12 * 24; horas += 7) {
      const now = new Date(prazo.getTime() + horas * 3_600_000);
      const sub = { status: 'active', renews_at: prazo };
      assert.deepEqual(
        SubscriptionService.pendingReminder(sub, now, plano, politica),
        SubscriptionService.pendingReminder(sub, now, plano)
      );
    }
  });

  it('as janelas da padrão: −5 ao prazo, prazo a +3, +3 a +10', () => {
    const janelas = reminderWindows(defaultReminderPolicy()).map(({ step, startMs, endMs }) => [step.id, startMs / DIA, endMs / DIA]);
    assert.deepEqual(janelas, [['before', -5, 0], ['due', 0, 3], ['after', 3, 10]]);
  });

  it('pelo envio de verdade: before, due e after, uma vez cada', async () => {
    const prazoReal = seg(Date.now() + 2 * DIA);
    await comAssinatura({ renews_at: prazoReal });
    const em = (dias) => new Date(prazoReal.getTime() + dias * DIA);
    for (const [dias, etapa] of [[-4, 'before'], [1, 'due'], [4, 'after']]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await avisar(em(dias));
      assert.equal(r.sent, true, JSON.stringify(r));
      assert.equal(r.step, etapa);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await avisar(new Date(em(dias).getTime() + 60_000))).sent, false);
    }
    const linhas = await enviados();
    assert.deepEqual(linhas.map((l) => [l.step, l.step_key]), [['before', 'before'], ['due', 'due'], ['after', 'after']]);
    assert.equal(recebidas.length, 3);
  });
});

describe('passos personalizados', () => {
  const plano = { price_cents: 100 };
  const prazo = new Date('2026-10-10T15:00:00Z');
  const em = (dias) => new Date(prazo.getTime() + dias * DIA);
  const politica = normalizeReminderPolicy({
    steps: [
      passo('d10', 'before', -10),
      passo('d3', 'before', -3),
      passo('due', 'due', 0),
      passo('d5', 'after', 5),
      passo('d20', 'after', 20)
    ]
  });
  const id = (sub, now) => SubscriptionService.pendingReminder(sub, now, plano, politica)?.stepId ?? null;
  const ativa = { status: 'active', renews_at: prazo };

  it('cada passo vale do seu dia ao do próximo, com teto de sete dias', () => {
    assert.equal(id(ativa, em(-10.01)), null);
    assert.equal(id(ativa, em(-10)), 'd10');
    assert.equal(id(ativa, em(-3.01)), 'd10');
    assert.equal(id(ativa, em(-3)), 'd3');
    assert.equal(id(ativa, em(-0.01)), 'd3');
    assert.equal(id(ativa, em(0)), 'due');
    assert.equal(id(ativa, em(4.99)), 'due');
    assert.equal(id(ativa, em(5)), 'd5');
    assert.equal(id(ativa, em(11.99)), 'd5');
    assert.equal(id(ativa, em(12)), null, 'o teto de sete dias');
    assert.equal(id(ativa, em(20)), 'd20');
    assert.equal(id(ativa, em(27)), null);
  });

  it('o before nunca passa do prazo, mesmo sem passo no dia', () => {
    const soAntes = normalizeReminderPolicy({ steps: [passo('d2', 'before', -2)] });
    const r = (now) => SubscriptionService.pendingReminder(ativa, now, plano, soAntes)?.stepId ?? null;
    assert.equal(r(em(-1)), 'd2');
    assert.equal(r(em(0)), null);
  });

  it('o passo desligado não sai e não corta a janela do anterior', () => {
    const comDesligado = normalizeReminderPolicy({
      steps: [passo('before', 'before', -5), passo('d2', 'before', -2, { enabled: false })]
    });
    const r = (now) => SubscriptionService.pendingReminder(ativa, now, plano, comDesligado)?.stepId ?? null;
    assert.equal(r(em(-1)), 'before');
  });

  it('a régua vazia não manda nada', () => {
    const vazia = normalizeReminderPolicy({ steps: [] });
    assert.equal(SubscriptionService.pendingReminder(ativa, em(-1), plano, vazia), null);
  });

  it('dois before no mesmo prazo: os dois saem, um por passada, cada um uma vez', async () => {
    await regua([passo('d10', 'before', -10), passo('before', 'before', -5), passo('due', 'due', 0)]);
    const prazoReal = seg(Date.now() + 12 * DIA);
    await comAssinatura({ renews_at: prazoReal });
    const quando = (dias) => new Date(prazoReal.getTime() + dias * DIA);
    const primeiro = await avisar(quando(-9));
    assert.equal(primeiro.sent, true, JSON.stringify(primeiro));
    assert.equal(primeiro.stepId, 'd10');
    assert.equal((await avisar(quando(-8))).sent, false);
    const segundo = await avisar(quando(-4));
    assert.equal(segundo.stepId, 'before');
    assert.equal((await avisar(quando(-3))).sent, false);
    const linhas = await enviados();
    assert.deepEqual(linhas.map((l) => l.step_key), ['d10', 'before']);
    // `step` é o código curto do passo: o índice antigo não barra o segundo before.
    assert.deepEqual(linhas.map((l) => l.step), [reminderStepColumn('d10'), 'before']);
    assert.match(linhas[0].step, /^p[0-9a-z]{7}$/);
  });

  it('dois passos no mesmo dia: o segundo sai na passada seguinte', async () => {
    await regua([passo('email5', 'before', -5, { channels: ['email'] }), passo('zap5', 'before', -5, { channels: ['whatsapp'] })]);
    await getDb()('tenants').where({ id: alfa }).update({ billing_phone: '11988887777' });
    const prazoReal = seg(Date.now() + 3 * DIA);
    await comAssinatura({ renews_at: prazoReal });
    const a = await avisar(new Date());
    const b = await avisar(new Date(Date.now() + 60_000));
    const c = await avisar(new Date(Date.now() + 120_000));
    assert.deepEqual([a.sent, b.sent, c.sent], [true, true, false]);
    assert.deepEqual([a.stepId, b.stepId].sort(), ['email5', 'zap5']);
    assert.equal(recebidas.length, 1);
    assert.equal(whatsapps.length, 1);
  });
});

describe('a deduplicação por passo', () => {
  it('mudar os dias de um passo sem mudar o id não o reenvia no mesmo prazo', async () => {
    const prazoReal = seg(Date.now() + 3 * DIA);
    await comAssinatura({ renews_at: prazoReal });
    assert.equal((await avisar(new Date())).sent, true);
    await regua([passo('before', 'before', -2), passo('due', 'due', 0), passo('after', 'after', 3)]);
    assert.equal((await avisar(new Date(prazoReal.getTime() - 1 * DIA))).reason, 'already_sent');
    // Um passo NOVO (id novo) sai.
    await regua([passo('before', 'before', -5), passo('novo2', 'before', -2), passo('due', 'due', 0)]);
    const novo = await avisar(new Date(prazoReal.getTime() - 1 * DIA));
    assert.equal(novo.sent, true, JSON.stringify(novo));
    assert.equal(novo.stepId, 'novo2');
    assert.equal(recebidas.length, 2);
  });

  it('o registro de antes da 0121 (step before) não sai de novo', async () => {
    const prazoReal = seg(Date.now() + 3 * DIA);
    await comAssinatura({ renews_at: prazoReal });
    const dueAt = ChargeIssuingService.periodKey(prazoReal);
    // Como a migração deixa: step_key = step.
    await getDb()('subscription_reminder_sends').insert({
      tenant_id: alfa, due_at: dueAt, step: 'before', step_key: 'before', channels: 'email', sent_at: seg(Date.now() - DIA)
    });
    assert.equal((await avisar(new Date())).reason, 'already_sent');
    assert.equal(recebidas.length, 0);
  });

  it('nem a linha que uma versão anterior gravou sem step_key', async () => {
    const prazoReal = seg(Date.now() + 3 * DIA);
    await comAssinatura({ renews_at: prazoReal });
    await getDb()('subscription_reminder_sends').insert({
      tenant_id: alfa, due_at: ChargeIssuingService.periodKey(prazoReal), step: 'before', step_key: null, channels: 'email', sent_at: seg(Date.now())
    });
    assert.equal((await avisar(new Date())).reason, 'already_sent');
    assert.equal(recebidas.length, 0);
  });

  it('a migração 0121 preenche step_key dos registros antigos, e roda de novo sem efeito', async () => {
    const db = getDb();
    await db('subscription_reminder_sends').insert([
      { tenant_id: alfa, due_at: '2026-01-10', step: 'before', step_key: null, sent_at: seg(Date.now()) },
      { tenant_id: alfa, due_at: '2026-01-10', step: 'suspwarn', step_key: null, sent_at: seg(Date.now()) },
      { tenant_id: alfa, due_at: '2026-01-11', step: 'manual', step_key: null, sent_at: seg(Date.now()) }
    ]);
    const migracao = migrations.find((m) => m.id === '0121_reminder_step_key');
    assert.ok(migracao);
    assert.equal(await migracao.isApplied(db), true, 'a coluna e o índice já existem');
    await migracao.up(db);
    await migracao.up(db);
    const linhas = await enviados();
    assert.deepEqual(linhas.map((l) => [l.step, l.step_key]), [['before', 'before'], ['suspwarn', 'suspwarn'], ['manual', 'manual']]);
    // O índice novo trava a mesma chave.
    await assert.rejects(db('subscription_reminder_sends').insert({
      tenant_id: alfa, due_at: '2026-01-10', step: 'pzzzzzzz', step_key: 'before'
    }));
  });

  it('a migração 0121 num banco de antes dela: cria a coluna, preenche e trava', async () => {
    const db = getDb();
    await db('subscription_reminder_sends').insert([
      { tenant_id: alfa, due_at: '2026-03-10', step: 'before', step_key: null, sent_at: seg(Date.now()) },
      { tenant_id: alfa, due_at: '2026-03-10', step: 'after', step_key: null, sent_at: seg(Date.now()) }
    ]);
    // O banco como era antes da 0121: sem o índice novo e sem a coluna.
    await db.schema.alterTable('subscription_reminder_sends', (t) => {
      t.dropUnique(['tenant_id', 'due_at', 'step_key'], 'subscription_reminder_sends_step_key_uq');
    });
    await db.schema.alterTable('subscription_reminder_sends', (t) => { t.dropColumn('step_key'); });
    const migracao = migrations.find((m) => m.id === '0121_reminder_step_key');
    assert.equal(await migracao.isApplied(db), false);
    await migracao.up(db);
    assert.equal(await migracao.isApplied(db), true);
    const linhas = await enviados();
    assert.deepEqual(linhas.map((l) => [l.step, l.step_key]), [['before', 'before'], ['after', 'after']]);
    // E o registro antigo continua barrando o reenvio do passo padrão.
    await assert.rejects(db('subscription_reminder_sends').insert({
      tenant_id: alfa, due_at: '2026-03-10', step: 'pzzzzzzz', step_key: 'after'
    }));
  });

  it('a suspensão automática ainda acha o aviso pela chave antiga', async () => {
    await getDb()('subscription_reminder_sends').insert({
      tenant_id: alfa, due_at: '2026-02-01', step: 'suspwarn', step_key: 'suspwarn', sent_at: seg(Date.now())
    });
    const { default: SubscriptionReminderSend } = await import('../src/models/SubscriptionReminderSend.js');
    const quando = await runInTenant(alfa, () => SubscriptionReminderSend.sentAt({ dueAt: '2026-02-01', step: 'suspension_warning' }));
    assert.ok(quando instanceof Date);
  });
});

describe('os canais de cada passo', () => {
  it('só WhatsApp: não manda e-mail', async () => {
    await regua([passo('before', 'before', -5, { channels: ['whatsapp'] })]);
    await getDb()('tenants').where({ id: alfa }).update({ billing_phone: '11988887777' });
    await comAssinatura({ renews_at: seg(Date.now() + 3 * DIA) });
    const r = await avisar(new Date());
    assert.equal(r.sent, true, JSON.stringify(r));
    assert.equal(recebidas.length, 0);
    assert.equal(whatsapps.length, 1);
    assert.equal((await enviados())[0].channels, 'whatsapp');
  });

  it('só WhatsApp e sem telefone: ninguém a quem mandar, e nada marcado', async () => {
    await regua([passo('before', 'before', -5, { channels: ['whatsapp'] })]);
    await comAssinatura({ renews_at: seg(Date.now() + 3 * DIA) });
    assert.equal((await avisar(new Date())).reason, 'no_recipient');
    assert.equal(recebidas.length, 0);
    assert.equal((await enviados()).length, 0);
  });

  it('só e-mail: não manda WhatsApp, mesmo com telefone', async () => {
    await regua([passo('before', 'before', -5, { channels: ['email'] })]);
    await getDb()('tenants').where({ id: alfa }).update({ billing_phone: '11988887777' });
    await comAssinatura({ renews_at: seg(Date.now() + 3 * DIA) });
    assert.equal((await avisar(new Date())).sent, true);
    assert.equal(recebidas.length, 1);
    assert.equal(whatsapps.length, 0);
  });
});

describe('os textos', () => {
  it('as variáveis trocadas numa passada só, e os valores limpos', () => {
    const texto = renderReminderTemplate('{empresa} deve {valor} até {vencimento} ({plano}): {link} {outra}', {
      empresa: 'Alfa <script>alert(1)</script>\nLinha',
      valor: 'R$ 10,00',
      vencimento: '2026-10-10',
      plano: '{link}',
      link: 'https://pagar.test/x'
    });
    assert.equal(texto, 'Alfa scriptalert(1)/script Linha deve R$ 10,00 até 2026-10-10 ({link}): https://pagar.test/x {outra}');
  });

  it('o passo com texto próprio: assunto e corpo trocados, sem HTML no e-mail', async () => {
    await regua([passo('before', 'before', -5, {
      subject: 'Fatura {empresa}: {valor}',
      body: 'Olá, {empresa}!\nO plano {plano} vence em {vencimento}.\nPague: {link}'
    })]);
    await getDb()('tenants').where({ id: alfa }).update({ billing_phone: '11988887777' });
    const prazoReal = seg(Date.now() + 3 * DIA);
    await comAssinatura({ renews_at: prazoReal });
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({
        periodEnd: ChargeIssuingService.periodKey(prazoReal), amountCents: 19990, currency: 'BRL', provider: 'asaas'
      });
      await BillingCharge.markIssued(id, { gatewayChargeId: 'pay_regua', invoiceUrl: 'https://gateway.exemplo.test/i/pay_regua' });
    });
    assert.equal((await avisar(new Date())).sent, true);
    const bruto = recebidas[recebidas.length - 1];
    const email = ultima();
    assert.match(email, /Subject: Fatura Provedor bAlfa\/b: R\$\s199,90/);
    assert.match(email, /O plano Pro vence em \d{4}-\d{2}-\d{2}\./);
    assert.match(email, /Pague: https:\/\/gateway\.exemplo\.test\/i\/pay_regua/);
    assert.equal(/text\/html/i.test(bruto), false, 'o e-mail é só texto');
    assert.equal(email.includes('<b>'), false, 'o nome do provedor entra sem as tags');
    assert.match(whatsapps[0].text, /^\*Fatura Provedor bAlfa\/b: R\$\s199,90\*\n\nOlá, Provedor bAlfa\/b!/);
  });

  it('texto vazio: o padrão do i18n — e no teste, o do teste', async () => {
    await regua([passo('d4', 'before', -4)]);
    await comAssinatura({ status: 'trial', trial_ends_at: seg(Date.now() + 2 * DIA) });
    assert.equal((await avisar(new Date())).sent, true);
    assert.match(ultima(), /teste do Provedor/i);
  });

  it('só o corpo próprio: o assunto continua o padrão', async () => {
    await regua([passo('before', 'before', -5, { body: 'Corpo proprio de {empresa}' })]);
    await comAssinatura({ renews_at: seg(Date.now() + 3 * DIA) });
    await avisar(new Date());
    assert.match(ultima(), /Subject: (=\?UTF-8\?Q\?)?A[ _]fatura[ _]do[ _]Provedor/);
    assert.match(ultima(), /Corpo proprio de Provedor bAlfa\/b/);
  });
});

describe('o cartão em débito automático continua com a regra de antes', () => {
  it('o before não sai, nem o personalizado', async () => {
    await regua([passo('d10', 'before', -10), passo('due', 'due', 0)]);
    await comAssinatura({ renews_at: seg(Date.now() + 8 * DIA) });
    const original = ChargeIssuingService.cardAutopayFor;
    ChargeIssuingService.cardAutopayFor = () => true;
    try {
      const r = await avisar(new Date());
      assert.equal(r.reason, 'card_autopay');
      assert.equal(r.step, 'before');
    } finally {
      ChargeIssuingService.cardAutopayFor = original;
    }
    assert.equal(recebidas.length, 0);
  });
});

const perfil = (body) => call(`${panelUrl}/api/platform/settings/profile`, {
  method: 'PUT', body, headers: authHeaders(token)
});

describe('a validação do PUT do perfil', () => {
  const casos = [
    [{ steps: 'x' }, 'invalid_policy', null],
    [{ steps: Array.from({ length: 9 }, (_, i) => passo(`p${i}`, 'after', i + 1)) }, 'too_many_steps', null],
    [{ steps: [passo('Maiúsculo', 'before', -5)] }, 'invalid_step_id', 0],
    [{ steps: [passo('um-id-longo-demais-x', 'before', -5)] }, 'invalid_step_id', 0],
    [{ steps: [passo('manual', 'before', -5)] }, 'invalid_step_id', 0],
    [{ steps: [passo('a', 'before', -5), passo('a', 'due', 0)] }, 'duplicate_step_id', 1],
    [{ steps: [passo('a', 'antes', -5)] }, 'invalid_kind', 0],
    [{ steps: [passo('a', 'before', 0)] }, 'invalid_offset', 0],
    [{ steps: [passo('a', 'before', -31)] }, 'invalid_offset', 0],
    [{ steps: [passo('a', 'due', 1)] }, 'invalid_offset', 0],
    [{ steps: [passo('a', 'after', 61)] }, 'invalid_offset', 0],
    [{ steps: [passo('a', 'after', 1.5)] }, 'invalid_offset', 0],
    [{ steps: [passo('a', 'after', 3, { channels: [] })] }, 'invalid_channels', 0],
    [{ steps: [passo('a', 'after', 3, { channels: ['sms'] })] }, 'invalid_channels', 0],
    [{ steps: [passo('a', 'after', 3, { enabled: 'sim' })] }, 'invalid_enabled', 0],
    [{ steps: [passo('a', 'after', 3, { subject: 'x'.repeat(151) })] }, 'subject_too_long', 0],
    [{ steps: [passo('a', 'after', 3, { body: 'x'.repeat(2001) })] }, 'body_too_long', 0]
  ];

  it('recusa com o campo, o código e o passo', async () => {
    for (const [reminderPolicy, code, index] of casos) {
      // eslint-disable-next-line no-await-in-loop
      const res = await perfil({ reminderPolicy });
      assert.equal(res.status, 400, `${code}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.field, 'reminderPolicy');
      assert.equal(res.body.code, code);
      if (index !== null) assert.equal(res.body.index, index, code);
    }
    assert.throws(() => normalizeReminderPolicy(null), ReminderPolicyError);
  });

  it('o desligado pode ficar sem canal', async () => {
    const res = await perfil({ reminderPolicy: { steps: [passo('a', 'after', 3, { enabled: false, channels: [] })] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('grava ordenada pelo dia, audita o campo e volta ao padrão com null', async () => {
    const res = await perfil({
      reminderPolicy: { steps: [passo('due', 'due', 0), passo('d7', 'before', -7, { subject: '  Linha\num  ' })] }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.changed, ['reminderPolicy']);
    assert.deepEqual(res.body.data.reminderPolicy.steps.map((p) => p.id), ['d7', 'due']);
    assert.equal(res.body.data.reminderPolicy.steps[0].subject, 'Linha um');
    assert.deepEqual(res.body.data.reminderPolicyDefault, defaultReminderPolicy());
    const trilha = await getDb()('platform_audit').where({ action: 'platform.profile_changed' }).orderBy('id', 'desc').first();
    assert.match(String(trilha.detail), /reminderPolicy/);

    // A mesma régua de novo: nada mudou.
    const igual = await perfil({
      reminderPolicy: { steps: [passo('due', 'due', 0), passo('d7', 'before', -7, { subject: 'Linha um' })] }
    });
    assert.deepEqual(igual.body.data.changed, []);

    const padrao = await perfil({ reminderPolicy: null });
    assert.deepEqual(padrao.body.data.changed, ['reminderPolicy']);
    assert.deepEqual(padrao.body.data.reminderPolicy, defaultReminderPolicy());
  });

  it('a régua gravada que deixou de valer volta à padrão na leitura', async () => {
    await regua(null);
    const { default: AppState } = await import('../src/models/AppState.js');
    const caixa = await getDb()('tenants').where({ kind: 'platform' }).first();
    const atual = JSON.parse(await runInTenant(caixa.id, () => AppState.get('platform_profile')) || '{}');
    await runInTenant(caixa.id, () => AppState.upsert('platform_profile', JSON.stringify({
      ...atual, reminderPolicy: { steps: [{ id: 'X X', kind: 'nada' }] }
    })));
    invalidatePlatformProfile();
    assert.deepEqual((await readProfile()).reminderPolicy, defaultReminderPolicy());
    await regua(null);
  });
});

describe('o "Enviar teste para mim"', () => {
  const testar = (body) => call(`${panelUrl}/api/platform/settings/reminder-policy/test`, {
    method: 'POST', body, headers: authHeaders(token)
  });

  it('sem destino de avisos é 409 no_destination', async () => {
    await saveProfile({ notifyEmail: '', notifyWhatsapp: '' });
    const res = await testar({ stepId: 'before' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'no_destination');
  });

  it('passo que não existe é 404; stepId inválido é 400', async () => {
    assert.equal((await testar({ stepId: 'nao-existe' })).status, 404);
    assert.equal((await testar({ stepId: '<x>' })).status, 400);
    assert.equal((await testar({})).status, 400);
  });

  it('manda o passo com os dados de exemplo para os destinos, pelos canais do passo, e audita', async () => {
    await saveProfile({ notifyEmail: 'ops@plataforma.test', notifyWhatsapp: '11977776666' });
    await regua([passo('d7', 'before', -7, { channels: ['email'], subject: 'Lembrete {empresa}', body: '{plano} por {valor} em {vencimento}: {link}' })]);
    const res = await testar({ stepId: 'd7' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.channels, { email: true });
    assert.equal(whatsapps.length, 0, 'o passo é só e-mail');
    const email = ultima();
    assert.match(email, /To: ops@plataforma\.test/);
    assert.match(email, /Subject: \[Teste\] Lembrete Provedor Exemplo/);
    assert.match(email, /Pro por R\$\s199,90 em \d{4}-\d{2}-\d{2}: https:\/\/painel\.exemplo\.com\/fatura/);
    assert.equal((await enviados()).length, 0, 'o teste não é lembrete de ninguém');
    const trilha = await getDb()('platform_audit').where({ action: 'platform.reminder_test' }).orderBy('id', 'desc').first();
    assert.ok(trilha);
    assert.match(String(trilha.detail), /d7/);
    assert.equal(String(trilha.detail).includes('ops@plataforma.test'), false, 'sem o destino na trilha');
  });

  it('o passo padrão sem texto usa o texto do i18n', async () => {
    await saveProfile({ notifyEmail: 'ops@plataforma.test', notifyWhatsapp: '11977776666' });
    const res = await testar({ stepId: 'due' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.channels, { whatsapp: true, email: true });
    assert.match(whatsapps[0].text, /^\*\[Teste\] A assinatura do Provedor Exemplo venceu/);
  });

  it('nada saiu: 502 send_failed', async () => {
    await saveProfile({ notifyEmail: 'ops@plataforma.test', notifyWhatsapp: '' });
    const antes = process.env.SMTP_URL;
    const fechado = smtpDeMentira().server;
    await new Promise((resolve) => fechado.listen(0, '127.0.0.1', resolve));
    const porta = fechado.address().port;
    await new Promise((done) => fechado.close(done));
    process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${porta}?ignoreTLS=true`;
    resetMailTransport();
    try {
      const res = await testar({ stepId: 'before' });
      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.equal(res.body.code, 'send_failed');
    } finally {
      process.env.SMTP_URL = antes;
      resetMailTransport();
    }
  });

  it('só o administrador da plataforma', async () => {
    const res = await call(`${panelUrl}/api/platform/settings/reminder-policy/test`, { method: 'POST', body: { stepId: 'before' } });
    assert.equal(res.status, 401);
  });
});
