import { getDb, insertReturningId, isUniqueViolation, tdb } from '../config/database.js';
import { runInTenant, runUnscoped } from '../config/tenantContext.js';
import { IS_SAAS } from '../config/edition.js';
import Tenant from '../models/Tenant.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { log } from '../utils/logger.js';
import { acquireLease } from './schedulerLease.js';

/**
 * A página de status da plataforma (0128).
 *
 * Três partes, e cada uma tem uma regra que não se dobra:
 *
 *   1. **As verificações** (`runChecks`), a cada minuto, no passo da
 *      plataforma do agendador: o banco do painel, a conta Asaas da
 *      plataforma, o WhatsApp da plataforma (a conta "general" da caixa da
 *      plataforma, perguntada ao Evolution) e o GenieACS como AGREGADO — que
 *      fração dos agentes vistos na última semana está viva agora. Cada uma
 *      com prazo próprio, e nenhuma lança: uma dependência fora do ar é o que
 *      a página existe para mostrar, não motivo para o agendador parar.
 *      Componente sem configuração (sem chave do Asaas, sem conta de WhatsApp,
 *      sem agente nenhum) não é verificado nem aparece.
 *   2. **Os incidentes e as manutenções**, escritos à mão no console, com a
 *      linha do tempo pública (`status_incident_updates`).
 *   3. **A leitura pública** (`publicView`), guardada por 30 s, que não diz
 *      nada de dentro: nem detalhe de erro, nem latência, nem versão, nem
 *      provedor. Só o estado de cada componente, a barra de 90 dias e os
 *      incidentes como foram escritos para o público.
 *
 * O aviso aos provedores mora em `statusNotifyService.js`.
 */

export const STATUS_COMPONENTS = Object.freeze(['panel', 'payments', 'whatsapp', 'genieacs']);
export const INCIDENT_KINDS = Object.freeze(['incident', 'maintenance']);
export const INCIDENT_IMPACTS = Object.freeze(['none', 'minor', 'major', 'critical']);
/** As situações de cada tipo. `resolved` fecha os dois. */
export const INCIDENT_STATUSES = Object.freeze({
  incident: Object.freeze(['investigating', 'identified', 'monitoring', 'resolved']),
  maintenance: Object.freeze(['scheduled', 'in_progress', 'resolved'])
});
/** Do melhor para o pior: o estado de um conjunto é o pior dos que o compõem. */
export const COMPONENT_STATES = Object.freeze(['operational', 'maintenance', 'degraded', 'partial_outage', 'major_outage']);

export const HISTORY_DAYS = 90;
const DIA = 86_400_000;
/** O prazo de cada verificação: folga sobre o do Asaas e do Evolution, e menos que o minuto da passada. */
export const CHECK_TIMEOUT_MS = 10_000;
/** A cadência das verificações. Um pouco menos que o minuto do agendador, para não pular volta. */
const CHECK_INTERVAL_MS = 55_000;
/** Sem verificação há mais que isto, o componente está `unknown` (o agendador parou). */
const STALE_MS = 10 * 60_000;
/** Falhas seguidas a partir das quais a falha vira queda (`major_outage`) e não instabilidade. */
const OUTAGE_STREAK = 3;
/** O agente do GenieACS é "vivo" se foi visto há menos que isto (o pong grava a cada minuto). */
export const AGENT_ONLINE_MS = 5 * 60_000;
/** E entra na conta se foi visto na última semana — o que sumiu há meses é do provedor, não nosso. */
export const AGENT_POPULATION_MS = 7 * DIA;
/** Abaixo desta fração de agentes vivos, o GenieACS da plataforma está com problema. */
export const GENIEACS_OK_RATIO = 0.5;
/** A leitura pública é guardada por este tempo. */
export const PUBLIC_CACHE_MS = 30_000;
/** Quantos dias de incidentes resolvidos a página pública mostra. */
const PUBLIC_HISTORY_DAYS = 30;
const PUBLIC_HISTORY_LIMIT = 20;
const DETAIL_MAX = 120;

export const TITLE_MIN = 3;
export const TITLE_MAX = 160;
export const MESSAGE_MAX = 2000;

const aoSegundo = (d) => new Date(Math.floor(d.getTime() / 1000) * 1000);

