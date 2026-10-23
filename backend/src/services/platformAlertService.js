import crypto from 'node:crypto';
import { getDb, isUniqueViolation } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import { log } from '../utils/logger.js';
import { ALERT_CHANNELS, ALERT_EVENTS, alertsConfig, readProfile } from './platformProfileService.js';

/**
 * Os alertas para quem opera a plataforma (0112): WhatsApp e e-mail nos
 * eventos que importam — um pagamento que entrou, um cartão recusado, um
 * pedido de cancelamento, uma NFS-e com erro.
 *
 * DUAS METADES, e a separação é o que deixa o resto do sistema em paz:
 *
 *   - `enqueue`, chamado pelos ganchos nos serviços que já existem, só GRAVA
 *     uma linha em `platform_alerts`. Nunca lança, nunca manda nada, e nunca
 *     é chamado de dentro da transação de um pagamento: o alerta é acessório,
 *     e um banco ocupado ou uma configuração quebrada aqui não pode custar o
 *     crédito de ninguém. `dedupe_key` única é a idempotência — a reentrega
 *     do webhook, a segunda passada do agendador e a corrida de dois
 *     processos dão no mesmo fato, que entra uma vez.
 *   - `processDue`, chamado pelo agendador FORA do laço por provedor, manda o
 *     que está pendente pelo `PlatformNotifyService` (o número da plataforma)
 *     e pelo e-mail do deploy, com novas tentativas e espera crescente (até
 *     `MAX_ATTEMPTS`). Com o resumo diário ligado, nada sai um a um: à hora
 *     escolhida (horário de Brasília), tudo o que está pendente vira UMA
 *     mensagem por canal.
 *
 * Os destinos são os de Configurações → Dados do SaaS (`notifyWhatsapp` e
 * `notifyEmail`), os mesmos dos avisos de cadastro.
 */

export const MAX_ATTEMPTS = 5;
/** A espera depois de cada falha: 1 min, 5 min, 15 min, 1 h. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** Quanto tempo uma passada segura a linha que está mandando. */
const CLAIM_MS = 5 * 60_000;
const BATCH = 50;
/**
 * Quanto uma passada pode durar. Cada canal já tem o próprio timeout, mas
 * um canal lento em 50 linhas seguraria o tique do agendador por minutos:
 * passado o prazo, o resto fica para a próxima passada.
 */
const PASS_BUDGET_MS = 20_000;
/** Quantos alertas o resumo lista; o resto vira "+N mais". */
const DIGEST_MAX_ITEMS = 50;
/** O teto do texto do resumo, com folga para o WhatsApp (4096) e o assunto. */
const DIGEST_MAX_CHARS = 3500;
/**
 * Quantos ids de alerta o resumo que desistiu grava no payload: são eles que
 * o "Reenviar" do resumo põe de volta na fila. Acima disso, o reenvio cai na
 * janela de datas (como nas linhas antigas, gravadas sem ids).
 */
const DIGEST_MAX_IDS = 500;
/** O fuso do resumo diário. */
const FUSO = 'America/Sao_Paulo';
const DIGEST_EVENT = 'digest';
const TEST_EVENT = 'test';
/**
 * O relatório mensal: fora de `ALERT_EVENTS`, como o resumo e o teste — a
 * configuração dele é `alerts.monthlyReport`, e ele nunca entra no resumo
 * diário (sai sozinho, pela passada, mesmo com o resumo ligado).
 */
export const MONTHLY_EVENT = 'monthly_report';
/** Até que dia do mês o relatório do mês anterior ainda sai, se o 1º passou sem ele. */
const MONTHLY_CATCHUP_DAYS = 3;
/** Os eventos que a passada um a um e o resumo diário não tocam. */
const FORA_DA_FILA = Object.freeze([DIGEST_EVENT, TEST_EVENT, MONTHLY_EVENT]);
/** As cobranças que contam no `big_overdue`: só as que estão no gateway, à espera. */
const BIG_OVERDUE_STATUSES = Object.freeze(['pending', 'overdue']);

/** Chave do payload que nunca vai para a fila, venha de onde vier. */
const CHAVE_SENSIVEL = /token|secret|senha|password|apikey|api_key|card|cvv|authorization|cookie|cipher/i;
const PAYLOAD_MAX_KEYS = 20;
const PAYLOAD_MAX_STRING = 200;

function aoSegundo(data) {
  return new Date(Math.floor(data.getTime() / 1000) * 1000);
}

function asDate(valor) {
  if (!valor) return null;
  const data = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

/**
 * O payload como ele pode ser gravado: só valores simples, sem chave que
 * pareça segredo, com texto curto. A fila é lida pelo console e vai para o
 * WhatsApp de alguém — o que entra aqui é o que a mensagem mostra, e nada
 * além disso.
 */
export function sanitizePayload(payload) {
  const limpo = {};
  if (!payload || typeof payload !== 'object') return limpo;
  for (const [chave, valor] of Object.entries(payload)) {
    if (Object.keys(limpo).length >= PAYLOAD_MAX_KEYS) break;
    if (CHAVE_SENSIVEL.test(chave)) continue;
    if (valor === null || typeof valor === 'boolean') limpo[chave] = valor;
    else if (typeof valor === 'number') {
      if (Number.isFinite(valor)) limpo[chave] = valor;
    } else if (typeof valor === 'string') limpo[chave] = valor.slice(0, PAYLOAD_MAX_STRING);
    else if (valor instanceof Date && !Number.isNaN(valor.getTime())) limpo[chave] = valor.toISOString();
  }
  return limpo;
}

/** `evento:resto`, com um hash no lugar quando passa da coluna. */
function chaveDe(evento, dedupeKey) {
  const chave = `${evento}:${String(dedupeKey ?? '')}`;
  if (chave.length <= 191) return chave;
  return `${evento}:sha256:${crypto.createHash('sha256').update(chave).digest('hex')}`;
}

/** R$ 1.234,56 */
export function formatBrl(cents) {
  const valor = Number(cents);
  if (!Number.isFinite(valor)) return '-';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor / 100);
}

/** `dd/mm/aaaa` de uma data ISO (ou `YYYY-MM-DD`), no fuso de Brasília. */
function dataBr(valor) {
  if (!valor) return '-';
  const texto = String(valor);
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return texto.split('-').reverse().join('/');
  const data = asDate(texto);
  if (!data) return texto;
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric' }).format(data);
}

