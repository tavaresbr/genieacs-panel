import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A página de status (0126).
 *
 * 1. A conta: a disponibilidade do dia e dos 90 dias, o estado de cada
 *    componente pelas verificações e pelos incidentes abertos.
 * 2. As verificações nunca lançam: a dependência que falha, a que trava e a
 *    não configurada viram, respectivamente, falha gravada, falha por prazo e
 *    nada.
 * 3. A leitura pública não tem segredo: nem detalhe de erro, nem latência, nem
 *    versão, nem provedor. E o `/api/health` deixou de dizer a versão.
 * 4. O incidente no console: abrir, mudar, publicar, resolver — cada gesto na
 *    trilha da plataforma, e o resolvido não volta.
 * 5. O aviso aos provedores sai UMA vez por evento — e a manutenção, uma vez,
 *    nas 24 horas antes do início.
 *
 * Datas ao segundo: o MySQL guarda ao segundo e arredonda os milissegundos.
 */
process.env.EDITION = 'saas';
process.env.PUBLIC_BASE_URL = 'https://painel.exemplo.test';

const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const {
  default: StatusService, uptimeSeries, stateFromChecks, genieacsVerdict, worstState, lastDays, percent,
  incidentEffect, HISTORY_DAYS
} = await import('../src/services/statusService.js');
const { default: StatusNotifyService, startEventFor, MAINTENANCE_NOTICE_MS } = await import('../src/services/statusNotifyService.js');

const DIA = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const agora = () => aoSegundo(Date.now());

let panelUrl;
let portalUrl;
let token;
let estranhoToken;
const ids = {};
let enviados = [];
const sendersOriginais = StatusNotifyService.senders;
const probesOriginais = StatusService.probes;

const console_ = (caminho, options = {}, tok = token) => call(`${panelUrl}/api/platform${caminho}`, {
  ...options,
  headers: { ...(tok ? authHeaders(tok) : {}), ...(options.headers || {}) }
});

const auditoria = (acao) => getDb()('platform_audit').where({ action: acao }).orderBy('id');

async function limpar() {
  const db = getDb();
  await db('status_notification_marks').del();
  await db('status_incident_updates').del();
  await db('status_incidents').del();
  await db('status_checks').del();
  await db('status_daily').del();
  await db('platform_audit').del();
  StatusService.invalidate();
}

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  const db = getDb();
  ids.alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'status-dona', password: 'senha-da-dona-1', email: 'dona@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }

  const contratado = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { username: 'status-outro', password: 'senha-do-outro-1', role: 'admin', email: 'outro@exemplo.test' }
  });
  assert.equal(contratado.status, 201, JSON.stringify(contratado.body));
  const entrou = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'status-outro', password: 'senha-do-outro-1' }
  });
  estranhoToken = entrou.body?.data?.token;
  assert.ok(estranhoToken);

  await db('tenants').insert({ slug: 'zeta', name: 'Provedor Zetaquimera', status: 'active', kind: 'provider' });
  ids.zeta = (await db('tenants').where({ slug: 'zeta' }).first()).id;
  await db('tenants').insert({ slug: 'omega', name: 'Provedor Omega', status: 'suspended', kind: 'provider' });
  ids.omega = (await db('tenants').where({ slug: 'omega' }).first()).id;
  await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  ids.plataforma = (await db('tenants').where({ slug: 'plataforma' }).first()).id;
  await db('tenants').where({ id: ids.alfa }).update({ billing_email: 'alfa@exemplo.test', billing_phone: '93991935695' });
  await db('tenants').where({ id: ids.zeta }).update({ billing_email: 'zeta@exemplo.test', billing_phone: null });
  await db('tenants').where({ id: ids.omega }).update({ billing_email: 'omega@exemplo.test' });
  await db('tenants').where({ id: ids.plataforma }).update({ billing_email: 'plataforma@exemplo.test' });
});

after(async () => {
  StatusNotifyService.senders = sendersOriginais;
  StatusService.probes = probesOriginais;
  await stopTestServers();
});

