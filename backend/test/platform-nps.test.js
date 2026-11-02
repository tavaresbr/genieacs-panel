import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A pesquisa de satisfação dos provedores (0123): a conta do NPS, a leitura
 * da nota, as etapas do agendador (uma vez por etapa, quem fica de fora), o
 * vencimento, a página pública (token inválido, vencido, resposta repetida),
 * a resposta pelo WhatsApp, o sinal de risco, o envio manual do console e o
 * card de risco da aba Início.
 *
 * Os canais são trocados por funções que só anotam (`NpsService.senders`).
 * As datas são todas ao segundo: o MySQL guarda ao segundo e ARREDONDA os
 * milissegundos.
 */
process.env.EDITION = 'saas';
// Sem domínio-base no teste: o link sai do endereço público do deploy.
process.env.PUBLIC_BASE_URL = 'https://painel.exemplo.test';

const {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { runUnscoped } = await import('../src/config/tenantContext.js');
const { tinsert } = await import('../src/config/database.js');
const {
  default: NpsService, computeNps, lerNotaNps, dueWave, riskSignals, isAtRisk, autoSkipReason,
  hashToken, paidStartOf, EDIT_WINDOW_DAYS, EXPIRE_DAYS
} = await import('../src/services/npsService.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: PlatformOverviewService } = await import('../src/services/platformOverviewService.js');

const DIA = 24 * 60 * 60 * 1000;
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const agora = () => aoSegundo(Date.now());

let panelUrl;
let token;
let plano;
const ids = {};
let enviados = [];
const sendersOriginais = NpsService.senders;

const LIMPA = {
  status: 'active', trial_ends_at: null, renews_at: null, canceled_at: null,
  billing_exempt_at: null, billing_exempt_until: null, suspended_reason: null,
  paused_until: null, pause_started_at: null, cancel_at: null, proration_due_at: null,
  card_failed_at: null, pending_plan_id: null, coupon_id: null
};

async function assinatura(tenantId, patch) {
  await Subscription.upsertForTenant(tenantId, { ...LIMPA, plan_id: plano.id, ...patch });
  await SubscriptionService.invalidate(tenantId);
}

/** O primeiro pagamento do provedor, `dias` atrás. */
async function pagou(tenantId, dias, ref) {
  await getDb()('billing_events').insert({
    tenant_id: tenantId,
    type: 'payment.recorded',
    amount_cents: 9900,
    currency: 'BRL',
    provider: 'manual',
    external_id: ref,
    created_at: aoSegundo(Date.now() - dias * DIA)
  });
}

/** As linhas da pesquisa, de todos — o teste olha de cima. */
const linhas = () => runUnscoped('test reads every NPS row', () => getDb()('platform_nps').orderBy('id'));

/** Cria uma pesquisa com um token conhecido, direto no banco. */
async function pesquisa(tenantId, { raw, wave = 'manual', status = 'pending', askedDaysAgo = 1, score = null, answeredDaysAgo = null, comment = null }) {
  return runInTenant(tenantId, async () => {
    await tinsert('platform_nps', {
      tenant_id: tenantId,
      wave,
      wave_key: wave === 'manual' ? null : wave,
      token_hash: hashToken(raw),
      status,
      score,
      comment,
      channel: 'email',
      asked_at: aoSegundo(Date.now() - askedDaysAgo * DIA),
      answered_at: answeredDaysAgo === null ? null : aoSegundo(Date.now() - answeredDaysAgo * DIA)
    });
  });
}

const TOKEN = (letra) => letra.repeat(43);

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  ids.alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'nps', password: 'nps-senha-1', email: 'nps@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  for (const slug of ['beta', 'gama', 'delta']) {
    await db('tenants').insert({ slug, name: slug.toUpperCase(), status: 'active', kind: 'provider' });
    ids[slug] = (await db('tenants').where({ slug }).first()).id;
  }
  await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  ids.plataforma = (await db('tenants').where({ slug: 'plataforma' }).first()).id;
  for (const slug of ['alfa', 'beta', 'gama', 'delta', 'plataforma']) {
    await db('tenants').where({ id: ids[slug] }).update({ billing_email: `${slug}@exemplo.test`, billing_phone: '93991935695' });
  }
  plano = await Plan.create({
    code: 'nps-pro', name: 'Pro', price_cents: 9900, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
  NpsService.senders = {
    email: async (to, msg) => { enviados.push({ canal: 'email', to, ...msg }); return true; },
    whatsapp: async (to, text) => { enviados.push({ canal: 'whatsapp', to, text }); return true; }
  };
});

after(async () => {
  NpsService.senders = sendersOriginais;
  await stopTestServers();
});

beforeEach(async () => {
  enviados = [];
  await runUnscoped('test clears every NPS row', () => getDb()('platform_nps').del());
  await runUnscoped('test clears every payment', () => getDb()('billing_events').del());
  await runUnscoped('test clears cancellation requests', () => getDb()('cancellation_requests').del());
  for (const slug of ['alfa', 'beta', 'gama', 'delta']) {
    await assinatura(ids[slug], { status: 'canceled', canceled_at: agora() });
  }
});

describe('a conta e a leitura', () => {
  it('NPS = % de promotores menos % de detratores, com a distribuição', () => {
    const r = computeNps([10, 9, 9, 8, 7, 6, 0, 3, 10, 5]);
    assert.equal(r.total, 10);
    assert.equal(r.promoters, 4);
    assert.equal(r.passives, 2);
    assert.equal(r.detractors, 4);
    assert.equal(r.nps, 0);
    assert.equal(r.distribution[9], 2);
    assert.equal(r.distribution[10], 2);
    assert.equal(r.distribution.reduce((a, b) => a + b, 0), 10);
    assert.equal(computeNps([10, 10, 9, 6]).nps, 50);
    assert.equal(computeNps([0]).nps, -100);
    assert.equal(computeNps([]).nps, null);
    // Fora da escala não conta.
    assert.equal(computeNps([11, -1, 'x', 7]).total, 1);
  });

  it('lê só a nota sozinha de 0 a 10', () => {
    assert.equal(lerNotaNps('8'), 8);
    assert.equal(lerNotaNps(' 10! '), 10);
    assert.equal(lerNotaNps('nota 0'), 0);
    assert.equal(lerNotaNps('7/10'), 7);
    assert.equal(lerNotaNps('9 de 10'), 9);
    assert.equal(lerNotaNps('11'), null);
    assert.equal(lerNotaNps('2 boletos'), null);
    assert.equal(lerNotaNps('quero a segunda via'), null);
    assert.equal(lerNotaNps(''), null);
  });

  it('a etapa da janela: d30 de 30 a 44 dias, d90 de 90 a 104', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const antes = (dias) => now.getTime() - dias * DIA;
    assert.equal(dueWave({ startMs: antes(29), now }), null);
    assert.equal(dueWave({ startMs: antes(30), now }), 'd30');
    assert.equal(dueWave({ startMs: antes(43), now }), 'd30');
    assert.equal(dueWave({ startMs: antes(45), now }), null);
    assert.equal(dueWave({ startMs: antes(90), now }), 'd90');
    assert.equal(dueWave({ startMs: antes(120), now }), null);
    assert.equal(dueWave({ startMs: null, now }), null);
  });

  it('o início pago: o primeiro pagamento; sem ele, o fim do teste de quem já tem período pago', () => {
    assert.equal(paidStartOf({ subscription: null, firstPaymentAt: new Date(1000) }), 1000);
    const fimDoTeste = new Date('2026-01-10T00:00:00Z');
    assert.equal(paidStartOf({ subscription: { status: 'active', renews_at: new Date(), trial_ends_at: fimDoTeste } }), fimDoTeste.getTime());
    assert.equal(paidStartOf({ subscription: { status: 'active', renews_at: null, trial_ends_at: fimDoTeste } }), null);
    assert.equal(paidStartOf({ subscription: { status: 'trial', renews_at: new Date(), trial_ends_at: fimDoTeste } }), null);
  });

  it('quem fica de fora da automática', () => {
    const t = { kind: 'provider', status: 'active' };
    assert.equal(autoSkipReason(t, { status: 'active' }), null);
    assert.equal(autoSkipReason(t, { status: 'past_due' }), null);
    assert.equal(autoSkipReason(t, { status: 'trial' }), 'trial');
    assert.equal(autoSkipReason(t, { status: 'canceled' }), 'canceled');
    assert.equal(autoSkipReason(t, { status: 'suspended' }), 'suspended');
    assert.equal(autoSkipReason(t, { status: 'active', billing_exempt_at: new Date() }), 'exempt');
    assert.equal(autoSkipReason({ kind: 'platform', status: 'active' }, { status: 'active' }), 'platform');
    assert.equal(autoSkipReason(t, null), 'no_subscription');
  });

  it('o sinal de risco: detrator com atraso, cartão recusado, cancelamento ou pausa', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const em = (dias) => new Date(now.getTime() + dias * DIA);
    const viva = { status: 'active', renews_at: em(10) };
    assert.deepEqual(riskSignals({ subscription: viva, now }), []);
    assert.deepEqual(riskSignals({ subscription: { status: 'active', renews_at: em(-2) }, now }), ['overdue']);
    assert.deepEqual(riskSignals({ subscription: viva, openCharges: [{ status: 'pending', due_date: '2026-05-20' }], now }), ['overdue']);
    assert.deepEqual(riskSignals({ subscription: viva, openCharges: [{ status: 'pending', due_date: '2026-06-20' }], now }), []);
    assert.deepEqual(riskSignals({ subscription: { ...viva, card_failed_at: em(-1) }, now }), ['card_refused']);
    assert.deepEqual(riskSignals({ subscription: viva, openCancellation: true, now }), ['cancellation']);
    assert.deepEqual(riskSignals({ subscription: { ...viva, cancel_at: em(10) }, now }), ['cancellation']);
    // A pausa correndo não é atraso — é pausa.
    assert.deepEqual(riskSignals({
      subscription: { status: 'active', renews_at: em(-5), paused_until: em(20), pause_started_at: em(-10) }, now
    }), ['paused']);
    assert.equal(isAtRisk(6, ['overdue']), true);
    assert.equal(isAtRisk(7, ['overdue']), false);
    assert.equal(isAtRisk(3, []), false);
  });
});

