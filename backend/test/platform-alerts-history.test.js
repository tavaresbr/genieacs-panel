import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O histórico dos alertas da plataforma: a lista paginada da fila, com
 * filtros e contadores por estado, e o "Reenviar" do que falhou ou foi pulado.
 *
 * Os canais são trocados por funções que só anotam, como em
 * platform-alerts.test.js. As datas são todas ao segundo: o MySQL guarda ao
 * segundo e ARREDONDA os milissegundos.
 */
// SaaS: o console (`/api/platform`) só existe nessa edição.
process.env.EDITION = 'saas';

const { authHeaders, call, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { default: PlatformAlertService } = await import('../src/services/platformAlertService.js');
const { saveProfile, invalidatePlatformProfile, alertsConfig } = await import('../src/services/platformProfileService.js');

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let panelUrl;
let token;
let comumToken;
let alfa;
let enviados = [];
const sendersOriginais = PlatformAlertService.senders;
let seq = 0;

/** Uma linha direto na fila, como o serviço a gravaria. */
async function linha({ event = 'card_refused', status = 'failed', tenantId = null, payload = {}, createdAt = Date.now(), ...extra } = {}) {
  seq += 1;
  const db = getDb();
  await db('platform_alerts').insert({
    event,
    tenant_id: tenantId,
    payload: JSON.stringify(payload),
    dedupe_key: `${event}:hist-${seq}`,
    status,
    attempts: extra.attempts ?? (status === 'failed' ? 5 : 0),
    next_attempt_at: null,
    last_error: extra.last_error ?? (status === 'failed' ? 'send_failed' : status === 'skipped' ? 'no_destination' : null),
    sent_at: extra.sent_at ?? null,
    created_at: aoSegundo(createdAt)
  });
  return Number((await db('platform_alerts').where({ dedupe_key: `${event}:hist-${seq}` }).first('id')).id);
}

const listar = (query = '', t = token) => call(`${panelUrl}/api/platform/alerts${query}`, { headers: t ? authHeaders(t) : {} });
const reenviar = (id, t = token) => call(`${panelUrl}/api/platform/alerts/${id}/resend`, {
  method: 'POST', body: {}, headers: t ? authHeaders(t) : {}
});

async function ligar(eventos) {
  const events = {};
  for (const evento of PlatformAlertService.EVENTS) {
    events[evento] = { enabled: eventos.includes(evento), channels: ['whatsapp', 'email'] };
  }
  await saveProfile({ alerts: { events, dailyDigest: { enabled: false, hour: 8 }, bigOverdueCents: null } });
  invalidatePlatformProfile();
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  invalidatePlatformProfile();
  const hire = await call(`${panelUrl}/api/users`, {
    method: 'POST', headers: authHeaders(token),
    body: { username: 'comum', password: 'comum-senha-1', role: 'admin', email: 'comum@exemplo.test' }
  });
  assert.equal(hire.status, 201, JSON.stringify(hire.body));
  const signIn = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'comum', password: 'comum-senha-1', email: 'comum@exemplo.test' }
  });
  comumToken = signIn.body.data.token;
  assert.ok(comumToken);
  PlatformAlertService.senders = {
    whatsapp: async (to, msg) => { enviados.push({ canal: 'whatsapp', to, ...msg }); return true; },
    email: async (to, msg) => { enviados.push({ canal: 'email', to, ...msg }); return true; }
  };
});

after(async () => {
  PlatformAlertService.senders = sendersOriginais;
  await stopTestServers();
});

beforeEach(async () => {
  enviados = [];
  await getDb()('platform_alerts').del();
  await getDb()('platform_audit').where({ action: 'platform.alert_resent' }).del();
  await saveProfile({ notifyWhatsapp: '93991935695', notifyEmail: 'ops@plataforma.test' });
  await ligar([]);
});

describe('quem pode', () => {
  it('sem token é 401; fora do console é 404, nas duas rotas', async () => {
    const id = await linha();
    assert.equal((await listar('', null)).status, 401);
    assert.equal((await reenviar(id, null)).status, 401);
    assert.equal((await listar('', comumToken)).status, 404);
    assert.equal((await reenviar(id, comumToken)).status, 404);
    // E nada mudou.
    assert.equal((await getDb()('platform_alerts').where({ id }).first()).status, 'failed');
  });
});