beforeEach(async () => {
  enviados = [];
  StatusNotifyService.senders = {
    email: async (to, msg) => { enviados.push({ canal: 'email', to, ...msg }); return true; },
    whatsapp: async (to, text) => { enviados.push({ canal: 'whatsapp', to, text }); return true; }
  };
  StatusService.probes = {
    panel: async () => ({ ok: true }),
    payments: async () => null,
    whatsapp: async () => null,
    genieacs: async () => null
  };
  await limpar();
});

describe('a conta', () => {
  it('90 dias, do mais antigo a hoje', () => {
    const dias = lastDays(new Date('2026-11-02T15:00:00Z'));
    assert.equal(dias.length, HISTORY_DAYS);
    assert.equal(dias.at(-1), '2026-11-02');
    assert.equal(dias[0], '2026-08-05');
  });

  it('a disponibilidade do período soma as verificações, não tira média das porcentagens', () => {
    const now = new Date('2026-11-02T15:00:00Z');
    const r = uptimeSeries([
      { day: '2026-11-02', total: 1440, ok_count: 1440 },
      { day: '2026-11-01', total: 10, ok_count: 0 }
    ], { now });
    assert.equal(r.days.length, 90);
    assert.equal(r.days.at(-1).uptime, 100);
    assert.equal(r.days.at(-2).uptime, 0);
    assert.equal(r.days.at(-3).uptime, null);
    // (1440 + 0) / (1440 + 10) = 99.31%, e não a média (100 + 0) / 2 = 50%.
    assert.equal(r.uptime, 99.31);
    assert.equal(percent(0, 0), null);
    assert.equal(uptimeSeries([], { now }).uptime, null);
  });

  it('o estado pelas verificações: certo, instável, fora e sem dado', () => {
    const now = new Date('2026-11-02T15:00:00Z');
    const em = (min, ok) => ({ ok, checked_at: new Date(now.getTime() - min * MIN) });
    assert.equal(stateFromChecks([em(1, true), em(2, false)], { now }), 'operational');
    assert.equal(stateFromChecks([em(1, false), em(2, true), em(3, false)], { now }), 'degraded');
    assert.equal(stateFromChecks([em(1, false), em(2, 0), em(3, false)], { now }), 'major_outage');
    assert.equal(stateFromChecks([em(30, true)], { now }), 'unknown');
    assert.equal(stateFromChecks([], { now }), 'unknown');
    assert.equal(worstState('operational', 'degraded'), 'degraded');
    assert.equal(worstState('unknown', 'maintenance'), 'maintenance');
    assert.equal(worstState('major_outage', 'maintenance'), 'major_outage');
  });

  it('o incidente aberto pesa pelo impacto; a manutenção só depois de começar', () => {
    const now = new Date('2026-11-02T15:00:00Z');
    assert.equal(incidentEffect({ kind: 'incident', status: 'investigating', impact: 'critical', starts_at: now }, now), 'major_outage');
    assert.equal(incidentEffect({ kind: 'incident', status: 'resolved', impact: 'critical', starts_at: now }, now), null);
    assert.equal(incidentEffect({ kind: 'maintenance', status: 'scheduled', impact: 'none', starts_at: new Date(now.getTime() + DIA) }, now), null);
    assert.equal(incidentEffect({ kind: 'maintenance', status: 'scheduled', impact: 'none', starts_at: new Date(now.getTime() - MIN) }, now), 'maintenance');
  });

  it('o GenieACS: a fração dos agentes da semana que está viva agora', () => {
    const now = new Date('2026-11-02T15:00:00Z');
    const antes = (ms) => new Date(now.getTime() - ms);
    assert.equal(genieacsVerdict([], now), null);
    // Sumido há um mês não entra na conta.
    assert.equal(genieacsVerdict([antes(30 * DIA)], now), null);
    assert.deepEqual(genieacsVerdict([antes(MIN), antes(2 * MIN), antes(DIA)], now), { ok: true, detail: '2/3 online' });
    assert.deepEqual(genieacsVerdict([antes(MIN), antes(DIA), antes(2 * DIA)], now), { ok: false, detail: '1/3 online' });
  });
});