describe('o agendador', () => {
  it('manda a d30 uma vez só, por e-mail e WhatsApp, com o link', async () => {
    await assinatura(ids.beta, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA) });
    await pagou(ids.beta, 31, 'p-beta');
    const primeira = await NpsService.schedulerPass({ force: true });
    assert.deepEqual(primeira.sent, [{ tenantId: ids.beta, wave: 'd30' }]);
    assert.deepEqual(enviados.map((e) => e.canal).sort(), ['email', 'whatsapp']);
    const email = enviados.find((e) => e.canal === 'email');
    assert.equal(email.to, 'beta@exemplo.test');
    const link = email.text.match(/https:\/\/painel\.exemplo\.test\/nps#([A-Za-z0-9_-]+)/);
    assert.ok(link, email.text);
    const [linha] = await linhas();
    assert.equal(linha.wave, 'd30');
    assert.equal(linha.status, 'pending');
    assert.equal(linha.channel, 'email,whatsapp');
    // O banco guarda o hash, nunca o token.
    assert.equal(linha.token_hash, hashToken(link[1]));
    assert.ok(!JSON.stringify(linha).includes(link[1]));

    enviados = [];
    const segunda = await NpsService.schedulerPass({ force: true });
    assert.deepEqual(segunda.sent, []);
    assert.equal(enviados.length, 0);
    assert.equal((await linhas()).length, 1);
  });

  it('a etapa repetida bate no índice único, mesmo chamada direto', async () => {
    await assinatura(ids.beta, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA) });
    const tenant = await getDb()('tenants').where({ id: ids.beta }).first();
    assert.equal((await NpsService.ask(tenant, { wave: 'd90' })).sent, true);
    const de_novo = await NpsService.ask(tenant, { wave: 'd90' });
    assert.deepEqual(de_novo, { sent: false, reason: 'already_sent' });
    // A manual pode repetir.
    assert.equal((await NpsService.ask(tenant, { wave: 'manual' })).sent, true);
    assert.equal((await NpsService.ask(tenant, { wave: 'manual' })).sent, true);
    assert.equal((await linhas()).length, 3);
  });

  it('não manda a teste, isento, cancelado, suspenso nem à caixa da plataforma', async () => {
    await assinatura(ids.alfa, { status: 'trial', trial_ends_at: aoSegundo(Date.now() + 5 * DIA) });
    await assinatura(ids.beta, { status: 'active', billing_exempt_at: agora() });
    await assinatura(ids.gama, { status: 'canceled', canceled_at: agora() });
    await assinatura(ids.delta, { status: 'suspended', suspended_reason: 'manual' });
    await assinatura(ids.plataforma, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA) });
    for (const slug of ['alfa', 'beta', 'gama', 'delta', 'plataforma']) await pagou(ids[slug], 31, `p-${slug}`);
    const r = await NpsService.schedulerPass({ force: true });
    assert.deepEqual(r.sent, []);
    assert.equal(enviados.length, 0);
    assert.equal((await linhas()).length, 0);
  });

  it('sem pagamento nenhum não há início pago, e fora da janela não manda', async () => {
    await assinatura(ids.beta, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA) });
    await assinatura(ids.gama, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA) });
    await pagou(ids.gama, 60, 'p-gama');
    const r = await NpsService.schedulerPass({ force: true });
    assert.deepEqual(r.sent, []);
  });

  it('nada saiu: a linha some e a etapa fica livre para a próxima passada', async () => {
    await assinatura(ids.beta, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA) });
    await pagou(ids.beta, 31, 'p-beta2');
    const ok = NpsService.senders;
    NpsService.senders = { email: async () => false, whatsapp: async () => { throw new Error('fora'); } };
    try {
      const r = await NpsService.schedulerPass({ force: true });
      assert.deepEqual(r.sent, []);
      assert.equal((await linhas()).length, 0);
    } finally {
      NpsService.senders = ok;
    }
    const r = await NpsService.schedulerPass({ force: true });
    assert.deepEqual(r.sent, [{ tenantId: ids.beta, wave: 'd30' }]);
  });

  it('não pergunta de novo a quem recebeu outra pesquisa há menos de 30 dias', async () => {
    await assinatura(ids.beta, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA) });
    await pagou(ids.beta, 92, 'p-beta3');
    await pesquisa(ids.beta, { raw: TOKEN('m'), wave: 'manual', askedDaysAgo: 5 });
    const r = await NpsService.schedulerPass({ force: true });
    assert.deepEqual(r.sent, []);
  });

  it('vence a pendente depois de 30 dias', async () => {
    await pesquisa(ids.beta, { raw: TOKEN('v'), askedDaysAgo: EXPIRE_DAYS + 1 });
    await pesquisa(ids.beta, { raw: TOKEN('w'), askedDaysAgo: 2 });
    assert.equal(await NpsService.expireStale(), 1);
    const [velha, nova] = await linhas();
    assert.equal(velha.status, 'expired');
    assert.equal(nova.status, 'pending');
  });
});