describe('a lista', () => {
  it('vem da mais nova para a mais velha, paginada', async () => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await linha({ status: 'sent', createdAt: Date.now() - (5 - i) * HORA }));
    const p1 = await listar('?pageSize=2');
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    const d1 = p1.body.data;
    assert.equal(d1.total, 5);
    assert.equal(d1.page, 1);
    assert.equal(d1.pageSize, 2);
    assert.deepEqual(d1.alerts.map((a) => a.id), [ids[4], ids[3]]);
    const p3 = (await listar('?pageSize=2&page=3')).body.data;
    assert.deepEqual(p3.alerts.map((a) => a.id), [ids[0]]);
    const sem = (await listar()).body.data;
    assert.equal(sem.pageSize, 25);
    assert.equal(sem.alerts.length, 5);
  });

  it('filtra por estado, evento e dia; os contadores ignoram o estado', async () => {
    const agora = Date.now();
    await linha({ event: 'card_refused', status: 'failed', createdAt: agora });
    await linha({ event: 'card_refused', status: 'sent', createdAt: agora });
    await linha({ event: 'nfse_error', status: 'skipped', createdAt: agora });
    await linha({ event: 'card_refused', status: 'pending', createdAt: agora - 10 * DIA });

    const falhas = (await listar('?status=failed')).body.data;
    assert.equal(falhas.total, 1);
    assert.equal(falhas.alerts[0].status, 'failed');
    assert.deepEqual(falhas.counts, { pending: 1, sent: 1, failed: 1, skipped: 1 });

    const cartao = (await listar('?event=card_refused&status=sent')).body.data;
    assert.equal(cartao.total, 1);
    assert.deepEqual(cartao.counts, { pending: 1, sent: 1, failed: 1, skipped: 0 });

    // O dia em Brasília: hoje (de/até iguais) deixa de fora o de 10 dias atrás.
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(agora));
    const doDia = (await listar(`?from=${hoje}&to=${hoje}`)).body.data;
    assert.equal(doDia.total, 3);
    assert.deepEqual(doDia.counts, { pending: 0, sent: 1, failed: 1, skipped: 1 });
    const antigo = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(agora - 10 * DIA));
    assert.equal((await listar(`?to=${antigo}`)).body.data.total, 1);
    assert.equal((await listar(`?from=${antigo}`)).body.data.total, 4);
  });

  it('o provedor apagado e o alerta sem provedor não quebram a lista', async () => {
    const db = getDb();
    await db('tenants').insert({ slug: 'efemero', name: 'Efêmero', status: 'active', kind: 'isp' });
    const efemero = Number((await db('tenants').where({ slug: 'efemero' }).first('id')).id);
    await linha({ tenantId: efemero, payload: { provider: 'Efêmero', slug: 'efemero', reason: 'x' } });
    await db('tenants').where({ id: efemero }).del();
    await linha({ tenantId: alfa, payload: { provider: 'Antigo', reason: 'y' } });
    await linha({ event: 'digest', status: 'failed', payload: { day: '2026-10-20' } });
    await linha({ event: 'test', status: 'failed' });

    const { alerts } = (await listar()).body.data;
    const [teste, resumo, doAlfa, apagado] = alerts;
    assert.equal(teste.tenant, null);
    assert.equal(teste.event, 'test');
    assert.equal(resumo.tenant, null);
    assert.match(resumo.summary, /-/);
    assert.equal(doAlfa.tenant.id, Number(alfa));
    assert.equal(doAlfa.tenant.deleted, false);
    assert.notEqual(doAlfa.tenant.name, 'Antigo', 'o nome vem do provedor que existe');
    assert.deepEqual(apagado.tenant, { id: efemero, name: 'Efêmero', slug: 'efemero', deleted: true });
    assert.match(apagado.summary, /Efêmero/);
    for (const a of alerts) {
      assert.equal(typeof a.createdAt, 'string');
      assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
    }
  });

  it('o resumo da linha não leva destino nem segredo', async () => {
    await ligar(['card_refused']);
    const r = await PlatformAlertService.enqueue('card_refused', {
      tenantId: alfa, dedupeKey: 'hist-segredo',
      payload: { reason: 'recusado', apiKey: 'chave-secreta', cardToken: 'tok-123', notifyEmail: 'x@y.z' }
    });
    assert.equal(r.enqueued, true);
    await getDb()('platform_alerts').update({ status: 'failed', last_error: 'send_failed' });
    const res = await listar();
    const corpo = JSON.stringify(res.body);
    for (const proibido of ['chave-secreta', 'tok-123', 'ops@plataforma.test', '93991935695']) {
      assert.equal(corpo.includes(proibido), false, proibido);
    }
    assert.equal(res.body.data.alerts[0].summary.length <= 200, true);
    assert.ok(res.body.data.alerts[0].summary.length > 0);
  });

  it('recusa filtros inválidos com o código certo', async () => {
    for (const [query, code] of [
      ['?status=lixo', 'invalid_status'],
      ['?status=a&status=b', 'invalid_status'],
      ['?event=nao_existe', 'invalid_event'],
      ['?from=2026-13-01', 'invalid_from'],
      ['?from=2026-02-30', 'invalid_from'],
      ['?from=ontem', 'invalid_from'],
      ['?to=2026-1-1', 'invalid_to'],
      ['?from=2026-10-10&to=2026-10-09', 'invalid_range'],
      ['?page=0', 'invalid_page'],
      ['?page=-1', 'invalid_page'],
      ['?page=1.5', 'invalid_page'],
      ['?pageSize=0', 'invalid_page_size'],
      ['?pageSize=101', 'invalid_page_size'],
      ['?pageSize=abc', 'invalid_page_size']
    ]) {
      const res = await listar(query);
      assert.equal(res.status, 400, query);
      assert.equal(res.body.code, code, query);
    }
    assert.equal((await listar('?pageSize=100&event=digest&status=skipped')).status, 200);
  });
});