describe('as verificações', () => {
  it('nunca lançam: a que falha, a que trava e a não configurada', async () => {
    StatusService.probes = {
      panel: async () => ({ ok: true }),
      payments: async () => { const e = new Error('chave errada sk_live_segredo'); e.code = 'unauthorized'; e.status = 401; throw e; },
      whatsapp: () => new Promise(() => {}),
      genieacs: async () => null
    };
    const now = agora();
    const r = await StatusService.runChecks({ now, timeoutMs: 200 });
    assert.equal(r.panel.ok, true);
    assert.equal(r.payments.ok, false);
    assert.equal(r.payments.detail, 'unauthorized:401');
    assert.doesNotMatch(r.payments.detail, /segredo/);
    assert.equal(r.whatsapp.ok, false);
    assert.equal(r.whatsapp.detail, 'timeout');
    assert.equal(r.genieacs, null);

    const linhas = await getDb()('status_checks').orderBy('component');
    assert.deepEqual(linhas.map((l) => l.component), ['panel', 'payments', 'whatsapp']);
    // E a soma do dia anda junto.
    await StatusService.runChecks({ now, timeoutMs: 200 });
    const dia = await getDb()('status_daily').where({ component: 'payments' }).first();
    assert.equal(Number(dia.total), 2);
    assert.equal(Number(dia.ok_count), 0);
    const painel = await getDb()('status_daily').where({ component: 'panel' }).first();
    assert.equal(Number(painel.ok_count), 2);
  });

  it('nem quando a própria verificação não é uma função', async () => {
    StatusService.probes = { panel: null, payments: undefined, whatsapp: 42, genieacs: 'x' };
    const r = await StatusService.runChecks({ now: agora(), timeoutMs: 100 });
    for (const c of ['panel', 'payments', 'whatsapp', 'genieacs']) assert.equal(r[c].ok, false);
  });

  it('a passada do agendador também não lança, e poda o que passou dos 90 dias', async () => {
    const now = agora();
    await getDb()('status_checks').insert({ component: 'panel', ok: true, checked_at: aoSegundo(now.getTime() - 91 * DIA) });
    StatusService.lastPruneAt = 0;
    const r = await StatusService.schedulerPass({ now, force: true });
    assert.equal(r.error, undefined);
    assert.equal(r.pruned, 1);
    assert.equal(r.checks.panel.ok, true);
  });
});

describe('a leitura pública', () => {
  it('diz o estado e a barra de 90 dias, e nada de dentro', async () => {
    StatusService.probes.payments = async () => ({ ok: false, detail: 'detalhe-interno-secreto' });
    await StatusService.runChecks({ now: agora() });
    const criado = await console_('/status/incidents', {
      method: 'POST',
      body: { title: 'Lentidão nos pagamentos', message: 'Estamos verificando.', components: ['payments'], impact: 'major', notifyProviders: true }
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));

    const r = await call(`${panelUrl}/api/public/status`);
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.equal(d.status, 'partial_outage');
    const pagamentos = d.components.find((c) => c.code === 'payments');
    assert.equal(pagamentos.status, 'partial_outage');
    assert.equal(pagamentos.days.length, 90);
    assert.equal(pagamentos.days.at(-1).uptime, 0);
    assert.equal(d.components.find((c) => c.code === 'panel').status, 'operational');
    // Componente sem verificação e sem incidente não aparece.
    assert.equal(d.components.some((c) => c.code === 'genieacs'), false);
    assert.equal(d.activeIncidents.length, 1);
    assert.equal(d.activeIncidents[0].updates[0].message, 'Estamos verificando.');

    const texto = JSON.stringify(r.body);
    for (const proibido of ['detalhe-interno-secreto', 'latency', 'detail', 'checks', 'version', 'notifyProviders',
      'createdBy', 'notified', 'Zetaquimera', 'zeta@', 'tenant', 'slug']) {
      assert.equal(texto.includes(proibido), false, `a página pública vazou "${proibido}"`);
    }
  });

  it('sem sessão e guardada por 30 s', async () => {
    const r = await call(`${panelUrl}/api/public/status`);
    assert.equal(r.status, 200);
    assert.match(r.response.headers.get('cache-control') ?? '', /max-age=30/);
    const antes = r.body.data.updatedAt;
    const de_novo = await call(`${panelUrl}/api/public/status`);
    assert.equal(de_novo.body.data.updatedAt, antes);
  });

  it('o /api/health não diz mais a versão — nem o do portal; com sessão, /api/version diz', async () => {
    const h = await call(`${panelUrl}/api/health`);
    assert.equal(h.status, 200);
    assert.equal('version' in h.body, false);
    assert.equal(h.body.status, 'ok');
    const p = await call(`${portalUrl}/api/health`);
    assert.equal('version' in p.body, false);

    assert.equal((await call(`${panelUrl}/api/version`)).status, 401);
    const v = await call(`${panelUrl}/api/version`, { headers: authHeaders(token) });
    assert.equal(v.status, 200);
    assert.match(v.body.data.version, /^\d+\.\d+\.\d+/);
    const deploy = await console_('/deployment');
    assert.equal(deploy.body.data.version, v.body.data.version);
  });
});