describe('a página pública', () => {
  const lookup = (tok) => call(`${panelUrl}/api/public/nps/lookup`, { method: 'POST', body: { token: tok } });
  const answer = (tok, body) => call(`${panelUrl}/api/public/nps/answer`, { method: 'POST', body: { token: tok, ...body } });

  it('token desconhecido ou malformado: 404 sem nada', async () => {
    for (const tok of [TOKEN('z'), 'curto', '', null, '../../etc']) {
      const r = await lookup(tok);
      assert.equal(r.status, 404, String(tok));
      assert.equal(r.body.code, 'not_found');
      assert.equal(r.body.data, undefined);
      const a = await answer(tok, { score: 8 });
      assert.equal(a.status, 404);
    }
  });

  it('lê e responde; a nota muda dentro de 7 dias da primeira resposta', async () => {
    await pesquisa(ids.beta, { raw: TOKEN('a') });
    const lido = await lookup(TOKEN('a'));
    assert.equal(lido.status, 200);
    assert.equal(lido.body.data.status, 'pending');
    assert.equal(lido.body.data.canAnswer, true);
    // Nada do provedor na página.
    assert.ok(!JSON.stringify(lido.body).includes('BETA'));

    assert.equal((await answer(TOKEN('a'), { score: 11 })).status, 400);
    assert.equal((await answer(TOKEN('a'), { score: 'oito' })).status, 400);
    assert.equal((await answer(TOKEN('a'), {})).body.code, 'invalid_score');

    const r = await answer(TOKEN('a'), { score: 4, comment: `  ${'x'.repeat(1200)}  ` });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'answered');
    assert.equal(r.body.data.score, 4);
    assert.equal(r.body.data.comment.length, 1000);
    const [linha] = await linhas();
    assert.equal(linha.answer_channel, 'link');
    const primeira = linha.answered_at;

    const mudou = await answer(TOKEN('a'), { score: 9, comment: 'melhorou' });
    assert.equal(mudou.status, 200);
    const [depois] = await linhas();
    assert.equal(Number(depois.score), 9);
    assert.equal(depois.comment, 'melhorou');
    // Editar não estica o prazo: a primeira resposta continua sendo a âncora.
    assert.equal(String(depois.answered_at), String(primeira));
  });

  it('passados 7 dias da primeira resposta, a nota fica (409)', async () => {
    await pesquisa(ids.beta, {
      raw: TOKEN('b'), status: 'answered', score: 3, askedDaysAgo: 12, answeredDaysAgo: EDIT_WINDOW_DAYS + 1
    });
    const lido = await lookup(TOKEN('b'));
    assert.equal(lido.status, 200);
    assert.equal(lido.body.data.canAnswer, false);
    const r = await answer(TOKEN('b'), { score: 10 });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'already_answered');
    const [linha] = await linhas();
    assert.equal(Number(linha.score), 3);
  });

  it('vencida: 410, para ler e para responder', async () => {
    await pesquisa(ids.beta, { raw: TOKEN('c'), askedDaysAgo: EXPIRE_DAYS + 2 });
    assert.equal((await lookup(TOKEN('c'))).status, 410);
    const r = await answer(TOKEN('c'), { score: 7 });
    assert.equal(r.status, 410);
    assert.equal(r.body.code, 'expired');
    await pesquisa(ids.gama, { raw: TOKEN('d'), status: 'expired', askedDaysAgo: 3 });
    assert.equal((await answer(TOKEN('d'), { score: 7 })).status, 410);
  });
});