/** Um instante do banco (Date, número em ms ou texto) em milissegundos, ou nulo. */
export function instanteMs(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.getTime();
  if (typeof valor === 'number') return valor;
  const texto = String(valor);
  const ms = /^\d+$/.test(texto) ? Number(texto) : Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(texto) ? texto : `${texto.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function isoOuNulo(valor) {
  const ms = instanteMs(valor);
  return ms === null ? null : new Date(ms).toISOString();
}

/** O dia UTC (`YYYY-MM-DD`) de um instante. */
export function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Os `dias` dias UTC que terminam no de `now`, do mais antigo para o de hoje. */
export function lastDays(now, dias = HISTORY_DAYS) {
  const hoje = Date.parse(`${dayKey(now)}T00:00:00Z`);
  const lista = [];
  for (let i = dias - 1; i >= 0; i -= 1) lista.push(dayKey(hoje - i * DIA));
  return lista;
}

/** Porcentagem com duas casas, ou nulo sem verificação nenhuma. */
export function percent(ok, total) {
  const t = Number(total) || 0;
  if (t <= 0) return null;
  return Math.round((Number(ok) / t) * 10000) / 100;
}

/**
 * A barra de 90 dias de UM componente, a partir das somas do dia
 * (`status_daily`): um item por dia, com a porcentagem (nula no dia sem
 * verificação), e a disponibilidade do período inteiro — a soma das
 * verificações que deram certo sobre a soma de todas, e não a média das
 * porcentagens, que daria o mesmo peso a um dia de 3 verificações e a um de
 * 1440.
 */
export function uptimeSeries(rows, { now = new Date(), days = HISTORY_DAYS } = {}) {
  const porDia = new Map();
  for (const r of rows) porDia.set(String(r.day), { total: Number(r.total) || 0, ok: Number(r.ok_count) || 0 });
  let total = 0;
  let ok = 0;
  const serie = lastDays(now, days).map((date) => {
    const d = porDia.get(date);
    if (d) {
      total += d.total;
      ok += d.ok;
    }
    return { date, uptime: d ? percent(d.ok, d.total) : null };
  });
  return { days: serie, uptime: percent(ok, total) };
}

/**
 * O estado de um componente pelas verificações mais recentes (da mais nova
 * para a mais velha): a última deu certo, `operational`; falhou, `degraded` —
 * e `major_outage` com `OUTAGE_STREAK` falhas seguidas, para uma resposta
 * lenta isolada não pintar a página de vermelho. Sem verificação recente,
 * `unknown`.
 */
export function stateFromChecks(recentes, { now = new Date() } = {}) {
  if (!recentes.length) return 'unknown';
  const ultima = recentes[0];
  const ms = instanteMs(ultima.checked_at);
  if (ms === null || now.getTime() - ms > STALE_MS) return 'unknown';
  if (ultima.ok === true || ultima.ok === 1 || ultima.ok === '1') return 'operational';
  const seguidas = recentes.slice(0, OUTAGE_STREAK).filter((c) => !(c.ok === true || c.ok === 1 || c.ok === '1')).length;
  return seguidas >= OUTAGE_STREAK ? 'major_outage' : 'degraded';
}

/** O pior de dois estados (`unknown` perde para qualquer um conhecido). */
export function worstState(a, b) {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return COMPONENT_STATES.indexOf(a) >= COMPONENT_STATES.indexOf(b) ? a : b;
}

/** O que o impacto de um incidente aberto faz com o componente. */
export function stateFromImpact(impact) {
  if (impact === 'critical') return 'major_outage';
  if (impact === 'major') return 'partial_outage';
  if (impact === 'minor') return 'degraded';
  return 'operational';
}

/** Se o incidente pesa agora sobre os componentes dele, e como. */
export function incidentEffect(incident, now = new Date()) {
  if (incident.status === 'resolved') return null;
  const inicio = instanteMs(incident.starts_at);
  if (incident.kind === 'maintenance') {
    if (inicio === null || inicio > now.getTime()) return null;
    return 'maintenance';
  }
  if (inicio !== null && inicio > now.getTime()) return null;
  return stateFromImpact(incident.impact);
}

/**
 * O veredito do GenieACS a partir de quando cada agente foi visto: dos vistos
 * na última semana (a população), quantos estão vivos agora. Sem população,
 * nulo — o componente não aparece.
 */
export function genieacsVerdict(lastSeenList, now = new Date()) {
  const agora = now.getTime();
  const populacao = lastSeenList
    .map(instanteMs)
    .filter((ms) => ms !== null && agora - ms <= AGENT_POPULATION_MS);
  if (!populacao.length) return null;
  const vivos = populacao.filter((ms) => agora - ms <= AGENT_ONLINE_MS).length;
  return { ok: vivos / populacao.length >= GENIEACS_OK_RATIO, detail: `${vivos}/${populacao.length} online` };
}

/** Os códigos de componente de uma lista (ou do texto da coluna), válidos e sem repetir. */
export function parseComponents(valor) {
  const lista = Array.isArray(valor) ? valor : String(valor ?? '').split(',');
  const vistos = [];
  for (const item of lista) {
    const codigo = String(item ?? '').trim();
    if (STATUS_COMPONENTS.includes(codigo) && !vistos.includes(codigo)) vistos.push(codigo);
  }
  return vistos;
}

/** O detalhe de uma falha, curto e sem mensagem de fora: o código e o status HTTP, se houver. */
function detalheDoErro(error) {
  if (error?.code === 'status_timeout') return 'timeout';
  const codigo = String(error?.code || error?.name || 'error').replace(/[^\w.:-]/g, '').slice(0, 60);
  const status = Number(error?.status ?? error?.statusCode);
  return Number.isInteger(status) && status > 0 ? `${codigo}:${status}` : codigo;
}

function comPrazo(promessa, ms) {
  let timer;
  const prazo = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const erro = new Error('status check timed out');
      erro.code = 'status_timeout';
      reject(erro);
    }, ms);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(timer));
}

export class StatusError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function presentUpdate(u, { internal = false } = {}) {
  return {
    ...(internal ? { id: u.id, createdBy: u.created_by ?? null } : {}),
    status: u.status,
    message: String(u.message ?? ''),
    createdAt: isoOuNulo(u.created_at)
  };
}

/** O incidente como a página pública o lê: nada de quem escreveu nem do aviso. */
export function presentIncident(row, updates = [], { internal = false } = {}) {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    impact: row.impact,
    status: row.status,
    components: parseComponents(row.components),
    startsAt: isoOuNulo(row.starts_at),
    endsAt: isoOuNulo(row.ends_at),
    resolvedAt: isoOuNulo(row.resolved_at),
    createdAt: isoOuNulo(row.created_at),
    ...(internal ? {
      notifyProviders: row.notify_providers === true || row.notify_providers === 1 || row.notify_providers === '1',
      createdBy: row.created_by ?? null,
      updatedAt: isoOuNulo(row.updated_at)
    } : {}),
    updates: updates.map((u) => presentUpdate(u, { internal }))
  };
}

let cachePublico = null;

class StatusService {
  static lastRunAt = 0;
  static lastPruneAt = 0;

  /**
   * As verificações, trocáveis nos testes. Cada uma devolve `{ ok, detail? }`
   * ou nulo quando o componente não está configurado; lançar é falhar.
   */
  static probes = {
    panel: async () => {
      await getDb().raw('SELECT 1');
      return { ok: true };
    },
    payments: async () => {
      // Importado na hora: o cliente do gateway puxa a cifra dos segredos.
      const { apiKey, testConnection } = await import('./billing/asaasClient.js');
      if (!(await apiKey())) return null;
      await testConnection();
      return { ok: true };
    },
    whatsapp: async () => {
      const platform = await Tenant.platform();
      if (!platform) return null;
      return runInTenant(platform.id, async () => {
        if (!(await tdb('whatsapp_accounts').first('id'))) return null;
        const account = await WhatsAppAccount.getForPurpose('general');
        if (!account) return { ok: false, detail: 'disconnected' };
        const [{ default: WhatsAppConfigService }, { clientForAccount }, { readStatus, statusRequest }] = await Promise.all([
          import('./whatsappConfigService.js'),
          import('./evolutionClient.js'),
          import('../utils/wa/evolutionApi.js')
        ]);
        const config = await WhatsAppConfigService.getConfig();
        const client = clientForAccount(account, config, WhatsAppConfigService.decryptInstanceToken(account));
        const result = await client.sendOrThrow(statusRequest(account.flavor, account.name));
        // O número oficial (Meta) não tem pareamento: o servidor ter
        // respondido pela instância é a resposta.
        if (WhatsAppAccount.isCloud(account)) return { ok: true };
        const state = readStatus(account.flavor, result.data);
        return state === 'connected' ? { ok: true } : { ok: false, detail: state || 'unknown_state' };
      });
    },
    genieacs: async () => {
      // tenant-scope-exempt: o agregado de TODOS os agentes, sem nome de provedor — só os instantes.
      const linhas = await runUnscoped('the status page counts every provider\'s GenieACS agent', () => getDb()('tenant_genieacs_connections as c')
        .join('tenants as t', 't.id', 'c.tenant_id')
        .where('c.mode', 'agent')
        .where('t.status', 'active')
        .whereNotNull('c.agent_last_seen_at')
        .where('c.agent_last_seen_at', '>=', new Date(Date.now() - AGENT_POPULATION_MS))
        .select('c.agent_last_seen_at'));
      return genieacsVerdict(linhas.map((l) => l.agent_last_seen_at));
    }
  };

  /** Uma verificação, com prazo e sem lançar: `{ ok, latencyMs, detail }` ou nulo. */
  static async probe(component, { timeoutMs = CHECK_TIMEOUT_MS } = {}) {
    const inicio = Date.now();
    try {
      const resultado = await comPrazo(Promise.resolve().then(() => this.probes[component]()), timeoutMs);
      if (!resultado) return null;
      return {
        ok: Boolean(resultado.ok),
        latencyMs: Date.now() - inicio,
        detail: resultado.detail ? String(resultado.detail).slice(0, DETAIL_MAX) : null
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - inicio, detail: detalheDoErro(error) };
    }
  }

  /** Grava uma verificação e soma no dia dela. */
  static async record(component, resultado, now = new Date()) {
    const db = getDb();
    const quando = aoSegundo(now);
    await db('status_checks').insert({
      component,
      ok: resultado.ok,
      latency_ms: Number.isFinite(resultado.latencyMs) ? Math.round(resultado.latencyMs) : null,
      detail: resultado.detail,
      checked_at: quando
    });
    const day = dayKey(quando);
    const inc = { total: db.raw('total + 1'), ok_count: db.raw('ok_count + ?', [resultado.ok ? 1 : 0]) };
    const mudou = await db('status_daily').where({ component, day }).update(inc);
    if (Number(mudou) > 0) return;
    try {
      await db('status_daily').insert({ component, day, total: 1, ok_count: resultado.ok ? 1 : 0 });
    } catch (error) {
      // Duas passadas no mesmo dia novo: quem perdeu a inserção soma.
      if (!isUniqueViolation(error)) throw error;
      await db('status_daily').where({ component, day }).update(inc);
    }
  }

  /**
   * Roda as verificações e grava. Nunca lança: devolve o que cada uma deu
   * (nulo para a não configurada), ou `{ error }` quando nem gravar deu.
   */
  static async runChecks({ now = new Date(), timeoutMs = CHECK_TIMEOUT_MS } = {}) {
    const resultados = {};
    try {
      const lista = await Promise.all(STATUS_COMPONENTS.map(async (c) => [c, await this.probe(c, { timeoutMs })]));
      for (const [component, resultado] of lista) {
        resultados[component] = resultado;
        if (!resultado) continue;
        try {
          // eslint-disable-next-line no-await-in-loop -- quatro no máximo
          await this.record(component, resultado, now);
        } catch (error) {
          log.warn('status check record failed', { component, err: error });
        }
      }
      cachePublico = null;
    } catch (error) {
      log.warn('status checks failed', { err: error });
      return { ...resultados, error: error.message };
    }
    return resultados;
  }

  /** As verificações mais recentes de um componente, da mais nova para a mais velha. */
  static async recentChecks(component, limit = OUTAGE_STREAK) {
    return getDb()('status_checks')
      .where({ component })
      .orderBy('checked_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit);
  }

  /** A poda: verificações com mais de 90 dias, e as somas do dia com mais de 120. */
  static async prune({ now = new Date() } = {}) {
    const db = getDb();
    const corte = new Date(now.getTime() - HISTORY_DAYS * DIA);
    let apagadas = 0;
    for (const component of STATUS_COMPONENTS) {
      // eslint-disable-next-line no-await-in-loop -- uma por componente, pelo índice
      apagadas += Number(await db('status_checks').where({ component }).where('checked_at', '<', corte).del()) || 0;
    }
    await db('status_daily').where('day', '<', dayKey(now.getTime() - (HISTORY_DAYS + 30) * DIA)).del();
    return apagadas;
  }

  /**
   * O passo do agendador (fora do laço por provedor): as verificações uma vez
   * por minuto, a manutenção vencida encerrada, os avisos e, uma vez por dia,
   * a poda. Nunca lança.
   */
  static async schedulerPass({ now = new Date(), force = false } = {}) {
    const resumo = {};
    // A página só existe na SaaS (`/api/public` nem é montada na instalação
    // própria): lá não há o que verificar para ninguém ler.
    if (!IS_SAAS) return { skipped: 'selfhosted' };
    try {
      if (force || now.getTime() - this.lastRunAt >= CHECK_INTERVAL_MS) {
        this.lastRunAt = now.getTime();
        // Com mais de uma instância, só uma verifica por intervalo (a vez em
        // `app_state`, ver `schedulerLease.js`); a outra pula — a página lê o
        // mesmo banco. A vez vence um segundo antes do próximo tique.
        const minha = force || await acquireLease('status-checks', { ttlMs: CHECK_INTERVAL_MS - 1000, now });
        if (minha) resumo.checks = await this.runChecks({ now });
        else resumo.checks = 'other_instance';
      }
      resumo.maintenance = await this.completeEndedMaintenance({ now }).catch((error) => {
        log.warn('status maintenance completion failed', { err: error });
        return 0;
      });
      const { default: StatusNotifyService } = await import('./statusNotifyService.js');
      resumo.notify = await StatusNotifyService.processDue({ now });
      if (now.getTime() - this.lastPruneAt >= DIA
        && await acquireLease('status-prune', { ttlMs: DIA - 60_000, now })) {
        this.lastPruneAt = now.getTime();
        resumo.pruned = await this.prune({ now }).catch((error) => {
          log.warn('status prune failed', { err: error });
          return 0;
        });
      }
    } catch (error) {
      log.warn('status pass failed', { err: error });
      resumo.error = error.message;
    }
    return resumo;
  }

  // ── A leitura ────────────────────────────────────────────────────────

  static async dailyRows(now = new Date()) {
    return getDb()('status_daily')
      .where('day', '>=', lastDays(now)[0])
      .select('component', 'day', 'total', 'ok_count');
  }

  /** Os incidentes que pesam agora ou que estão por vir, e os resolvidos há pouco. */
  static async liveIncidents(now = new Date(), { historyDays = PUBLIC_HISTORY_DAYS, historyLimit = PUBLIC_HISTORY_LIMIT } = {}) {
    const db = getDb();
    const abertos = await db('status_incidents').whereNot({ status: 'resolved' }).orderBy('id', 'desc').limit(100);
    const resolvidos = await db('status_incidents')
      .where({ status: 'resolved' })
      .where('resolved_at', '>=', new Date(now.getTime() - historyDays * DIA))
      .orderBy('resolved_at', 'desc')
      .limit(historyLimit);
    return { abertos, resolvidos };
  }

  static async updatesOf(ids) {
    if (!ids.length) return new Map();
    const linhas = await getDb()('status_incident_updates')
      .whereIn('incident_id', ids)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc');
    const mapa = new Map();
    for (const u of linhas) {
      const id = Number(u.incident_id);
      if (!mapa.has(id)) mapa.set(id, []);
      mapa.get(id).push(u);
    }
    return mapa;
  }

  /**
   * O estado de cada componente agora e a barra de 90 dias. Aparece o painel
   * sempre, e os outros quando foram verificados no período ou estão citados
   * num incidente aberto.
   */
  static async componentsView(now, abertos, { internal = false } = {}) {
    const diarias = await this.dailyRows(now);
    const componentes = [];
    for (const code of STATUS_COMPONENTS) {
      // eslint-disable-next-line no-await-in-loop -- quatro consultas pequenas, pelo índice
      const recentes = await this.recentChecks(code, internal ? 10 : OUTAGE_STREAK);
      const linhas = diarias.filter((r) => r.component === code);
      const citado = abertos.some((i) => parseComponents(i.components).includes(code));
      if (code !== 'panel' && !linhas.length && !recentes.length && !citado) continue;
      let estado = stateFromChecks(recentes, { now });
      for (const incidente of abertos) {
        if (!parseComponents(incidente.components).includes(code)) continue;
        const efeito = incidentEffect(incidente, now);
        if (efeito) estado = worstState(estado, efeito);
      }
      const serie = uptimeSeries(linhas, { now });
      componentes.push({
        code,
        status: estado,
        uptime: serie.uptime,
        days: serie.days,
        ...(internal ? {
          checks: recentes.map((c) => ({
            ok: c.ok === true || c.ok === 1 || c.ok === '1',
            latencyMs: c.latency_ms === null || c.latency_ms === undefined ? null : Number(c.latency_ms),
            detail: c.detail ?? null,
            checkedAt: isoOuNulo(c.checked_at)
          }))
        } : {})
      });
    }
    return componentes;
  }

  /** O pior estado entre os componentes; `unknown` só quando nenhum é conhecido. */
  static overall(componentes) {
    return componentes.reduce((pior, c) => worstState(pior, c.status), 'unknown');
  }

  /** A leitura que a página pública recebe — ver o cabeçalho. Guardada por 30 s. */
  static async publicView({ now = new Date(), fresh = false } = {}) {
    if (!fresh && cachePublico && now.getTime() - cachePublico.at < PUBLIC_CACHE_MS) return cachePublico.value;
    const { abertos, resolvidos } = await this.liveIncidents(now);
    const componentes = await this.componentsView(now, abertos);
    const updates = await this.updatesOf([...abertos, ...resolvidos].map((i) => Number(i.id)));
    const ver = (i) => presentIncident(i, (updates.get(Number(i.id)) ?? []).slice(0, 20));
    const agora = now.getTime();
    const futuras = abertos.filter((i) => i.kind === 'maintenance' && (instanteMs(i.starts_at) ?? 0) > agora);
    const ativos = abertos.filter((i) => !futuras.includes(i));
    const value = {
      status: this.overall(componentes),
      updatedAt: now.toISOString(),
      components: componentes,
      activeIncidents: ativos.map(ver),
      scheduledMaintenance: futuras
        .sort((a, b) => (instanteMs(a.starts_at) ?? 0) - (instanteMs(b.starts_at) ?? 0))
        .map(ver),
      history: resolvidos.map(ver)
    };
    cachePublico = { at: now.getTime(), value };
    return value;
  }

  /** O que o console lê: o mesmo, com as últimas verificações, o detalhe e os incidentes recentes. */
  static async consoleView({ now = new Date() } = {}) {
    const db = getDb();
    const { abertos } = await this.liveIncidents(now);
    const componentes = await this.componentsView(now, abertos, { internal: true });
    const recentes = await db('status_incidents').orderBy('id', 'desc').limit(50);
    const updates = await this.updatesOf(recentes.map((i) => Number(i.id)));
    const ids = recentes.map((i) => Number(i.id));
    const marcas = ids.length
      ? await db('status_notification_marks')
        .whereIn('incident_id', ids)
        .where({ status: 'done' })
        .whereNotIn('detail', ['no_recipient'])
        .groupBy('incident_id', 'event')
        .select('incident_id', 'event')
        .count({ n: '*' })
      : [];
    const avisos = new Map();
    for (const m of marcas) {
      const id = Number(m.incident_id);
      if (!avisos.has(id)) avisos.set(id, {});
      avisos.get(id)[m.event] = Number(m.n);
    }
    return {
      status: this.overall(componentes),
      updatedAt: now.toISOString(),
      components: componentes,
      incidents: recentes.map((i) => ({
        ...presentIncident(i, updates.get(Number(i.id)) ?? [], { internal: true }),
        notified: avisos.get(Number(i.id)) ?? {}
      }))
    };
  }

  static invalidate() {
    cachePublico = null;
  }

  // ── Os incidentes ────────────────────────────────────────────────────

  static async findIncident(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    return (await getDb()('status_incidents').where({ id: n }).first()) || null;
  }

  /** O título, a mensagem e os componentes, validados; lança `StatusError`. */
  static validarTexto(campo, valor, { min, max }) {
    const texto = String(valor ?? '').trim();
    if (texto.length < min || texto.length > max) throw new StatusError(`invalid_${campo}`);
    return texto;
  }

  static validarData(campo, valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const ms = typeof valor === 'string' ? Date.parse(valor) : NaN;
    if (Number.isNaN(ms)) throw new StatusError(`invalid_${campo}`);
    return aoSegundo(new Date(ms));
  }

  /**
   * Abre um incidente ou agenda uma manutenção, com a primeira mensagem da
   * linha do tempo. A manutenção pede início e fim; o incidente começa agora
   * (ou quando `startsAt` disser, para registrar um que já passou).
   */
  static async createIncident(body = {}, { userId = null, now = new Date() } = {}) {
    const kind = body.kind === undefined ? 'incident' : body.kind;
    if (!INCIDENT_KINDS.includes(kind)) throw new StatusError('invalid_kind');
    const title = this.validarTexto('title', body.title, { min: TITLE_MIN, max: TITLE_MAX });
    const message = this.validarTexto('message', body.message, { min: 1, max: MESSAGE_MAX });
    const components = parseComponents(body.components);
    if (!components.length || (Array.isArray(body.components) && components.length !== body.components.length)) {
      throw new StatusError('invalid_components');
    }
    const impact = body.impact === undefined ? (kind === 'maintenance' ? 'none' : 'minor') : body.impact;
    if (!INCIDENT_IMPACTS.includes(impact)) throw new StatusError('invalid_impact');
    const status = body.status === undefined ? INCIDENT_STATUSES[kind][0] : body.status;
    if (!INCIDENT_STATUSES[kind].includes(status) || status === 'resolved') throw new StatusError('invalid_status');
    if (body.notifyProviders !== undefined && typeof body.notifyProviders !== 'boolean') throw new StatusError('invalid_notify');
    let startsAt = this.validarData('startsAt', body.startsAt);
    let endsAt = this.validarData('endsAt', body.endsAt);
    if (kind === 'maintenance') {
      if (!startsAt || !endsAt) throw new StatusError('invalid_window');
      if (endsAt.getTime() <= startsAt.getTime()) throw new StatusError('invalid_window');
      if (endsAt.getTime() <= now.getTime()) throw new StatusError('invalid_window');
    } else {
      startsAt = startsAt ?? aoSegundo(now);
      if (startsAt.getTime() > now.getTime() + 60_000) throw new StatusError('invalid_startsAt');
      endsAt = null;
    }
    const quando = aoSegundo(now);
    const db = getDb();
    const id = await db.transaction(async (trx) => {
      const novo = await insertReturningId('status_incidents', {
        title,
        components: components.join(','),
        impact,
        status,
        kind,
        starts_at: startsAt,
        ends_at: endsAt,
        resolved_at: null,
        notify_providers: body.notifyProviders === true,
        created_by: userId,
        created_at: quando,
        updated_at: quando
      }, trx);
      await trx('status_incident_updates').insert({
        incident_id: novo, status, message, created_by: userId, created_at: quando
      });
      return Number(novo);
    });
    cachePublico = null;
    return this.incidentView(id);
  }

  static async incidentView(id) {
    const row = await this.findIncident(id);
    if (!row) return null;
    const updates = await this.updatesOf([Number(row.id)]);
    return presentIncident(row, updates.get(Number(row.id)) ?? [], { internal: true });
  }

  /** Muda título, componentes, impacto, janela ou o aviso. Devolve `{ incident, changed }`. */
  static async updateIncident(id, body = {}, { now = new Date() } = {}) {
    const row = await this.findIncident(id);
    if (!row) throw new StatusError('not_found', 404);
    const patch = {};
    if (body.title !== undefined) patch.title = this.validarTexto('title', body.title, { min: TITLE_MIN, max: TITLE_MAX });
    if (body.components !== undefined) {
      const components = parseComponents(body.components);
      if (!components.length || !Array.isArray(body.components) || components.length !== body.components.length) {
        throw new StatusError('invalid_components');
      }
      patch.components = components.join(',');
    }
    if (body.impact !== undefined) {
      if (!INCIDENT_IMPACTS.includes(body.impact)) throw new StatusError('invalid_impact');
      patch.impact = body.impact;
    }
    if (body.notifyProviders !== undefined) {
      if (typeof body.notifyProviders !== 'boolean') throw new StatusError('invalid_notify');
      patch.notify_providers = body.notifyProviders;
    }
    if (body.startsAt !== undefined || body.endsAt !== undefined) {
      if (row.status === 'resolved') throw new StatusError('already_resolved', 409);
      const startsAt = body.startsAt !== undefined ? this.validarData('startsAt', body.startsAt) : (row.starts_at ? new Date(instanteMs(row.starts_at)) : null);
      const endsAt = body.endsAt !== undefined ? this.validarData('endsAt', body.endsAt) : (row.ends_at ? new Date(instanteMs(row.ends_at)) : null);
      if (row.kind === 'maintenance') {
        if (!startsAt || !endsAt || endsAt.getTime() <= startsAt.getTime()) throw new StatusError('invalid_window');
        patch.ends_at = endsAt;
      } else if (!startsAt || startsAt.getTime() > now.getTime() + 60_000) {
        throw new StatusError('invalid_startsAt');
      }
      patch.starts_at = startsAt;
    }
    const mudou = Object.keys(patch);
    if (!mudou.length) throw new StatusError('nothing_to_change');
    await getDb()('status_incidents').where({ id: row.id }).update({ ...patch, updated_at: aoSegundo(now) });
    cachePublico = null;
    return { incident: await this.incidentView(row.id), changed: mudou };
  }

  /**
   * Uma mensagem nova na linha do tempo, com a situação nova. `resolved`
   * encerra; um resolvido não volta (409) — abre-se outro.
   */
  static async postUpdate(id, body = {}, { userId = null, now = new Date() } = {}) {
    const row = await this.findIncident(id);
    if (!row) throw new StatusError('not_found', 404);
    if (row.status === 'resolved') throw new StatusError('already_resolved', 409);
    const status = body.status === undefined ? row.status : body.status;
    if (!INCIDENT_STATUSES[row.kind]?.includes(status)) throw new StatusError('invalid_status');
    const message = this.validarTexto('message', body.message, { min: 1, max: MESSAGE_MAX });
    const quando = aoSegundo(now);
    const fechou = await getDb().transaction(async (trx) => {
      // Condicional à situação lida: dois cliques ao mesmo tempo não resolvem duas vezes.
      const n = await trx('status_incidents')
        .where({ id: row.id })
        .whereNot({ status: 'resolved' })
        .update({ status, updated_at: quando, ...(status === 'resolved' ? { resolved_at: quando } : {}) });
      if (!Number(n)) throw new StatusError('already_resolved', 409);
      await trx('status_incident_updates').insert({
        incident_id: row.id, status, message, created_by: userId, created_at: quando
      });
      return status === 'resolved';
    });
    cachePublico = null;
    return { incident: await this.incidentView(row.id), resolved: fechou, previousStatus: row.status };
  }

  /**
   * A manutenção cujo fim passou e que ninguém encerrou: encerrada pelo
   * sistema, no fim agendado, com uma mensagem vazia (a página diz "concluída"
   * na língua de quem lê). Devolve quantas.
   */
  static async completeEndedMaintenance({ now = new Date() } = {}) {
    const db = getDb();
    const vencidas = await db('status_incidents')
      .where({ kind: 'maintenance' })
      .whereNot({ status: 'resolved' })
      .whereNotNull('ends_at')
      .where('ends_at', '<=', now)
      .limit(50);
    let n = 0;
    for (const m of vencidas) {
      const fim = aoSegundo(new Date(instanteMs(m.ends_at) ?? now.getTime()));
      // eslint-disable-next-line no-await-in-loop -- poucas, e cada uma condicional
      const fechou = await db.transaction(async (trx) => {
        const mudou = await trx('status_incidents')
          .where({ id: m.id })
          .whereNot({ status: 'resolved' })
          .update({ status: 'resolved', resolved_at: fim, updated_at: aoSegundo(now) });
        if (!Number(mudou)) return false;
        await trx('status_incident_updates').insert({
          incident_id: m.id, status: 'resolved', message: '', created_by: null, created_at: fim
        });
        return true;
      });
      if (fechou) {
        n += 1;
        // eslint-disable-next-line no-await-in-loop
        const { default: PlatformAudit } = await import('../models/PlatformAudit.js');
        // eslint-disable-next-line no-await-in-loop
        await PlatformAudit.record({
          action: PlatformAudit.ACTIONS.STATUS_INCIDENT_RESOLVED,
          detail: { incidentId: m.id, kind: 'maintenance', automatic: true }
        });
      }
    }
    if (n) cachePublico = null;
    return n;
  }
}

export default StatusService;