describe('o incidente no console', () => {
  it('abre, muda, publica e resolve — tudo na trilha, e o resolvido não volta', async () => {
    const criado = await console_('/status/incidents', {
      method: 'POST',
      body: { title: 'Painel lento', message: 'Investigando.', components: ['panel'], impact: 'minor' }
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    const inc = criado.body.data.incident;
    assert.equal(inc.status, 'investigating');
    assert.equal(inc.kind, 'incident');
    assert.equal(inc.notifyProviders, false);
    assert.equal((await auditoria('status.incident_created')).length, 1);

    const mudou = await console_(`/status/incidents/${inc.id}`, { method: 'PATCH', body: { impact: 'critical', notifyProviders: true } });
    assert.equal(mudou.status, 200, JSON.stringify(mudou.body));
    assert.equal(mudou.body.data.incident.impact, 'critical');
    assert.equal(mudou.body.data.incident.notifyProviders, true);
    const linhaMudou = (await auditoria('status.incident_updated'))[0];
    assert.deepEqual(JSON.parse(linhaMudou.detail).changed.sort(), ['impact', 'notify_providers']);

    const postou = await console_(`/status/incidents/${inc.id}/updates`, { method: 'POST', body: { status: 'identified', message: 'Causa achada.' } });
    assert.equal(postou.status, 201);
    assert.equal(postou.body.data.incident.status, 'identified');
    assert.equal((await auditoria('status.incident_update_posted')).length, 1);

    const resolveu = await console_(`/status/incidents/${inc.id}/updates`, { method: 'POST', body: { status: 'resolved', message: 'Normalizado.' } });
    assert.equal(resolveu.status, 201);
    assert.equal(resolveu.body.data.incident.status, 'resolved');
    assert.ok(resolveu.body.data.incident.resolvedAt);
    assert.equal(resolveu.body.data.incident.updates.length, 3);
    const linha = (await auditoria('status.incident_resolved'))[0];
    assert.equal(JSON.parse(linha.detail).from, 'identified');
    assert.ok(linha.actor_user_id);

    const de_novo = await console_(`/status/incidents/${inc.id}/updates`, { method: 'POST', body: { status: 'monitoring', message: 'De novo?' } });
    assert.equal(de_novo.status, 409);
    assert.equal(de_novo.body.code, 'already_resolved');

    const lista = await console_('/status');
    assert.equal(lista.status, 200);
    assert.equal(lista.body.data.incidents[0].id, inc.id);
    assert.ok(lista.body.data.components.find((c) => c.code === 'panel'));
  });

  it('recusa o que não fecha, e o id que não existe é 404', async () => {
    const recusa = async (body, code) => {
      const r = await console_('/status/incidents', { method: 'POST', body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, code);
    };
    const base = { title: 'Algo', message: 'm', components: ['panel'] };
    await recusa({ ...base, title: 'x' }, 'invalid_title');
    await recusa({ ...base, message: ' ' }, 'invalid_message');
    await recusa({ ...base, components: [] }, 'invalid_components');
    await recusa({ ...base, components: ['panel', 'banco'] }, 'invalid_components');
    await recusa({ ...base, impact: 'enorme' }, 'invalid_impact');
    await recusa({ ...base, status: 'resolved' }, 'invalid_status');
    await recusa({ ...base, kind: 'maintenance' }, 'invalid_window');
    await recusa({
      ...base, kind: 'maintenance', startsAt: new Date(Date.now() + 2 * DIA).toISOString(), endsAt: new Date(Date.now() + DIA).toISOString()
    }, 'invalid_window');
    await recusa({ ...base, notifyProviders: 'sim' }, 'invalid_notify');
    assert.equal((await getDb()('status_incidents')).length, 0);
    assert.equal((await auditoria('status.incident_created')).length, 0);

    assert.equal((await console_('/status/incidents/9999', { method: 'PATCH', body: { impact: 'minor' } })).status, 404);
    assert.equal((await console_('/status/incidents/9999/updates', { method: 'POST', body: { message: 'x' } })).status, 404);
    assert.equal((await console_('/status/incidents/abc/updates', { method: 'POST', body: { message: 'x' } })).status, 404);
  });

  // Quem não é da plataforma ouve 404, como em todo o console (`requirePlatformAdmin`).
  it('só quem é da plataforma', async () => {
    assert.equal((await console_('/status', {}, estranhoToken)).status, 404);
    assert.equal((await console_('/status/incidents', { method: 'POST', body: {} }, estranhoToken)).status, 404);
    assert.equal((await console_('/status/incidents/1', { method: 'PATCH', body: {} }, estranhoToken)).status, 404);
    assert.equal((await console_('/status/incidents/1/updates', { method: 'POST', body: {} }, estranhoToken)).status, 404);
    assert.equal((await getDb()('status_incidents')).length, 0);
    assert.equal((await console_('/status', {}, null)).status, 401);
  });
});

describe('o aviso aos provedores', () => {
  const abrir = async (body = {}) => {
    const r = await console_('/status/incidents', {
      method: 'POST',
      body: { title: 'Pagamentos fora', message: 'Investigando o gateway.', components: ['payments'], impact: 'major', notifyProviders: true, ...body }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.incident;
  };

  it('sai uma vez por evento, só para provedor ativo, e o fim só para quem ouviu o começo', async () => {
    const inc = await abrir();
    const now = aoSegundo(Date.now() + 1000);
    const r1 = await StatusNotifyService.processDue({ now });
    assert.equal(r1.sent, 2);
    // Alfa: e-mail e WhatsApp; zeta: só e-mail. Nem o suspenso nem a caixa da plataforma.
    assert.deepEqual(enviados.map((e) => `${e.canal}:${e.to}`).sort(), [
      'email:alfa@exemplo.test', 'email:zeta@exemplo.test', 'whatsapp:93991935695'
    ]);
    assert.match(enviados[0].subject, /Pagamentos fora/);
    assert.match(enviados[0].text, /Pagamentos/);
    assert.match(enviados[0].text, /Investigando o gateway\./);
    assert.match(enviados[0].text, /https:\/\/painel\.exemplo\.test\/status/);

    // A segunda passada não manda de novo.
    enviados = [];
    const r2 = await StatusNotifyService.processDue({ now: aoSegundo(now.getTime() + MIN) });
    assert.equal(r2.sent, 0);
    assert.equal(enviados.length, 0);

    // Resolve: o fim, uma vez, para os dois que ouviram o começo.
    await console_(`/status/incidents/${inc.id}/updates`, { method: 'POST', body: { status: 'resolved', message: 'Tudo certo.' } });
    const r3 = await StatusNotifyService.processDue({ now: aoSegundo(now.getTime() + 2 * MIN) });
    assert.equal(r3.sent, 2);
    assert.ok(enviados.every((e) => /Resolvido|Tudo certo/.test(e.subject ?? e.text)));
    enviados = [];
    const r4 = await StatusNotifyService.processDue({ now: aoSegundo(now.getTime() + 3 * MIN) });
    assert.equal(r4.sent, 0);
    assert.equal(enviados.length, 0);

    const marcas = await getDb()('status_notification_marks').where({ incident_id: inc.id }).orderBy('id');
    assert.equal(marcas.length, 4);
    assert.ok(marcas.every((m) => m.status === 'done'));
  });

  it('sem o aviso ligado, nada sai; resolvido antes da passada, nada sai', async () => {
    await abrir({ notifyProviders: false });
    const rapido = await abrir();
    await console_(`/status/incidents/${rapido.id}/updates`, { method: 'POST', body: { status: 'resolved', message: 'Foi um soluço.' } });
    const r = await StatusNotifyService.processDue({ now: aoSegundo(Date.now() + 1000) });
    assert.equal(r.sent, 0);
    assert.equal(enviados.length, 0);
  });

  it('a falha volta depois da espera, sem repetir quem já recebeu', async () => {
    StatusNotifyService.senders.email = async (to, msg) => {
      if (to === 'zeta@exemplo.test') return false;
      enviados.push({ canal: 'email', to, ...msg });
      return true;
    };
    await abrir();
    const now = aoSegundo(Date.now() + 1000);
    const r1 = await StatusNotifyService.processDue({ now });
    assert.equal(r1.sent, 1);
    assert.equal(r1.failed, 1);
    // Logo em seguida, a marca falhada ainda espera.
    const r2 = await StatusNotifyService.processDue({ now: aoSegundo(now.getTime() + MIN) });
    assert.equal(r2.sent + r2.failed, 0);
    // Depois da espera, só zeta é tentado — e agora sai.
    StatusNotifyService.senders.email = async (to, msg) => { enviados.push({ canal: 'email', to, ...msg }); return true; };
    enviados = [];
    const r3 = await StatusNotifyService.processDue({ now: aoSegundo(now.getTime() + 16 * MIN) });
    assert.equal(r3.sent, 1);
    assert.deepEqual(enviados.map((e) => e.to), ['zeta@exemplo.test']);
  });

  it('a manutenção avisa uma vez, nas 24 horas antes, e encerra sozinha no fim', async () => {
    const base = agora().getTime();
    const inicio = aoSegundo(base + 3 * DIA);
    const fim = aoSegundo(base + 3 * DIA + 2 * 60 * MIN);
    const m = await abrir({
      kind: 'maintenance', title: 'Troca do banco', message: 'Janela de manutenção.', impact: 'none',
      components: ['panel'], startsAt: inicio.toISOString(), endsAt: fim.toISOString()
    });
    assert.equal(m.status, 'scheduled');
    assert.equal(startEventFor({ kind: 'maintenance', status: 'scheduled', starts_at: inicio, ends_at: fim }, new Date(base)), null);

    // Três dias antes: nada.
    assert.equal((await StatusNotifyService.processDue({ now: new Date(base) })).sent, 0);
    // 23 horas antes: o aviso, uma vez.
    const vespera = aoSegundo(inicio.getTime() - MAINTENANCE_NOTICE_MS + 60 * MIN);
    assert.equal((await StatusNotifyService.processDue({ now: vespera })).sent, 2);
    assert.match(enviados[0].subject, /Manutenção programada: Troca do banco/);
    enviados = [];
    assert.equal((await StatusNotifyService.processDue({ now: aoSegundo(vespera.getTime() + 30 * MIN) })).sent, 0);
    assert.equal((await StatusNotifyService.processDue({ now: aoSegundo(inicio.getTime() + MIN) })).sent, 0);
    assert.equal(enviados.length, 0);

    // A página pública a mostra como agendada, e não como em andamento.
    StatusService.invalidate();
    const publico = await StatusService.publicView({ now: new Date(base), fresh: true });
    assert.equal(publico.scheduledMaintenance.length, 1);
    assert.equal(publico.activeIncidents.length, 0);
    const durante = await StatusService.publicView({ now: aoSegundo(inicio.getTime() + MIN), fresh: true });
    assert.equal(durante.activeIncidents.length, 1);
    assert.equal(durante.components.find((c) => c.code === 'panel').status, 'maintenance');

    // Passou do fim sem ninguém encerrar: o sistema encerra, na trilha, e o fim sai uma vez.
    const depois = aoSegundo(fim.getTime() + MIN);
    assert.equal(await StatusService.completeEndedMaintenance({ now: depois }), 1);
    assert.equal(await StatusService.completeEndedMaintenance({ now: depois }), 0);
    const linha = await getDb()('status_incidents').where({ id: m.id }).first();
    assert.equal(linha.status, 'resolved');
    const trilha = (await auditoria('status.incident_resolved'))[0];
    assert.equal(JSON.parse(trilha.detail).automatic, true);
    assert.equal((await StatusNotifyService.processDue({ now: depois })).sent, 2);
    assert.match(enviados[0].subject, /Manutenção concluída/);
    enviados = [];
    assert.equal((await StatusNotifyService.processDue({ now: aoSegundo(depois.getTime() + MIN) })).sent, 0);
  });
});