describe('a resposta pelo WhatsApp (tryCaptureWhatsappReply)', () => {
  it('grava a nota da pendente do provedor e devolve o agradecimento', async () => {
    await pesquisa(ids.beta, { raw: TOKEN('e') });
    await pesquisa(ids.gama, { raw: TOKEN('f') });
    const r = await NpsService.tryCaptureWhatsappReply({ tenantId: ids.beta, text: 'nota 7' });
    assert.equal(r.captured, true);
    assert.equal(r.score, 7);
    assert.match(r.reply, /7/);
    const [beta, gama] = await linhas();
    assert.equal(beta.status, 'answered');
    assert.equal(Number(beta.score), 7);
    assert.equal(beta.answer_channel, 'whatsapp');
    // O vizinho não foi tocado.
    assert.equal(gama.status, 'pending');
    // Já respondida: o próximo número é conversa, não nota.
    assert.deepEqual(await NpsService.tryCaptureWhatsappReply({ tenantId: ids.beta, text: '9' }), { captured: false });
  });

  it('não é nota, não há pendente, ou está vencida: não captura', async () => {
    await pesquisa(ids.beta, { raw: TOKEN('g') });
    assert.deepEqual(await NpsService.tryCaptureWhatsappReply({ tenantId: ids.beta, text: 'segunda via' }), { captured: false });
    assert.deepEqual(await NpsService.tryCaptureWhatsappReply({ tenantId: ids.gama, text: '8' }), { captured: false });
    await pesquisa(ids.delta, { raw: TOKEN('h'), askedDaysAgo: EXPIRE_DAYS + 1 });
    assert.deepEqual(await NpsService.tryCaptureWhatsappReply({ tenantId: ids.delta, text: '8' }), { captured: false });
    assert.deepEqual(await NpsService.tryCaptureWhatsappReply({ tenantId: null, text: '8' }), { captured: false });
    const [beta] = await linhas();
    assert.equal(beta.status, 'pending');
  });
});