describe('o reenvio', () => {
  it('failed volta para a fila, e a passada seguinte manda', async () => {
    await ligar(['card_refused']);
    const id = await linha({ tenantId: alfa, payload: { provider: 'Alfa', reason: 'x' } });
    const antes = Date.now();
    const res = await reenviar(id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.alert.id, id);
    assert.equal(res.body.data.alert.status, 'pending');
    assert.equal(res.body.data.requeued, 0);
    const linhaDb = await getDb()('platform_alerts').where({ id }).first();
    assert.equal(linhaDb.status, 'pending');
    assert.equal(Number(linhaDb.attempts), 0);
    assert.equal(linhaDb.last_error, null);
    const proxima = new Date(linhaDb.next_attempt_at).getTime();
    assert.ok(Math.abs(proxima - antes) < 5000, String(linhaDb.next_attempt_at));

    const trilha = await getDb()('platform_audit').where({ action: 'platform.alert_resent' });
    assert.equal(trilha.length, 1);
    const detalhe = JSON.parse(trilha[0].detail);
    assert.deepEqual(detalhe, { alertId: id, event: 'card_refused', from: 'failed', requeued: 0 });
    assert.equal(trilha[0].detail.includes('ops@plataforma.test'), false);

    const passada = await PlatformAlertService.processDue({ now: new Date(Date.now() + 2000) });
    assert.equal(passada.sent, 1, JSON.stringify(passada));
    assert.equal(enviados.length, 2);
    assert.equal((await getDb()('platform_alerts').where({ id }).first()).status, 'sent');
  });

  it('skipped também volta', async () => {
    const id = await linha({ status: 'skipped' });
    const res = await reenviar(id);
    assert.equal(res.status, 200);
    assert.equal((await getDb()('platform_alerts').where({ id }).first()).status, 'pending');
  });

  it('sent, pending e test são 409; inexistente é 404; id inválido é 400', async () => {
    for (const status of ['sent', 'pending']) {
      const id = await linha({ status });
      const res = await reenviar(id);
      assert.equal(res.status, 409, status);
      assert.equal(res.body.code, 'not_resendable');
      assert.equal(res.body.status, status);
      assert.equal((await getDb()('platform_alerts').where({ id }).first()).status, status);
    }
    const teste = await linha({ event: 'test', status: 'failed' });
    const r = await reenviar(teste);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'not_resendable');
    assert.equal((await getDb()('platform_alerts').where({ id: teste }).first()).status, 'failed');

    const nada = await reenviar(999999);
    assert.equal(nada.status, 404);
    assert.equal(nada.body.code, 'not_found');
    for (const ruim of ['abc', '0', '-1', '1.5']) {
      const res = await reenviar(ruim);
      assert.equal(res.status, 400, ruim);
      assert.equal(res.body.code, 'invalid_id');
    }
    assert.equal((await getDb()('platform_audit').where({ action: 'platform.alert_resent' })).length, 0);
  });

  it('dois cliques ao mesmo tempo reabrem uma vez só', async () => {
    const id = await linha();
    const respostas = await Promise.all([reenviar(id), reenviar(id)]);
    const status = respostas.map((r) => r.status).sort();
    assert.deepEqual(status, [200, 409]);
    const trilha = await getDb()('platform_audit').where({ action: 'platform.alert_resent' });
    assert.equal(trilha.length, 1);
  });

  const resumoLigado = async (enabled) => {
    await saveProfile({ alerts: { dailyDigest: { enabled, hour: 8 } } });
    invalidatePlatformProfile();
  };

  it('o resumo volta com os alertas que caíram junto, e só esses', async () => {
    await resumoLigado(true);
    const junto1 = await linha({ status: 'failed', last_error: 'digest_failed' });
    const junto2 = await linha({ event: 'nfse_error', status: 'failed', last_error: 'digest_failed' });
    const resumo = await linha({ event: 'digest', status: 'failed', payload: { day: '2026-10-20', count: 2, ids: [junto1, junto2] } });
    // De OUTRO resumo que desistiu: não volta junto.
    const deOutro = await linha({ status: 'failed', last_error: 'digest_failed' });
    const outro = await linha({ status: 'failed', last_error: 'send_failed' });
    const res = await reenviar(resumo);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.requeued, 2);
    assert.equal(res.body.data.alert.event, 'digest');
    const db = getDb();
    assert.equal((await db('platform_alerts').where({ id: resumo }).first()).status, 'pending');
    for (const id of [junto1, junto2]) {
      const l = await db('platform_alerts').where({ id }).first();
      assert.equal(l.status, 'pending');
      assert.equal(l.last_error, null);
      assert.equal(Number(l.attempts), 0);
    }
    const o = await db('platform_alerts').where({ id: outro }).first();
    assert.equal(o.status, 'failed');
    assert.equal(o.last_error, 'send_failed');
    const d = await db('platform_alerts').where({ id: deOutro }).first();
    assert.equal(d.status, 'failed');
    assert.equal(d.last_error, 'digest_failed');
    const trilha = await db('platform_audit').where({ action: 'platform.alert_resent' }).first();
    assert.equal(JSON.parse(trilha.detail).requeued, 2);
  });

  it('o resumo que desiste grava os ids dele, e o reenvio usa só esses', async () => {
    await ligar(['card_refused']);
    await resumoLigado(true);
    const falhaTudo = async () => false;
    PlatformAlertService.senders = { whatsapp: falhaTudo, email: falhaTudo };
    try {
      // Dois resumos que desistem, em dois dias, cada um com o seu alerta.
      const dia1 = new Date('2026-10-20T12:00:00Z');
      await PlatformAlertService.enqueue('card_refused', { tenantId: alfa, dedupeKey: 'dig-1', now: new Date(dia1.getTime() - HORA) });
      const config = await alertsConfig();
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await PlatformAlertService.processDigest({ now: new Date(dia1.getTime() + i * HORA), config });
        // eslint-disable-next-line no-await-in-loop
        await getDb()('platform_alerts').where({ event: 'digest', status: 'pending' }).update({ next_attempt_at: null });
      }
      const db = getDb();
      const [r1] = await db('platform_alerts').where({ event: 'digest' });
      assert.equal(r1.status, 'failed');
      const [a1] = await db('platform_alerts').where({ event: 'card_refused' });
      assert.equal(a1.last_error, 'digest_failed');
      assert.deepEqual(JSON.parse(r1.payload).ids, [Number(a1.id)]);
      // O segundo resumo, de outro dia, que também desistiu (sem passar pelo envio).
      const a2 = await linha({ status: 'failed', last_error: 'digest_failed', createdAt: Date.parse('2026-10-21T12:00:00Z') });
      await linha({ event: 'digest', status: 'failed', payload: { day: '2026-10-21', count: 1, ids: [a2] } });
      const res = await reenviar(Number(r1.id));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.requeued, 1);
      assert.equal((await db('platform_alerts').where({ id: a1.id }).first()).status, 'pending');
      assert.equal((await db('platform_alerts').where({ id: a2 }).first()).status, 'failed');
    } finally {
      PlatformAlertService.senders = {
        whatsapp: async (to, msg) => { enviados.push({ canal: 'whatsapp', to, ...msg }); return true; },
        email: async (to, msg) => { enviados.push({ canal: 'email', to, ...msg }); return true; }
      };
    }
  });

  it('o resumo antigo, sem ids, devolve só os da janela dele (do resumo anterior ao fim do dia)', async () => {
    await resumoLigado(true);
    const db = getDb();
    // Os resumos com a chave de verdade (`digest:AAAA-MM-DD`).
    const resumoDe = async (dia) => {
      await db('platform_alerts').insert({
        event: 'digest', tenant_id: null, payload: JSON.stringify({ day: dia }), dedupe_key: `digest:${dia}`,
        status: 'failed', attempts: 5, next_attempt_at: null, last_error: 'send_failed',
        created_at: aoSegundo(Date.parse(`${dia}T12:00:00Z`))
      });
      return Number((await db('platform_alerts').where({ dedupe_key: `digest:${dia}` }).first('id')).id);
    };
    await resumoDe('2026-10-18');
    const alvo = await resumoDe('2026-10-20');
    const velho = await linha({ status: 'failed', last_error: 'digest_failed', createdAt: Date.parse('2026-10-17T12:00:00Z') });
    const dentro1 = await linha({ status: 'failed', last_error: 'digest_failed', createdAt: Date.parse('2026-10-18T15:00:00Z') });
    // 23:59 de Brasília do dia 20 (02:59 UTC do dia 21): ainda é dele.
    const dentro2 = await linha({ status: 'failed', last_error: 'digest_failed', createdAt: Date.parse('2026-10-21T02:59:00Z') });
    const depois = await linha({ status: 'failed', last_error: 'digest_failed', createdAt: Date.parse('2026-10-21T03:00:00Z') });
    const res = await reenviar(alvo);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.requeued, 2);
    const estado = async (id) => (await db('platform_alerts').where({ id }).first()).status;
    assert.equal(await estado(dentro1), 'pending');
    assert.equal(await estado(dentro2), 'pending');
    assert.equal(await estado(velho), 'failed');
    assert.equal(await estado(depois), 'failed');
  });

  it('com o resumo diário desligado, o reenvio do resumo solta os alertas um a um e não deixa o resumo pendente', async () => {
    await ligar(['card_refused']);
    const junto = await linha({ tenantId: alfa, status: 'failed', last_error: 'digest_failed', payload: { provider: 'Alfa', reason: 'x' } });
    const resumo = await linha({ event: 'digest', status: 'failed', payload: { day: '2026-10-20', count: 1, ids: [junto] } });
    const res = await reenviar(resumo);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.requeued, 1);
    assert.equal(res.body.data.alert.status, 'skipped');
    assert.equal(res.body.data.alert.lastError, 'disabled');
    const passada = await PlatformAlertService.processDue({ now: new Date(Date.now() + 2000) });
    assert.equal(passada.sent, 1, JSON.stringify(passada));
    const db = getDb();
    assert.equal((await db('platform_alerts').where({ id: junto }).first()).status, 'sent');
    assert.equal((await db('platform_alerts').where({ id: resumo }).first()).status, 'skipped');
  });

  it('a passada com o resumo desligado não deixa linha de resumo pendente', async () => {
    await resumoLigado(false);
    const pendente = await linha({ event: 'digest', status: 'pending', payload: { day: '2026-10-20' } });
    await PlatformAlertService.processDue({ now: new Date(Date.now() + 2000) });
    const l = await getDb()('platform_alerts').where({ id: pendente }).first();
    assert.equal(l.status, 'skipped');
    assert.equal(l.last_error, 'disabled');
  });

  it('o relatório mensal aparece no histórico com o mês, e filtra pelo evento', async () => {
    await linha({ event: 'monthly_report', status: 'failed', payload: { month: '2026-09' } });
    const res = await listar('?event=monthly_report');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.total, 1);
    assert.match(res.body.data.alerts[0].summary, /setembro de 2026/);
    const en = await call(`${panelUrl}/api/platform/alerts?event=monthly_report`, {
      headers: { ...authHeaders(token), 'Accept-Language': 'en' }
    });
    assert.match(en.body.data.alerts[0].summary, /^Monthly report: September 2026/);
  });

  it('o "Enviar agora" reenviado volta marcado resent, e a passada o manda', async () => {
    await saveProfile({ alerts: { monthlyReport: { enabled: true, channels: ['email'], hour: 8 } } });
    invalidatePlatformProfile();
    try {
      const id = await linha({ event: 'monthly_report', status: 'failed', payload: { month: '2026-09', manual: true } });
      const res = await reenviar(id);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const l = await getDb()('platform_alerts').where({ id }).first();
      assert.equal(l.status, 'pending');
      assert.deepEqual(JSON.parse(l.payload), { month: '2026-09', manual: true, resent: true });
      await PlatformAlertService.processDue({ now: new Date(Date.now() + 2000) });
      assert.equal((await getDb()('platform_alerts').where({ id }).first()).status, 'sent');
      assert.deepEqual(enviados.map((e) => e.canal), ['email']);
    } finally {
      await saveProfile({ alerts: { monthlyReport: { enabled: false } } });
      invalidatePlatformProfile();
    }
  });
});