/** O dia e a hora de agora em Brasília. */
export function saoPauloClock(now = new Date()) {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${partes.year}-${partes.month}-${partes.day}`, hour: Number(partes.hour) };
}

/** O mês anterior ao do dia `AAAA-MM-DD`, como `AAAA-MM`. */
export function mesAnteriorDe(dia) {
  const [ano, mes] = String(dia).split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 2, 1)).toISOString().slice(0, 7);
}

/** `AAAA-MM` por extenso, no idioma das mensagens: "setembro de 2026". */
function rotuloDoMes(month, locale = DEFAULT_LOCALE) {
  const [ano, mes] = String(month).split('-').map(Number);
  if (!ano || !mes) return String(month);
  const opcoes = { month: 'long', year: 'numeric', timeZone: 'UTC' };
  const data = new Date(Date.UTC(ano, mes - 1, 1));
  try {
    return new Intl.DateTimeFormat(locale, opcoes).format(data);
  } catch {
    return new Intl.DateTimeFormat(DEFAULT_LOCALE, opcoes).format(data);
  }
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escaparHtml = (texto) => String(texto ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

function lerPayload(linha) {
  try {
    const lido = linha?.payload ? JSON.parse(linha.payload) : {};
    return lido && typeof lido === 'object' ? lido : {};
  } catch {
    return {};
  }
}

/** As variáveis da mensagem: o payload, com dinheiro e datas já formatados. */
function variaveis(payload) {
  return {
    ...payload,
    provider: payload.provider ?? '-',
    slug: payload.slug ?? '-',
    amount: payload.amountCents !== undefined ? formatBrl(payload.amountCents) : '-',
    threshold: payload.thresholdCents !== undefined ? formatBrl(payload.thresholdCents) : '-',
    date: dataBr(payload.date),
    reason: payload.reason ?? '-',
    referrer: payload.referrer ?? '-',
    error: payload.error ?? '-'
  };
}

/** Assunto e texto de um alerta, em pt-BR. */
export function renderAlert(linha) {
  const vars = variaveis(lerPayload(linha));
  const evento = linha.event;
  return {
    subject: translate(DEFAULT_LOCALE, `platformAlert.${evento}.subject`, vars),
    text: translate(DEFAULT_LOCALE, `platformAlert.${evento}.body`, vars)
  };
}

/** Os estados de uma linha da fila, na ordem em que o console os mostra. */
export const ALERT_STATUSES = Object.freeze(['pending', 'sent', 'failed', 'skipped']);
/**
 * Os estados que o console pode mandar de novo. `sent` já saiu (mandar de
 * novo seria repetir) e `pending` ainda vai sair.
 */
export const RESENDABLE = Object.freeze(['failed', 'skipped']);
/** Os eventos que aparecem no histórico: os configuráveis, o resumo e o teste. */
export const HISTORY_EVENTS = Object.freeze([...ALERT_EVENTS, DIGEST_EVENT, TEST_EVENT, MONTHLY_EVENT]);
const SUMMARY_MAX = 200;

/**
 * A linha do histórico numa frase: o assunto da mensagem, no idioma de quem
 * lê. Sai do payload, que já entrou limpo (`sanitizePayload`) — nem destino
 * nem segredo passam por aqui.
 */
export function summarizeAlert(linha, locale = DEFAULT_LOCALE) {
  const evento = linha?.event;
  if (!HISTORY_EVENTS.includes(evento)) return String(evento ?? '').slice(0, SUMMARY_MAX);
  const payload = lerPayload(linha);
  let vars;
  if (evento === DIGEST_EVENT) vars = { count: payload.count ?? '-', date: dataBr(payload.day) };
  else if (evento === MONTHLY_EVENT) vars = { month: payload.month ? rotuloDoMes(payload.month, locale) : '-' };
  else vars = variaveis(payload);
  return translate(locale, `platformAlert.${evento}.subject`, vars).slice(0, SUMMARY_MAX);
}

function isoOuNulo(valor) {
  const data = asDate(valor);
  return data ? data.toISOString() : null;
}

/** A linha (com o provedor do `leftJoin`) como o console a recebe. */
function linhaDoHistorico(linha, locale) {
  let tenant = null;
  if (linha.tenant_id !== null && linha.tenant_id !== undefined) {
    // O provedor pode ter sido apagado depois do alerta: o nome que a
    // mensagem levou continua no payload.
    const payload = lerPayload(linha);
    const existe = linha.tenant_name !== null && linha.tenant_name !== undefined;
    tenant = {
      id: Number(linha.tenant_id),
      name: existe ? linha.tenant_name : (payload.provider ?? null),
      slug: existe ? linha.tenant_slug : (payload.slug ?? null),
      deleted: !existe
    };
  }
  return {
    id: Number(linha.id),
    event: linha.event,
    tenant,
    summary: summarizeAlert(linha, locale),
    status: linha.status,
    attempts: Number(linha.attempts || 0),
    lastError: linha.last_error ?? null,
    createdAt: isoOuNulo(linha.created_at),
    sentAt: isoOuNulo(linha.sent_at),
    nextAttemptAt: isoOuNulo(linha.next_attempt_at)
  };
}

/** A consulta do histórico com o provedor ao lado (nulo se não há ou se foi apagado). */
function comProvedor(db) {
  return db('platform_alerts')
    .leftJoin('tenants', 'tenants.id', 'platform_alerts.tenant_id')
    .select('platform_alerts.*', 'tenants.name as tenant_name', 'tenants.slug as tenant_slug');
}

/** O provedor como a mensagem o nomeia. Nunca lança. */
async function provedor(tenantId) {
  if (!tenantId) return {};
  try {
    const linha = await getDb()('tenants').where({ id: tenantId }).first('name', 'slug');
    return linha ? { provider: linha.name, slug: linha.slug } : {};
  } catch {
    return {};
  }
}

/** A meia-noite de Brasília que abre o dia `AAAA-MM-DD` (sem horário de verão desde 2019). */
function inicioDoDiaSp(dia) {
  const data = new Date(`${dia}T00:00:00-03:00`);
  return Number.isNaN(data.getTime()) ? null : data;
}

/**
 * A janela do resumo antigo (sem ids no payload): do dia do resumo anterior
 * ao fim do dia deste, em Brasília. Sem resumo anterior, sem limite de baixo.
 */
async function janelaDoResumo(trx, resumo) {
  const dia = lerPayload(resumo).day ?? String(resumo.dedupe_key ?? '').slice(DIGEST_EVENT.length + 1);
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(dia) ? inicioDoDiaSp(dia) : null;
  const ate = inicio ? new Date(inicio.getTime() + 24 * 60 * 60 * 1000) : null;
  const anterior = await trx('platform_alerts')
    .where({ event: DIGEST_EVENT })
    .where('dedupe_key', '<', resumo.dedupe_key)
    .orderBy('dedupe_key', 'desc')
    .first('dedupe_key');
  const diaAnterior = anterior ? String(anterior.dedupe_key).slice(DIGEST_EVENT.length + 1) : null;
  const desde = diaAnterior && /^\d{4}-\d{2}-\d{2}$/.test(diaAnterior) ? inicioDoDiaSp(diaAnterior) : null;
  return { desde, ate };
}

class PlatformAlertService {
  /**
   * Os canais, trocáveis nos testes. Cada um devolve `true` se a mensagem saiu
   * e nunca lança — os dois que existem já são assim.
   */
  // Importados na hora do envio, e não no topo: este módulo é importado pelo
  // pagamento e pela sessão, e o WhatsApp da plataforma puxa a cifra dos
  // segredos — que, no topo, passaria a ser exigida por quem só grava a fila.
  static senders = {
    whatsapp: async (to, { subject, text }) => {
      const { default: PlatformNotifyService } = await import('./platformNotifyService.js');
      return PlatformNotifyService.sendWhatsapp(to, `*${subject}*\n\n${text}`);
    },
    email: async (to, { subject, text, html }) => {
      const { mailTransport } = await import('./mail/index.js');
      // `html` só no relatório mensal; os outros alertas são texto puro.
      return mailTransport().send({ to, subject, text, ...(html ? { html } : {}) });
    }
  };

  static EVENTS = ALERT_EVENTS;

  /**
   * Registra um alerta. Nunca lança e nunca manda nada: devolve
   * `{ enqueued, reason? }` — `disabled` (o evento está desligado),
   * `duplicate` (o mesmo fato já entrou), `error`.
   *
   * O nome e o subdomínio do provedor vão junto no payload quando há
   * `tenantId` — a mensagem é sobre ele, e o provedor pode ser apagado antes
   * de ela sair.
   */
  static async enqueue(event, { tenantId = null, dedupeKey, payload = {}, now = new Date(), config = null } = {}) {
    try {
      if (!ALERT_EVENTS.includes(event)) return { enqueued: false, reason: 'unknown_event' };
      const regras = config ?? await alertsConfig();
      if (!regras.events[event]?.enabled) return { enqueued: false, reason: 'disabled' };
      const chave = chaveDe(event, dedupeKey ?? crypto.randomUUID());
      const db = getDb();
      if (await db('platform_alerts').where({ dedupe_key: chave }).first('id')) {
        return { enqueued: false, reason: 'duplicate' };
      }
      const dados = sanitizePayload({ ...(await provedor(tenantId)), ...payload });
      try {
        await db('platform_alerts').insert({
          event,
          tenant_id: tenantId ? Number(tenantId) : null,
          payload: JSON.stringify(dados),
          dedupe_key: chave,
          status: 'pending',
          attempts: 0,
          next_attempt_at: null,
          created_at: aoSegundo(now)
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { enqueued: false, reason: 'duplicate' };
        throw error;
      }
      return { enqueued: true };
    } catch (error) {
      log.warn('platform alert enqueue failed', { event, err: error });
      return { enqueued: false, reason: 'error' };
    }
  }

  /** Para onde mandar: os destinos de Configurações → Dados do SaaS. */
  static async destinations() {
    const { values } = await readProfile().catch(() => ({ values: {} }));
    return {
      whatsapp: String(values.notifyWhatsapp || '').trim() || null,
      email: String(values.notifyEmail || '').trim() || null
    };
  }

  /**
   * Manda `mensagem` pelos `canais` que têm destino. Devolve por canal:
   * `true` saiu, `false` falhou, `null` sem destino.
   */
  static async deliver(canais, mensagem, destinos) {
    const resultado = {};
    for (const canal of ALERT_CHANNELS) {
      if (!canais.includes(canal)) continue;
      if (!destinos[canal]) {
        resultado[canal] = null;
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- dois canais no máximo
        resultado[canal] = Boolean(await this.senders[canal](destinos[canal], mensagem));
      } catch {
        resultado[canal] = false;
      }
    }
    return resultado;
  }

  /** A falha: mais uma tentativa depois da espera, ou `failed` no fim delas. */
  static async falhou(linha, motivo, now, extra = {}) {
    const tentativas = Number(linha.attempts || 0) + 1;
    const esgotou = tentativas >= MAX_ATTEMPTS;
    const espera = BACKOFF_MS[Math.min(tentativas - 1, BACKOFF_MS.length - 1)];
    await getDb()('platform_alerts').where({ id: linha.id }).update({
      status: esgotou ? 'failed' : 'pending',
      attempts: tentativas,
      last_error: String(motivo).slice(0, 255),
      next_attempt_at: esgotou ? null : aoSegundo(new Date(now.getTime() + espera)),
      ...extra
    });
    return esgotou ? 'failed' : 'retry';
  }

  /**
   * Toma a linha para esta passada — um `UPDATE` condicional, e quem perde a
   * corrida não manda. A garra é empurrar `next_attempt_at` para frente.
   */
  static async claim(linha, now) {
    const garra = aoSegundo(new Date(now.getTime() + CLAIM_MS));
    const mudou = await getDb()('platform_alerts')
      .where({ id: linha.id, status: 'pending' })
      .where((q) => q.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))
      .update({ next_attempt_at: garra });
    return mudou > 0;
  }

  /**
   * Manda UM alerta já tomado. `sent` se ao menos um canal saiu — repetir
   * mandaria de novo pelo que já foi —, `skipped` sem destino ou com o evento
   * desligado, nova tentativa se todos os canais com destino falharam.
   */
  static async sendOne(linha, { now = new Date(), config, destinos, channels = null } = {}) {
    const db = getDb();
    let regra;
    if (linha.event === TEST_EVENT || (linha.event === MONTHLY_EVENT && channels)) {
      regra = { enabled: true, channels: channels ?? [...ALERT_CHANNELS] };
    } else if (linha.event === MONTHLY_EVENT) {
      regra = config.monthlyReport;
    } else {
      regra = config.events[linha.event];
    }
    if (!regra?.enabled) {
      await db('platform_alerts').where({ id: linha.id }).update({ status: 'skipped', last_error: 'disabled', next_attempt_at: null });
      return { status: 'skipped', reason: 'disabled' };
    }
    const mensagem = linha.event === MONTHLY_EVENT
      ? await this.renderMonthlyReport(lerPayload(linha).month, { now })
      : renderAlert(linha);
    const resultado = await this.deliver(regra.channels, mensagem, destinos);
    const valores = Object.values(resultado);
    if (valores.some((v) => v === true)) {
      const falhas = Object.entries(resultado).filter(([, v]) => v === false).map(([c]) => c);
      await db('platform_alerts').where({ id: linha.id }).update({
        status: 'sent',
        sent_at: aoSegundo(now),
        next_attempt_at: null,
        last_error: falhas.length ? `failed: ${falhas.join(',')}` : null
      });
      return { status: 'sent', channels: resultado };
    }
    if (!valores.some((v) => v === false)) {
      await db('platform_alerts').where({ id: linha.id }).update({ status: 'skipped', last_error: 'no_destination', next_attempt_at: null });
      return { status: 'skipped', reason: 'no_destination', channels: resultado };
    }
    const fim = await this.falhou(linha, 'send_failed', now);
    return { status: fim === 'failed' ? 'failed' : 'pending', reason: 'send_failed', channels: resultado };
  }

  /**
   * A passada do agendador. Nunca lança. Com o resumo diário ligado, só o
   * resumo sai (`processDigest`); senão, cada pendente vencido, um a um.
   */
  static async processDue({ now = new Date(), budgetMs = PASS_BUDGET_MS, clock = () => Date.now() } = {}) {
    const resumo = { sent: 0, failed: 0, skipped: 0, retry: 0 };
    const inicio = clock();
    try {
      const config = await alertsConfig();
      // O relatório mensal sai sozinho, antes e fora do resumo diário.
      const mensal = await this.processMonthly({ now, config });
      if (mensal) resumo.monthly = mensal;
      if (config.dailyDigest.enabled) return { ...resumo, digest: await this.processDigest({ now, config }) };
      const db = getDb();
      // Com o resumo desligado, nenhuma linha de resumo sai mais (a passada um
      // a um não as manda): a pendente vira `skipped`, para não ficar parada
      // para sempre. Os alertas dela continuam pendentes e saem um a um. A
      // linha tomada por outra passada (`next_attempt_at` no futuro) fica com
      // quem a tomou.
      await db('platform_alerts')
        .where({ event: DIGEST_EVENT, status: 'pending' })
        .where((q) => q.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))
        .update({ status: 'skipped', last_error: 'disabled', next_attempt_at: null });
      const linhas = await db('platform_alerts')
        .where({ status: 'pending' })
        .whereNotIn('event', FORA_DA_FILA)
        .where((q) => q.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))
        .orderBy('id')
        .limit(BATCH);
      if (!linhas.length) return resumo;
      const destinos = await this.destinations();
      for (const [indice, linha] of linhas.entries()) {
        // O prazo da passada estourou: o que falta espera a próxima, sem
        // garra nem tentativa gasta.
        if (clock() - inicio >= budgetMs) {
          resumo.deferred = linhas.length - indice;
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- um envio por vez, em ordem
        if (!(await this.claim(linha, now))) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await this.sendOne(linha, { now, config, destinos });
          if (r.status === 'sent') resumo.sent += 1;
          else if (r.status === 'skipped') resumo.skipped += 1;
          else if (r.status === 'failed') resumo.failed += 1;
          else resumo.retry += 1;
        } catch (error) {
          log.warn('platform alert send failed', { id: linha.id, err: error });
          // eslint-disable-next-line no-await-in-loop
          await this.falhou(linha, 'error', now).catch(() => {});
          resumo.retry += 1;
        }
      }
    } catch (error) {
      log.warn('platform alerts pass failed', { err: error });
      resumo.error = error.message;
    }
    return resumo;
  }

  /**
   * O resumo diário: à hora escolhida (Brasília), tudo o que está pendente vira
   * UMA mensagem por canal — cada alerta entra nos canais do evento dele.
   *
   * A memória de "o resumo de hoje já saiu" é uma linha da própria fila, com
   * `dedupe_key` `digest:AAAA-MM-DD`: a inserção é a garra (dois processos, um
   * resumo), e as novas tentativas dela seguem a regra de qualquer alerta. O
   * que chegar depois do resumo de hoje espera o de amanhã.
   */
  static async processDigest({ now = new Date(), config }) {
    const { day, hour } = saoPauloClock(now);
    if (hour < config.dailyDigest.hour) return { action: 'waiting' };
    const db = getDb();
    const chave = `${DIGEST_EVENT}:${day}`;
    // O resumo de um dia que passou e ainda está pendente (falhou e esperava
    // nova tentativa, ou o processo ficou fora) não sai mais: os alertas dele
    // continuam pendentes e entram no de hoje. Sem isto, ele tentaria de novo
    // e mandaria um segundo resumo com os mesmos itens. A linha tomada por
    // outra passada (`next_attempt_at` no futuro) fica com quem a tomou.
    await db('platform_alerts')
      .where({ event: DIGEST_EVENT, status: 'pending' })
      .where('dedupe_key', '<', chave)
      .where((q) => q.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))
      .update({ status: 'skipped', last_error: 'superseded', next_attempt_at: null });
    let linha = await db('platform_alerts').where({ dedupe_key: chave }).first();
    if (!linha) {
      try {
        await db('platform_alerts').insert({
          event: DIGEST_EVENT,
          tenant_id: null,
          payload: JSON.stringify({ day }),
          dedupe_key: chave,
          status: 'pending',
          attempts: 0,
          next_attempt_at: null,
          created_at: aoSegundo(now)
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      linha = await db('platform_alerts').where({ dedupe_key: chave }).first();
    }
    if (!linha || linha.status !== 'pending') return { action: 'done' };
    const proxima = asDate(linha.next_attempt_at);
    if (proxima && proxima.getTime() > now.getTime()) return { action: 'waiting_retry' };
    if (!(await this.claim(linha, now))) return { action: 'busy' };

    const pendentes = await db('platform_alerts')
      .where({ status: 'pending' })
      .whereNotIn('event', FORA_DA_FILA)
      .where('created_at', '<=', aoSegundo(now))
      .orderBy('id');
    const ativos = pendentes.filter((p) => config.events[p.event]?.enabled);
    const desligados = pendentes.filter((p) => !config.events[p.event]?.enabled).map((p) => p.id);
    if (desligados.length) {
      await db('platform_alerts').whereIn('id', desligados)
        .update({ status: 'skipped', last_error: 'disabled', next_attempt_at: null });
    }
    if (!ativos.length) {
      await db('platform_alerts').where({ id: linha.id })
        .update({ status: 'skipped', last_error: 'empty', next_attempt_at: null, sent_at: aoSegundo(now) });
      return { action: 'empty' };
    }

    const destinos = await this.destinations();
    const resultado = {};
    for (const canal of ALERT_CHANNELS) {
      const doCanal = ativos.filter((p) => config.events[p.event].channels.includes(canal));
      if (!doCanal.length) continue;
      const mensagem = this.renderDigest(doCanal, day);
      // eslint-disable-next-line no-await-in-loop -- dois canais no máximo
      Object.assign(resultado, await this.deliver([canal], mensagem, destinos));
    }
    const valores = Object.values(resultado);
    const ids = ativos.map((p) => p.id);
    if (valores.some((v) => v === true)) {
      await db('platform_alerts').whereIn('id', ids)
        .update({ status: 'sent', sent_at: aoSegundo(now), next_attempt_at: null });
      await db('platform_alerts').where({ id: linha.id }).update({
        status: 'sent',
        sent_at: aoSegundo(now),
        next_attempt_at: null,
        payload: JSON.stringify({ day, count: ativos.length })
      });
      return { action: 'sent', count: ativos.length, channels: resultado };
    }
    if (!valores.some((v) => v === false)) {
      await db('platform_alerts').whereIn('id', [...ids, linha.id])
        .update({ status: 'skipped', last_error: 'no_destination', next_attempt_at: null });
      return { action: 'skipped', reason: 'no_destination' };
    }
    const fim = await this.falhou(linha, 'send_failed', now);
    if (fim === 'failed') {
      // O resumo desistiu: os alertas dele também, para não ficarem para sempre.
      await db('platform_alerts').whereIn('id', ids)
        .update({ status: 'failed', last_error: 'digest_failed', next_attempt_at: null });
      // E o resumo guarda QUAIS alertas eram dele (até `DIGEST_MAX_IDS`): o
      // "Reenviar" dele devolve só esses à fila, e não os de outro resumo.
      const truncado = ids.length > DIGEST_MAX_IDS;
      await db('platform_alerts').where({ id: linha.id }).update({
        payload: JSON.stringify({
          day, count: ativos.length, ids: ids.slice(0, DIGEST_MAX_IDS), ...(truncado ? { idsTruncated: true } : {})
        })
      });
    }
    return { action: fim === 'failed' ? 'failed' : 'retry', channels: resultado };
  }

  /**
   * O texto do resumo: uma linha por alerta, na ordem em que chegaram — no
   * máximo `DIGEST_MAX_ITEMS` linhas e `DIGEST_MAX_CHARS` caracteres, com o
   * que sobrou contado num "+N mais". Um dia ruim (cem cartões recusados)
   * não pode virar uma mensagem que o WhatsApp recusa inteira.
   */
  static renderDigest(linhas, day) {
    const vars = { count: linhas.length, date: dataBr(day) };
    const cabecalho = translate(DEFAULT_LOCALE, 'platformAlert.digest.body', vars);
    const mais = (n) => translate(DEFAULT_LOCALE, 'platformAlert.digest.more', { count: n });
    // A reserva da linha "+N mais" com o maior N possível, para caber sempre.
    const reserva = 1 + mais(linhas.length).length;
    let texto = `${cabecalho}\n`;
    let listados = 0;
    for (const linha of linhas.slice(0, DIGEST_MAX_ITEMS)) {
      const item = `\n• ${renderAlert(linha).subject}`;
      if (texto.length + item.length + reserva > DIGEST_MAX_CHARS) break;
      texto += item;
      listados += 1;
    }
    if (listados < linhas.length) texto += `\n${mais(linhas.length - listados)}`;
    return {
      subject: translate(DEFAULT_LOCALE, 'platformAlert.digest.subject', vars),
      text: texto.slice(0, DIGEST_MAX_CHARS)
    };
  }

  /**
   * O "Enviar alerta de teste" do console: grava e manda AGORA, fora do resumo
   * e da configuração por evento, pelos `channels` pedidos (os dois, sem
   * pedido). Devolve o resultado por canal.
   */
  static async sendTest({ channels = null, now = new Date() } = {}) {
    const canais = Array.isArray(channels) && channels.length
      ? ALERT_CHANNELS.filter((c) => channels.includes(c))
      : [...ALERT_CHANNELS];
    const destinos = await this.destinations();
    if (!canais.some((c) => destinos[c])) return { status: 'skipped', reason: 'no_destination', channels: {} };
    const chave = chaveDe(TEST_EVENT, `${now.getTime()}:${crypto.randomUUID()}`);
    const db = getDb();
    await db('platform_alerts').insert({
      event: TEST_EVENT,
      tenant_id: null,
      payload: JSON.stringify({}),
      dedupe_key: chave,
      status: 'pending',
      attempts: 0,
      // Já tomada: a passada do agendador não a manda de novo no meio.
      next_attempt_at: aoSegundo(new Date(now.getTime() + CLAIM_MS)),
      created_at: aoSegundo(now)
    });
    const linha = await db('platform_alerts').where({ dedupe_key: chave }).first();
    const r = await this.sendOne(linha, { now, destinos, channels: canais });
    if (r.status !== 'sent') {
      // O teste não fica tentando sozinho: quem apertou o botão vê o resultado.
      await db('platform_alerts').where({ id: linha.id }).update({ status: 'failed', next_attempt_at: null });
    }
    return r;
  }

  /**
   * `big_overdue`: o provedor cujo total em atraso passou do limite. Uma
   * consulta só, acima dos provedores (`BillingCharge.openAcrossTenants`), e um
   * alerta por provedor POR PERÍODO DE ATRASO — a chave leva o vencimento
   * mais antigo em aberto, então o mesmo atraso avisa uma vez, e o próximo
   * atraso (depois de pagar) avisa de novo. Nunca lança.
   *
   * Só entra o que é dívida de verdade: cobrança `pending`/`overdue` que
   * existe no gateway (`gateway_charge_id`) e já venceu. A `failed` nunca
   * chegou ao gateway — não há o que o provedor pague —, e a assinatura
   * cancelada ou isenta de cobrança não deve nada, tenha a linha que tiver.
   */
  static async checkBigOverdue({ now = new Date(), config = null } = {}) {
    try {
      const regras = config ?? await alertsConfig();
      if (!regras.events.big_overdue?.enabled) return { checked: false, reason: 'disabled' };
      const { default: BillingCharge, prorationOverdueAt, isoDateOf } = await import('../models/BillingCharge.js');
      const abertas = await BillingCharge.openAcrossTenants();
      const porProvedor = new Map();
      for (const linha of abertas) {
        if (!BIG_OVERDUE_STATUSES.includes(linha.status) || !linha.gateway_charge_id) continue;
        const vence = prorationOverdueAt(linha.due_date);
        if (!vence || vence.getTime() > now.getTime()) continue;
        const atual = porProvedor.get(Number(linha.tenant_id)) ?? { cents: 0, oldest: null };
        atual.cents += Number(linha.amount_cents || 0);
        const dia = isoDateOf(linha.due_date);
        if (!atual.oldest || dia < atual.oldest) atual.oldest = dia;
        porProvedor.set(Number(linha.tenant_id), atual);
      }
      const candidatos = [...porProvedor].filter(([, { cents }]) => cents >= regras.bigOverdueCents);
      if (!candidatos.length) return { checked: true, enqueued: 0 };
      const ids = candidatos.map(([tenantId]) => tenantId);
      // tenant-scope-exempt: leitura do plano de controle, acima dos provedores.
      const { tenants, assinaturas } = await runUnscoped('the platform alerts check the overdue providers', async () => {
        const db = getDb();
        return {
          tenants: await db('tenants').whereIn('id', ids).select('id', 'kind'),
          assinaturas: await db('subscriptions').whereIn('tenant_id', ids)
            .select('tenant_id', 'status', 'billing_exempt_at')
        };
      });
      const tipoDe = new Map(tenants.map((t) => [Number(t.id), t.kind]));
      const subDe = new Map(assinaturas.map((a) => [Number(a.tenant_id), a]));
      let enqueued = 0;
      for (const [tenantId, { cents, oldest }] of candidatos) {
        const tipo = tipoDe.get(tenantId);
        if (!tipo || tipo === 'platform') continue;
        const sub = subDe.get(tenantId);
        if (sub && (sub.status === 'canceled' || sub.billing_exempt_at)) continue;
        // eslint-disable-next-line no-await-in-loop -- poucos provedores em atraso
        const r = await this.enqueue('big_overdue', {
          tenantId,
          dedupeKey: `${tenantId}:${oldest}`,
          payload: { amountCents: cents, thresholdCents: regras.bigOverdueCents, date: oldest },
          now,
          config: regras
        });
        if (r.enqueued) enqueued += 1;
      }
      return { checked: true, enqueued };
    } catch (error) {
      log.warn('big overdue check failed', { err: error });
      return { checked: false, reason: 'error' };
    }
  }

  /**
   * O histórico do console: a fila inteira, a mais nova primeiro, paginada.
   * `from` (inclusive) e `until` (exclusive) são instantes já resolvidos por
   * quem chama. `counts` conta por estado com os MESMOS filtros menos o de
   * estado — são os números das abas, que não podem sumir ao escolher uma.
   *
   * As duas tabelas são da plataforma (compartilhadas): nada de escopo de
   * provedor aqui, como no resto deste serviço.
   */
  static async history({ status = null, event = null, from = null, until = null, page = 1, pageSize = 25, locale = DEFAULT_LOCALE } = {}) {
    const db = getDb();
    const filtros = (q) => {
      if (event) q.where('platform_alerts.event', event);
      if (from) q.where('platform_alerts.created_at', '>=', from);
      if (until) q.where('platform_alerts.created_at', '<', until);
      return q;
    };
    const comEstado = (q) => (status ? q.where('platform_alerts.status', status) : q);

    const linhas = await comEstado(filtros(comProvedor(db)))
      .orderBy('platform_alerts.id', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const [{ n: total } = { n: 0 }] = await comEstado(filtros(db('platform_alerts'))).count('* as n');
    const porEstado = await filtros(db('platform_alerts'))
      .select('platform_alerts.status')
      .count('* as n')
      .groupBy('platform_alerts.status');
    const counts = Object.fromEntries(ALERT_STATUSES.map((s) => [s, 0]));
    for (const { status: estado, n } of porEstado) {
      if (estado in counts) counts[estado] = Number(n);
    }
    return {
      alerts: linhas.map((l) => linhaDoHistorico(l, locale)),
      total: Number(total),
      page,
      pageSize,
      counts
    };
  }

  /**
   * O "Reenviar" do histórico: a linha `failed`/`skipped` volta para a fila
   * (`pending`, tentativas zeradas, vencida agora) e a próxima passada do
   * agendador a manda pela regra de sempre — com o evento desligado ou sem
   * destino ela volta a `skipped`, como qualquer outra.
   *
   * O `UPDATE` condicional é a guarda: dois cliques (ou o clique e a passada
   * do agendador) dão em UMA linha reaberta; o outro recebe `not_resendable`.
   *
   *   - `test` não volta: a passada do agendador não manda teste (é o botão
   *     que manda na hora), e ele ficaria pendente para sempre.
   *   - `digest` volta, e com ele os alertas que caíram junto
   *     (`failed`/`digest_failed`) — esses nunca saíram, então não há envio
   *     em dobro. Só os DESSE resumo: os ids que ele gravou ao desistir, ou,
   *     na linha antiga (sem ids, ou com a lista cortada), os criados entre o
   *     dia do resumo anterior e o fim do dia deste (Brasília). Se o resumo
   *     for de um dia que passou, a próxima passada o marca `superseded` e os
   *     alertas entram no resumo de hoje: é o `processDigest` de sempre.
   *     Com o resumo diário DESLIGADO, o resumo não sai mais (a passada um a
   *     um não o manda): os alertas dele voltam para sair um a um, e a linha
   *     do resumo fica `skipped`/`disabled` — nada parado em `pending`.
   *   - O relatório mensal do "Enviar agora" (`manual`) volta marcado
   *     `resent`: é o sinal para a passada mandá-lo (ver `processMonthly`).
   *
   * Devolve `{ alert, requeued, previousStatus }`, ou `{ error }`:
   * `not_found`, `not_resendable` (com o `status` atual).
   */
  static async resend(id, { now = new Date(), locale = DEFAULT_LOCALE } = {}) {
    const db = getDb();
    const config = await alertsConfig();
    const resultado = await db.transaction(async (trx) => {
      const antes = await trx('platform_alerts').where({ id }).first('id', 'event', 'status', 'payload', 'dedupe_key');
      if (!antes) return { error: 'not_found' };
      const mudou = await trx('platform_alerts')
        .where({ id })
        .whereIn('status', RESENDABLE)
        .whereNot('event', TEST_EVENT)
        .update({ status: 'pending', attempts: 0, next_attempt_at: aoSegundo(now), last_error: null });
      if (!mudou) {
        const agora = await trx('platform_alerts').where({ id }).first('status');
        return { error: 'not_resendable', status: agora?.status ?? antes.status };
      }
      let requeued = 0;
      if (antes.event === DIGEST_EVENT) {
        const payload = lerPayload(antes);
        const daLista = Array.isArray(payload.ids) && !payload.idsTruncated
          ? payload.ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : null;
        let alvo = trx('platform_alerts')
          .where({ status: 'failed', last_error: 'digest_failed' })
          .whereNotIn('event', FORA_DA_FILA);
        if (daLista) {
          alvo = alvo.whereIn('id', daLista.length ? daLista : [0]);
        } else {
          const janela = await janelaDoResumo(trx, antes);
          if (janela.desde) alvo = alvo.where('created_at', '>=', janela.desde);
          if (janela.ate) alvo = alvo.where('created_at', '<', janela.ate);
        }
        requeued = await alvo.update({ status: 'pending', attempts: 0, next_attempt_at: null, last_error: null });
        if (!config.dailyDigest?.enabled) {
          // Resumo desligado: os alertas saem um a um, e a linha do resumo
          // não fica pendente à espera de uma passada que nunca a manda.
          await trx('platform_alerts').where({ id })
            .update({ status: 'skipped', last_error: 'disabled', next_attempt_at: null });
        }
      } else if (antes.event === MONTHLY_EVENT) {
        const payload = lerPayload(antes);
        if (payload.manual) {
          await trx('platform_alerts').where({ id })
            .update({ payload: JSON.stringify({ ...payload, resent: true }) });
        }
      }
      return { requeued: Number(requeued) || 0, previousStatus: antes.status, event: antes.event };
    });
    if (resultado.error) return resultado;
    const linha = await comProvedor(db).where('platform_alerts.id', id).first();
    return { ...resultado, alert: linhaDoHistorico(linha, locale) };
  }

  /**
   * O relatório mensal: no dia 1º, a partir da hora escolhida (Brasília) —
   * ou nos dias 2 e 3, se o 1º passou sem ele (o processo fora do ar) —, UMA
   * linha na fila com `dedupe_key` `monthly:AAAA-MM` do mês que acabou. A
   * chave única é a garra: dois processos, dois reinícios, um relatório. O
   * envio é o da passada (`processMonthly`). Nunca lança.
   */
  static async checkMonthlyReport({ now = new Date(), config = null } = {}) {
    try {
      const regras = config ?? await alertsConfig();
      const regra = regras.monthlyReport;
      if (!regra?.enabled) return { checked: false, reason: 'disabled' };
      const { day, hour } = saoPauloClock(now);
      const dia = Number(day.slice(8, 10));
      if (dia > MONTHLY_CATCHUP_DAYS) return { checked: true, enqueued: false, reason: 'outside_window' };
      if (dia === 1 && hour < regra.hour) return { checked: true, enqueued: false, reason: 'waiting' };
      const month = mesAnteriorDe(day);
      const chave = `monthly:${month}`;
      const db = getDb();
      if (await db('platform_alerts').where({ dedupe_key: chave }).first('id')) {
        return { checked: true, enqueued: false, reason: 'duplicate', month };
      }
      try {
        await db('platform_alerts').insert({
          event: MONTHLY_EVENT,
          tenant_id: null,
          payload: JSON.stringify({ month }),
          dedupe_key: chave,
          status: 'pending',
          attempts: 0,
          next_attempt_at: null,
          created_at: aoSegundo(now)
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { checked: true, enqueued: false, reason: 'duplicate', month };
        throw error;
      }
      return { checked: true, enqueued: true, month };
    } catch (error) {
      log.warn('monthly report check failed', { err: error });
      return { checked: false, reason: 'error' };
    }
  }

  /**
   * Manda os relatórios mensais pendentes e vencidos, um a um — com garra e
   * novas tentativas como qualquer alerta. Devolve o resumo, ou nulo sem nada.
   */
  static async processMonthly({ now = new Date(), config }) {
    const db = getDb();
    const vencidas = await db('platform_alerts')
      .where({ status: 'pending', event: MONTHLY_EVENT })
      .where((q) => q.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))
      .orderBy('id')
      .limit(20);
    // A do "Enviar agora" (`manual`) é mandada pelo botão, na hora: se ainda
    // está pendente com a garra vencida, o processo caiu no meio — e o
    // relatório pode já ter saído. Mandar de novo seria repetir: ela vira
    // `failed`/`interrupted`, e quem quiser a reenvia pelo histórico (aí ela
    // volta marcada `resent` e sai por aqui).
    const interrompidas = [];
    const linhas = [];
    for (const linha of vencidas) {
      const payload = lerPayload(linha);
      if (payload.manual && !payload.resent) interrompidas.push(linha.id);
      else linhas.push(linha);
    }
    if (interrompidas.length) {
      await db('platform_alerts').whereIn('id', interrompidas).where({ status: 'pending' })
        .update({ status: 'failed', last_error: 'interrupted', next_attempt_at: null });
    }
    if (!linhas.length) return interrompidas.length ? { sent: 0, failed: interrompidas.length, skipped: 0, retry: 0 } : null;
    const resumo = { sent: 0, failed: interrompidas.length, skipped: 0, retry: 0 };
    const destinos = await this.destinations();
    for (const linha of linhas.slice(0, 5)) {
      // eslint-disable-next-line no-await-in-loop -- um relatório por mês
      if (!(await this.claim(linha, now))) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await this.sendOne(linha, { now, config, destinos });
        if (r.status === 'sent') resumo.sent += 1;
        else if (r.status === 'skipped') resumo.skipped += 1;
        else if (r.status === 'failed') resumo.failed += 1;
        else resumo.retry += 1;
      } catch (error) {
        log.warn('monthly report send failed', { id: linha.id, err: error });
        // eslint-disable-next-line no-await-in-loop
        await this.falhou(linha, 'error', now).catch(() => {});
        resumo.retry += 1;
      }
    }
    return resumo;
  }

  /**
   * O texto (WhatsApp e corpo do e-mail) e o HTML simples do relatório de
   * `month` (`AAAA-MM`), com a variação sobre o mês anterior. Os números são
   * recalculados na hora do envio (`platformMetricsService.monthSummary`): o
   * mês já fechou, e o que muda entre duas tentativas é só o que o extrato
   * corrigiu depois.
   */
  static async renderMonthlyReport(month, { now = new Date() } = {}) {
    const { monthSummary } = await import('./platformMetricsService.js');
    const { current: atual, previous: antes } = await monthSummary(month, { now });
    const vazio = {
      mrrCents: 0, payingCount: 0, receivedCents: 0, refundedCents: 0, newTenants: 0,
      canceledTenants: 0, churnRate: null, overdueCents: 0, overdueCount: 0
    };
    const m = atual ?? vazio;
    const rotulo = rotuloDoMes(month);
    const variacao = (campo) => {
      if (!antes) return '';
      const delta = Number(m[campo]) - Number(antes[campo]);
      if (!delta) return '';
      return ` (${delta > 0 ? '+' : '-'}${formatBrl(Math.abs(delta))})`;
    };
    const churn = m.churnRate === null || m.churnRate === undefined
      ? '-' : `${(m.churnRate * 100).toFixed(1).replace('.', ',')}%`;
    const t = (chave, vars = {}) => translate(DEFAULT_LOCALE, `platformAlert.monthly_report.${chave}`, vars);
    const linhas = [
      t('mrr', { value: `${formatBrl(m.mrrCents)}${variacao('mrrCents')}`, count: m.payingCount }),
      t('received', { value: `${formatBrl(m.receivedCents)}${variacao('receivedCents')}` }),
      t('refunded', { value: formatBrl(m.refundedCents) }),
      t('tenants', { new: m.newTenants, canceled: m.canceledTenants }),
      t('churn', { value: churn }),
      t('overdue', { value: formatBrl(m.overdueCents), count: m.overdueCount })
    ];
    const subject = t('subject', { month: rotulo });
    const cabecalho = t('body', { month: rotulo });
    const nota = t('note');
    const text = `${cabecalho}\n\n${linhas.map((l) => `• ${l}`).join('\n')}\n\n${nota}`;
    const html = [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">',
      `<h2 style="font-size:18px;margin:0 0 12px">${escaparHtml(subject)}</h2>`,
      `<p style="margin:0 0 12px">${escaparHtml(cabecalho)}</p>`,
      '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse">',
      ...linhas.map((l) => {
        const [nome, ...resto] = l.split(': ');
        return `<tr><td style="border-bottom:1px solid #ddd;color:#555">${escaparHtml(nome)}</td>`
          + `<td style="border-bottom:1px solid #ddd;font-weight:bold">${escaparHtml(resto.join(': '))}</td></tr>`;
      }),
      '</table>',
      `<p style="margin:12px 0 0;color:#777;font-size:12px">${escaparHtml(nota)}</p>`,
      '</div>'
    ].join('');
    return { subject, text, html };
  }

  /**
   * O "Enviar relatório agora": o relatório do mês anterior, AGORA, fora da
   * deduplicação do agendador (a chave leva o instante), pelos `channels`
   * pedidos — sem pedido, os da configuração do relatório. Devolve o
   * resultado por canal e o mês.
   */
  static async sendMonthlyReportNow({ channels = null, now = new Date() } = {}) {
    const config = await alertsConfig();
    const configurados = config.monthlyReport?.channels?.length ? config.monthlyReport.channels : [...ALERT_CHANNELS];
    const canais = Array.isArray(channels) && channels.length
      ? ALERT_CHANNELS.filter((c) => channels.includes(c))
      : [...configurados];
    const month = mesAnteriorDe(saoPauloClock(now).day);
    const destinos = await this.destinations();
    if (!canais.some((c) => destinos[c])) return { status: 'skipped', reason: 'no_destination', channels: {}, month };
    const chave = `monthly:${month}:manual:${now.getTime()}:${crypto.randomUUID()}`;
    const db = getDb();
    await db('platform_alerts').insert({
      event: MONTHLY_EVENT,
      tenant_id: null,
      payload: JSON.stringify({ month, manual: true }),
      dedupe_key: chave,
      status: 'pending',
      attempts: 0,
      // Já tomada: a passada do agendador não a manda de novo no meio.
      next_attempt_at: aoSegundo(new Date(now.getTime() + CLAIM_MS)),
      created_at: aoSegundo(now)
    });
    const linha = await db('platform_alerts').where({ dedupe_key: chave }).first();
    let r;
    try {
      r = await this.sendOne(linha, { now, config, destinos, channels: canais });
    } catch (error) {
      await db('platform_alerts').where({ id: linha.id })
        .update({ status: 'failed', last_error: 'error', next_attempt_at: null });
      throw error;
    }
    if (r.status !== 'sent') {
      // Como o teste: quem apertou o botão vê o resultado, e nada tenta sozinho.
      await db('platform_alerts').where({ id: linha.id }).update({ status: 'failed', next_attempt_at: null });
    }
    return { ...r, month };
  }

  /** O passo da plataforma no agendador: o atraso grande, depois o envio. Nunca lança. */
  static lastOverdueCheckAt = 0;
  static OVERDUE_CHECK_MS = 15 * 60_000;

  static async schedulerPass({ now = new Date() } = {}) {
    const resumo = {};
    if (now.getTime() - this.lastOverdueCheckAt >= this.OVERDUE_CHECK_MS) {
      this.lastOverdueCheckAt = now.getTime();
      resumo.bigOverdue = await this.checkBigOverdue({ now });
    }
    resumo.monthlyReport = await this.checkMonthlyReport({ now });
    resumo.send = await this.processDue({ now });
    return resumo;
  }
}

export default PlatformAlertService;