describe('o console', () => {
  const enviar = (id, tok = token) => call(`${panelUrl}/api/platform/tenants/${id}/nps`, {
    method: 'POST', body: {}, headers: tok ? authHeaders(tok) : {}
  });

  it('o envio manual: só para o provedor da URL, na trilha, e não repete na semana', async () => {
    await assinatura(ids.beta, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA) });
    assert.equal((await enviar(ids.beta, null)).status, 401);
    const r = await enviar(ids.beta);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.channels, ['email', 'whatsapp']);
    const todas = await linhas();
    assert.equal(todas.length, 1);
    assert.equal(Number(todas[0].tenant_id), ids.beta);
    assert.equal(todas[0].wave, 'manual');
    assert.ok(enviados.every((e) => e.canal !== 'email' || e.to === 'beta@exemplo.test'));
    const trilha = await getDb()('platform_audit').where({ action: 'tenant.nps_sent', tenant_id: ids.beta });
    assert.equal(trilha.length, 1);

    const de_novo = await enviar(ids.beta);
    assert.equal(de_novo.status, 409);
    assert.equal(de_novo.body.code, 'recent');

    assert.equal((await enviar(ids.plataforma)).status, 404);
    assert.equal((await enviar(999999)).status, 404);
    assert.equal((await enviar('abc')).status, 400);
  });

  it('o relatório: NPS, distribuição, tendência, comentários e detratores com risco', async () => {
    await assinatura(ids.alfa, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA) });
    // Beta: detrator e devendo (renovação vencida) — em risco.
    await assinatura(ids.beta, { status: 'active', renews_at: aoSegundo(Date.now() - 3 * DIA) });
    // Gama: detrator sem sinal nenhum.
    await assinatura(ids.gama, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA) });
    // Delta: detrator com cartão recusado, mas a ÚLTIMA nota é 9 — não é detrator.
    await assinatura(ids.delta, { status: 'active', renews_at: aoSegundo(Date.now() + 20 * DIA), card_failed_at: agora() });
    await pesquisa(ids.alfa, { raw: TOKEN('i'), status: 'answered', score: 10, answeredDaysAgo: 1, comment: 'ótimo' });
    await pesquisa(ids.beta, { raw: TOKEN('j'), status: 'answered', score: 2, answeredDaysAgo: 2, comment: 'suporte lento' });
    await pesquisa(ids.gama, { raw: TOKEN('k'), status: 'answered', score: 6, answeredDaysAgo: 2 });
    await pesquisa(ids.delta, { raw: TOKEN('l'), wave: 'd30', status: 'answered', score: 3, askedDaysAgo: 70, answeredDaysAgo: 65 });
    await pesquisa(ids.delta, { raw: TOKEN('n'), wave: 'd90', status: 'answered', score: 9, askedDaysAgo: 4, answeredDaysAgo: 3 });
    await pesquisa(ids.alfa, { raw: TOKEN('o'), askedDaysAgo: 1 });

    const r = await call(`${panelUrl}/api/platform/reports/nps`, { headers: authHeaders(token) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    // 10, 2, 6, 3, 9 → 2 promotores, 3 detratores: (2-3)/5 = -20.
    assert.equal(d.summary.total, 5);
    assert.equal(d.summary.nps, -20);
    assert.equal(d.summary.sent, 6);
    assert.equal(d.summary.answered, 5);
    assert.equal(d.summary.distribution[10], 1);
    assert.equal(d.trend.length, 12);
    assert.equal(d.trend.reduce((s, m) => s + m.responses, 0), 5);
    assert.deepEqual(d.comments.map((c) => c.comment).sort(), ['suporte lento', 'ótimo']);
    assert.deepEqual(d.detractors.map((x) => x.tenant.id), [ids.beta, ids.gama]);
    assert.deepEqual(d.detractors[0].signals, ['overdue']);
    assert.equal(d.detractors[0].atRisk, true);
    assert.equal(d.detractors[1].atRisk, false);
    assert.equal(d.atRisk, 1);
    assert.ok(d.providers.some((p) => p.id === ids.beta));
    assert.ok(!d.providers.some((p) => p.id === ids.plataforma));

    // O período corta as respostas antigas.
    const recente = await call(`${panelUrl}/api/platform/reports/nps?from=${new Date(Date.now() - 10 * DIA).toISOString().slice(0, 10)}`, { headers: authHeaders(token) });
    assert.equal(recente.body.data.summary.total, 4);
    assert.equal((await call(`${panelUrl}/api/platform/reports/nps?from=ontem`, { headers: authHeaders(token) })).status, 400);

    // O card de risco da aba Início: a mesma conta.
    const visao = await PlatformOverviewService.build();
    assert.deepEqual(visao.risk, { detractors: 2, atRisk: 1 });

    // Um pedido de cancelamento em aberto põe o gama em risco.
    await runInTenant(ids.gama, () => tinsert('cancellation_requests', {
      tenant_id: ids.gama, reason: 'price', created_at: agora()
    }));
    const depois = await NpsService.riskSummary();
    assert.deepEqual(depois, { detractors: 2, atRisk: 2 });
  });

  it('o relatório é só do console', async () => {
    assert.equal((await call(`${panelUrl}/api/platform/reports/nps`)).status, 401);
  });
});
