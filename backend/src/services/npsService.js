import crypto from 'node:crypto';
import { getDb, isUniqueViolation, tdb, tinsertReturningId } from '../config/database.js';
import { runInTenant, runUnscoped } from '../config/tenantContext.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import { PRODUCT_NAME } from '../config/brand.js';
import Tenant from '../models/Tenant.js';
import Subscription from '../models/Subscription.js';
import BillingCharge, { isoDateOf } from '../models/BillingCharge.js';
import { BILLING_EVENT_TYPES } from '../models/BillingEvent.js';
import SubscriptionService, { isCancelScheduled, isPauseScheduled } from './subscriptionService.js';
import SubscriptionNoticeService from './subscriptionNoticeService.js';
import PlatformNotifyService from './platformNotifyService.js';
import ChargeIssuingService from './chargeIssuingService.js';
import { mailTransport } from './mail/index.js';
import { panelBaseDomain, platformExtraHosts } from '../middleware/tenantResolver.js';
import { mesesAte } from './platformMetricsService.js';
import { instanteMs } from './revenueReportService.js';
import { log } from '../utils/logger.js';
import { variantesTelefoneBr } from '../utils/wa/waDestino.js';

/**
 * A pesquisa de satisfação dos provedores (0123): o NPS que a PLATAFORMA pede
 * a quem paga por ela — "de 0 a 10, quanto você nos recomendaria?". Não é o
 * CSAT de 1 a 5 que o provedor pede aos assinantes dele (`waSatisfactionService`),
 * embora a leitura da nota no WhatsApp siga o mesmo molde.
 *
 * ## Quando pergunta
 *
 * O agendador (`schedulerPass`, no passo da plataforma, fora do laço por
 * provedor) manda a etapa `d30` 30 dias depois do início da assinatura paga e
 * a `d90` 90 dias depois. O início é o primeiro pagamento registrado no
 * extrato (`payment.recorded` com valor); sem ele, o fim do teste de uma
 * assinatura que já está num período pago. Cada etapa tem uma janela de
 * `WAVE_WINDOW_DAYS` dias: o primeiro deploy não pergunta de uma vez a todo
 * provedor antigo, e quem passou da janela sem receber (o agendador parado,
 * nenhum canal) não recebe uma "d30" no dia 80. Para esses há o envio manual.
 *
 * Não pergunta a quem está em teste, isento, cancelado ou suspenso, nem à
 * caixa da plataforma; nem a quem recebeu outra pesquisa há menos de
 * `QUIET_DAYS` dias.
 *
 * ## Uma vez por etapa
 *
 * A linha nasce ANTES do envio, e é o índice único `(tenant_id, wave_key)` que
 * decide quem manda: duas passadas ao mesmo tempo não mandam duas vezes. Se
 * nada sai (SMTP fora, o WhatsApp dizendo que não foi), a linha da etapa
 * automática FICA, pendente, com `channel = 'failed:<n>'` — n tentativas — e
 * a passada tenta de novo só depois de `RETRY_AFTER_HOURS` horas, até
 * `MAX_SEND_ATTEMPTS` tentativas na etapa. Apagá-la para a próxima passada
 * (de hora em hora) recomeçar faria um WhatsApp que respondeu "não" mas
 * entregou chegar de novo a cada hora. A manual, que é um clique de gente,
 * some se nada sai: quem clicou vê a falha e decide.
 *
 * ## O link
 *
 * Um token de 256 bits, que só existe na mensagem: o banco guarda o sha256
 * dele (`token_hash`). A página pública (`/nps#<token>`) manda o token no
 * CORPO (`POST /api/public/nps/lookup` e `/answer`), como o convite, para ele
 * não acabar no log de quem grava o caminho. Token desconhecido é 404 sem
 * nada; vencido (30 dias sem resposta) é 410.
 *
 * ## Responder de novo
 *
 * Quem já respondeu pode MUDAR a nota e o comentário pelo mesmo link durante
 * `EDIT_WINDOW_DAYS` dias, contados da PRIMEIRA resposta (editar não estica o
 * prazo). Depois disso a resposta fica como está, e o link responde 409.
 *
 * ## Pelo WhatsApp
 *
 * `tryCaptureWhatsappReply` é a porta para o bot da plataforma: um número de
 * 0 a 10 mandado pelo provedor com uma pesquisa pendente vira a nota. O texto
 * da pergunta só convida a responder pelo WhatsApp quando quem integra o bot
 * liga `NpsService.whatsappReplyEnabled`.
 */

/** As etapas: as duas do agendador e a do console. */
export const NPS_WAVES = Object.freeze(['d30', 'd90', 'manual']);
/** Os dias, desde o início da assinatura paga, de cada etapa automática. */
export const WAVE_DAYS = Object.freeze({ d30: 30, d90: 90 });
/** Por quantos dias uma etapa ainda sai depois do dia dela. */
export const WAVE_WINDOW_DAYS = 14;
/** Sem resposta em tantos dias, a pesquisa vence. */
export const EXPIRE_DAYS = 30;
/** Por quantos dias, desde a primeira resposta, a nota ainda pode mudar. */
export const EDIT_WINDOW_DAYS = 7;
/** Nenhuma pesquisa automática a quem recebeu outra há menos que isto. */
export const QUIET_DAYS = 30;
/** O envio manual recusa outro para o mesmo provedor dentro disto. */
export const MANUAL_COOLDOWN_DAYS = 7;
export const COMMENT_MAX = 1000;
/** Tentativas de envio por etapa automática, contando a primeira. */
export const MAX_SEND_ATTEMPTS = 3;
/** Entre uma tentativa e a próxima da mesma etapa: nunca mais de um envio por dia. */
export const RETRY_AFTER_HOURS = 24;
/** O prefixo de `channel` da linha cujo envio não saiu: `failed:<tentativas>`. */
const FALHOU = 'failed:';
export const NPS_STATUSES = Object.freeze(['pending', 'answered', 'expired']);
/** Os sinais de risco de um detrator. */
export const RISK_SIGNALS = Object.freeze(['overdue', 'card_refused', 'cancellation', 'paused']);

const DAY_MS = 24 * 60 * 60 * 1000;
const PASS_INTERVAL_MS = 60 * 60 * 1000;
const COMMENTS_LIMIT = 50;
const TREND_MONTHS = 12;

const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);

/** O sha256 do token, em hex — o que o banco guarda. */
export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw ?? '')).digest('hex');
}

/** Um token novo: 32 bytes aleatórios (256 bits), em base64url. */
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** O token como veio da página: só o alfabeto do base64url, e do tamanho certo. */
function tokenValido(raw) {
  const texto = String(raw ?? '').trim();
  return /^[A-Za-z0-9_-]{32,128}$/.test(texto) ? texto : null;
}

/**
 * A nota numa mensagem de WhatsApp: "8", "nota 8", "8/10", "8 de 10", "10!".
 * Só o número sozinho — "2 boletos" não é nota, é o provedor falando de outra
 * coisa, e a pesquisa sai do caminho.
 */
export function lerNotaNps(texto) {
  const limpo = String(texto ?? '').trim().toLowerCase();
  if (!limpo || limpo.length > 20) return null;
  const m = limpo.match(/^(?:nota\s*:?\s*)?(10|[0-9])(?:\s*(?:\/\s*10|de\s*10|pontos?))?\s*[.!]*$/u);
  return m ? Number(m[1]) : null;
}

/** Promotor (9–10), neutro (7–8) ou detrator (0–6). */
export function npsCategory(score) {
  const n = Number(score);
  if (n >= 9) return 'promoter';
  if (n >= 7) return 'passive';
  return 'detractor';
}

/**
 * A conta do NPS: % de promotores menos % de detratores, inteiro de -100 a
 * 100 — nulo sem nenhuma resposta. `distribution[n]` é quantos deram a nota n.
 */
export function computeNps(scores) {
  const distribution = Array.from({ length: 11 }, () => 0);
  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  for (const bruto of scores) {
    const n = Number(bruto);
    if (!Number.isInteger(n) || n < 0 || n > 10) continue;
    distribution[n] += 1;
    const cat = npsCategory(n);
    if (cat === 'promoter') promoters += 1;
    else if (cat === 'passive') passives += 1;
    else detractors += 1;
  }
  const total = promoters + passives + detractors;
  const nps = total ? Math.round(((promoters - detractors) / total) * 100) : null;
  return { total, promoters, passives, detractors, nps, distribution };
}

/**
 * Os sinais de risco de um provedor, no estado de agora:
 *
 *   overdue       devendo — a assinatura vencida (não a pausa) ou uma
 *                 cobrança em aberto vencida;
 *   card_refused  o cartão salvo foi recusado e está parado;
 *   cancellation  um pedido de cancelamento sem decisão, ou o cancelamento
 *                 agendado;
 *   paused        a pausa de retenção marcada ou correndo.
 */
export function riskSignals({ subscription, openCharges = [], openCancellation = false, now = new Date() }) {
  const sinais = [];
  if (!subscription) return sinais;
  const efetivo = SubscriptionService.effectiveStatus(subscription, now);
  const hoje = ChargeIssuingService.isoDate(now);
  const cobrancaVencida = openCharges.some((c) => c.status === 'overdue'
    || (isoDateOf(c.due_date) && isoDateOf(c.due_date) < hoje));
  if ((efetivo.status === 'past_due' && efetivo.reason !== 'paused') || cobrancaVencida) sinais.push('overdue');
  if (subscription.card_failed_at) sinais.push('card_refused');
  if (openCancellation || isCancelScheduled(subscription)) sinais.push('cancellation');
  if (isPauseScheduled(subscription)) sinais.push('paused');
  return sinais;
}

/** Detrator com qualquer sinal de risco. */
export function isAtRisk(score, signals) {
  return Number(score) <= 6 && Array.isArray(signals) && signals.length > 0;
}

/**
 * O início da assinatura paga, em ms, ou nulo: o primeiro pagamento; sem ele,
 * o fim do teste de quem já está num período pago (`active` com `renews_at`).
 */
export function paidStartOf({ subscription, firstPaymentAt = null }) {
  const pago = instanteMs(firstPaymentAt);
  if (pago !== null) return pago;
  if (!subscription || subscription.status !== 'active' || !subscription.renews_at) return null;
  return instanteMs(subscription.trial_ends_at);
}

/** A etapa automática cuja janela está aberta agora, ou nula. */
export function dueWave({ startMs, now = new Date() }) {
  if (startMs === null || startMs === undefined) return null;
  const dias = (now.getTime() - startMs) / DAY_MS;
  for (const [wave, dia] of Object.entries(WAVE_DAYS)) {
    if (dias >= dia && dias < dia + WAVE_WINDOW_DAYS) return wave;
  }
  return null;
}

/**
 * Se a assinatura recebe pesquisa automática: paga e viva. Teste, isento,
 * cancelado e suspenso não recebem.
 */
export function autoSkipReason(tenant, subscription) {
  if (!tenant || tenant.kind === 'platform') return 'platform';
  if (tenant.status && tenant.status !== 'active') return 'inactive';
  if (!subscription) return 'no_subscription';
  if (subscription.status === 'trial') return 'trial';
  if (subscription.status === 'canceled') return 'canceled';
  if (subscription.status === 'suspended') return 'suspended';
  if (subscription.billing_exempt_at) return 'exempt';
  return null;
}

/** O link da página pública, ou nulo quando o deploy não sabe o próprio endereço. */
export function npsUrlFor(rawToken) {
  if (!rawToken) return null;
  const host = panelBaseDomain() || platformExtraHosts()[0] || null;
  if (host) return `https://${host}/nps#${rawToken}`;
  const publico = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publico)) return null;
  return `${publico}/nps#${rawToken}`;
}

function isoOuNulo(valor) {
  const ms = instanteMs(valor);
  return ms === null ? null : new Date(ms).toISOString();
}

/** Quantas tentativas sem sucesso a linha tem (`failed:<n>`); 0 se saiu por algum canal. */
export function failedAttempts(linha) {
  const canal = String(linha?.channel ?? '');
  if (!canal.startsWith(FALHOU)) return 0;
  const n = Number(canal.slice(FALHOU.length));
  return Number.isInteger(n) && n > 0 ? n : MAX_SEND_ATTEMPTS;
}

/** A pergunta chegou a sair por algum canal. */
function entregue(linha) {
  return Boolean(linha?.channel) && failedAttempts(linha) === 0;
}

function tenantRef(tenant, id) {
  return { id: Number(id), name: tenant?.name ?? null, slug: tenant?.slug ?? null };
}

/** Vencida: pendente há mais de `EXPIRE_DAYS` dias (ou já marcada). */
function vencida(linha, now) {
  if (linha.status === 'expired') return true;
  if (linha.status !== 'pending') return false;
  const ms = instanteMs(linha.asked_at);
  return ms !== null && now.getTime() - ms > EXPIRE_DAYS * DAY_MS;
}

/** O que a página pública vê de uma linha: nada do provedor além do nome do produto. */
function viewPublica(linha, now) {
  const primeira = instanteMs(linha.answered_at);
  const editavelAte = primeira === null ? null : primeira + EDIT_WINDOW_DAYS * DAY_MS;
  return {
    status: linha.status,
    score: linha.score === null || linha.score === undefined ? null : Number(linha.score),
    comment: linha.comment ?? null,
    product: PRODUCT_NAME,
    editableUntil: editavelAte === null ? null : new Date(editavelAte).toISOString(),
    canAnswer: linha.status === 'pending' || (editavelAte !== null && now.getTime() <= editavelAte)
  };
}

/** Lê todas as linhas da pesquisa, de todos os provedores — o console e o agendador. */
async function todasAsLinhas() {
  // tenant-scope-exempt: plano de controle, acima dos provedores (relatório e agendador).
  return runUnscoped('the console and the scheduler read every provider\'s NPS answers', () => getDb()('platform_nps')
    .select('id', 'tenant_id', 'wave', 'channel', 'score', 'comment', 'answer_channel', 'status', 'asked_at', 'answered_at', 'created_by')
    .orderBy('id', 'asc'));
}

/** O provedor de cada pedido de cancelamento ainda sem decisão. */
async function cancelamentosAbertos() {
  // tenant-scope-exempt: plano de controle, acima dos provedores.
  const linhas = await runUnscoped('the NPS risk signal reads every provider\'s open cancellation request', () => getDb()('cancellation_requests')
    .whereNull('outcome')
    .distinct('tenant_id'));
  return new Set(linhas.map((l) => Number(l.tenant_id)));
}

class NpsService {
  /**
   * Os canais, trocáveis pelos testes: `email(to, { subject, text })` e
   * `whatsapp(phone, text)`, cada um devolvendo se saiu.
   */
  static senders = {
    email: (to, { subject, text }) => mailTransport().send({ to, subject, text }).then(Boolean),
    whatsapp: (phone, text) => PlatformNotifyService.sendWhatsapp(phone, text)
  };

  /**
   * Ligado por quem integra o bot do WhatsApp da plataforma (que chama
   * `tryCaptureWhatsappReply`): só então a pergunta convida a responder com o
   * número na conversa. Desligado, ela manda só o link.
   */
  static whatsappReplyEnabled = false;

  static lastPassAt = 0;

  /**
   * Manda a pesquisa `wave` a `tenant`. A linha nasce antes do envio (o índice
   * único é a trava da etapa automática) e é apagada se nada sai.
   *
   * @returns {Promise<{ sent: boolean, reason?: string, id?: number, channels?: string[] }>}
   */
  static async ask(tenant, { wave, now = new Date(), createdBy = null } = {}) {
    if (!NPS_WAVES.includes(wave)) throw new Error(`Unknown NPS wave: ${wave}`);
    if (!tenant || tenant.kind === 'platform') return { sent: false, reason: 'platform' };
    const token = newToken();
    const link = npsUrlFor(token);
    if (!link) return { sent: false, reason: 'no_link' };
    const para = await SubscriptionNoticeService.recipients(tenant).catch(() => []);
    const fone = String(tenant.billing_phone ?? '').trim();
    if (!para.length && !fone) return { sent: false, reason: 'no_destination' };

    let id;
    try {
      id = await runInTenant(tenant.id, () => tinsertReturningId('platform_nps', {
        wave,
        wave_key: wave === 'manual' ? null : wave,
        token_hash: hashToken(token),
        status: 'pending',
        asked_at: aoSegundo(now.getTime()),
        created_by: createdBy,
        created_at: aoSegundo(now.getTime())
      }));
    } catch (error) {
      if (isUniqueViolation(error)) return { sent: false, reason: 'already_sent' };
      throw error;
    }

    const channels = await this.deliver(tenant, { link, para, fone });
    await runInTenant(tenant.id, async () => {
      if (channels.length) {
        await tdb('platform_nps').where({ id }).update({ channel: channels.join(',') });
      } else if (wave === 'manual') {
        // A manual que não saiu some: quem clicou vê a falha e tenta de novo.
        await tdb('platform_nps').where({ id }).del();
      } else {
        // A automática fica, marcada: a próxima tentativa só daqui a um dia.
        await tdb('platform_nps').where({ id }).update({ channel: `${FALHOU}1` });
      }
    });
    if (!channels.length) return { sent: false, reason: 'send_failed' };
    return { sent: true, id, channels };
  }

  /** Manda a pergunta por e-mail e WhatsApp; devolve os canais que saíram. Não lança. */
  static async deliver(tenant, { link, para, fone }) {
    const vars = { provider: tenant.name || tenant.slug || '', product: PRODUCT_NAME, link };
    const subject = translate(DEFAULT_LOCALE, 'nps.askSubject', vars);
    const text = translate(DEFAULT_LOCALE, 'nps.askBody', vars);
    const channels = [];
    const enviados = await Promise.all(para.map((to) => Promise.resolve()
      .then(() => this.senders.email(to, { subject, text }))
      .catch(() => false)));
    if (enviados.some(Boolean)) channels.push('email');
    if (fone) {
      const extra = this.whatsappReplyEnabled ? `\n\n${translate(DEFAULT_LOCALE, 'nps.askWhatsappHint', vars)}` : '';
      const foi = await Promise.resolve()
        .then(() => this.senders.whatsapp(fone, `*${subject}*\n\n${text}${extra}`))
        .catch(() => false);
      if (foi) channels.push('whatsapp');
    }
    return channels;
  }

  /**
   * A nova tentativa da etapa automática cujo envio não saiu (`failed:<n>`):
   * a mesma linha, com um token novo (o velho nunca chegou a ninguém) e o
   * `asked_at` de agora. Condicional ao `channel` lido — de duas passadas, uma
   * tenta. Só depois de `RETRY_AFTER_HOURS` horas da anterior, e até
   * `MAX_SEND_ATTEMPTS` no total.
   *
   * @returns {Promise<{ sent: boolean, reason?: string, id?: number, channels?: string[] }>}
   */
  static async retry(tenant, linha, { now = new Date() } = {}) {
    const feitas = failedAttempts(linha);
    if (!feitas) return { sent: false, reason: 'already_sent' };
    if (feitas >= MAX_SEND_ATTEMPTS) return { sent: false, reason: 'gave_up' };
    const ultima = instanteMs(linha.asked_at);
    if (ultima !== null && now.getTime() - ultima < RETRY_AFTER_HOURS * 60 * 60 * 1000) {
      return { sent: false, reason: 'too_soon' };
    }
    const token = newToken();
    const link = npsUrlFor(token);
    if (!link) return { sent: false, reason: 'no_link' };
    const para = await SubscriptionNoticeService.recipients(tenant).catch(() => []);
    const fone = String(tenant.billing_phone ?? '').trim();
    if (!para.length && !fone) return { sent: false, reason: 'no_destination' };
    const tentativa = `${FALHOU}${feitas + 1}`;
    const minha = await runInTenant(tenant.id, () => tdb('platform_nps')
      .where({ id: linha.id, status: 'pending', channel: linha.channel })
      .update({ token_hash: hashToken(token), asked_at: aoSegundo(now.getTime()), channel: tentativa }));
    if (!Number(minha)) return { sent: false, reason: 'busy' };
    const channels = await this.deliver(tenant, { link, para, fone });
    if (channels.length) {
      await runInTenant(tenant.id, () => tdb('platform_nps').where({ id: linha.id }).update({ channel: channels.join(',') }));
      return { sent: true, id: Number(linha.id), channels };
    }
    return { sent: false, reason: 'send_failed' };
  }

  /** As pendentes há mais de `EXPIRE_DAYS` dias viram `expired`. Devolve quantas. */
  static async expireStale({ now = new Date() } = {}) {
    const linhas = await todasAsLinhas();
    const ids = linhas.filter((l) => l.status === 'pending' && vencida(l, now)).map((l) => l.id);
    if (!ids.length) return 0;
    // tenant-scope-exempt: o agendador vence pesquisas de todos os provedores; os ids vêm da leitura acima.
    return runUnscoped('the scheduler expires every provider\'s stale NPS survey', () => getDb()('platform_nps')
      .whereIn('id', ids)
      .where({ status: 'pending' })
      .update({ status: 'expired' }));
  }

  /**
   * O passo do agendador: vence as antigas e manda as etapas devidas. No
   * máximo uma vez por hora (`force` passa por cima, para os testes). Nunca
   * lança — cada provedor que falha fica no log e o resto segue.
   */
  static async schedulerPass({ now = new Date(), force = false } = {}) {
    const resultado = { expired: 0, sent: [], skipped: 0 };
    if (!force && Date.now() - this.lastPassAt < PASS_INTERVAL_MS) return resultado;
    this.lastPassAt = Date.now();
    try {
      resultado.expired = await this.expireStale({ now });
      const [tenants, subs, linhas, pagamentos] = await Promise.all([
        Tenant.list(),
        Subscription.listWithPlans(),
        todasAsLinhas(),
        // tenant-scope-exempt: o primeiro pagamento de cada provedor, para o agendador do plano de controle.
        runUnscoped('the NPS scheduler reads every provider\'s first payment', () => getDb()('billing_events')
          .where({ type: BILLING_EVENT_TYPES.PAYMENT_RECORDED })
          .where('amount_cents', '>', 0)
          .select('tenant_id', 'created_at'))
      ]);
      const assinaturas = new Map(subs.map((s) => [Number(s.tenant_id), s]));
      const primeiro = new Map();
      for (const p of pagamentos) {
        const ms = instanteMs(p.created_at);
        const id = Number(p.tenant_id);
        if (ms !== null && (!primeiro.has(id) || ms < primeiro.get(id))) primeiro.set(id, ms);
      }
      const porProvedor = new Map();
      for (const l of linhas) {
        const id = Number(l.tenant_id);
        if (!porProvedor.has(id)) porProvedor.set(id, []);
        porProvedor.get(id).push(l);
      }
      for (const tenant of tenants) {
        const id = Number(tenant.id);
        const sub = assinaturas.get(id) ?? null;
        if (autoSkipReason(tenant, sub)) { resultado.skipped += 1; continue; }
        const wave = dueWave({ startMs: paidStartOf({ subscription: sub, firstPaymentAt: primeiro.get(id) ?? null }), now });
        if (!wave) continue;
        const dele = porProvedor.get(id) ?? [];
        const daEtapa = dele.find((l) => l.wave === wave) ?? null;
        // A etapa já saiu, ou desistiu: nada. A que falhou tenta de novo (`retry`).
        if (daEtapa && (daEtapa.status !== 'pending' || !failedAttempts(daEtapa))) continue;
        const recente = dele.some((l) => {
          if (l === daEtapa || !entregue(l)) return false;
          const ms = instanteMs(l.asked_at);
          return ms !== null && now.getTime() - ms < QUIET_DAYS * DAY_MS;
        });
        if (recente) { resultado.skipped += 1; continue; }
        try {
          // eslint-disable-next-line no-await-in-loop -- um provedor por vez: SMTP e WhatsApp
          const feito = daEtapa ? await this.retry(tenant, daEtapa, { now }) : await this.ask(tenant, { wave, now });
          if (feito.sent) resultado.sent.push({ tenantId: id, wave });
        } catch (error) {
          log.warn('nps survey not sent', { err: error, tenantId: id, wave });
        }
      }
    } catch (error) {
      log.warn('nps scheduler pass failed', { err: error });
    }
    return resultado;
  }

  /** A linha de um token, ou nula. A busca é pelo hash, acima dos provedores. */
  static async findByToken(raw) {
    const token = tokenValido(raw);
    if (!token) return null;
    // tenant-scope-exempt: quem chega pelo link não tem provedor em escopo; o token é a credencial, conferido pelo hash.
    return (await runUnscoped('the public NPS page finds the survey by its token hash', () => getDb()('platform_nps')
      .where({ token_hash: hashToken(token) })
      .first())) || null;
  }

  /**
   * O que a página pública mostra.
   * @returns {Promise<{ view?: object, error?: 'not_found'|'expired' }>}
   */
  static async lookup(raw, { now = new Date() } = {}) {
    const linha = await this.findByToken(raw);
    if (!linha) return { error: 'not_found' };
    if (vencida(linha, now)) return { error: 'expired' };
    return { view: viewPublica(linha, now) };
  }

  /**
   * Grava a resposta pelo link. A primeira vale sempre (pendente e no prazo);
   * a seguinte só muda a nota dentro de `EDIT_WINDOW_DAYS` da primeira.
   *
   * @returns {Promise<{ view?: object, error?: 'not_found'|'expired'|'invalid_score'|'already_answered' }>}
   */
  static async answer(raw, { score, comment = null, now = new Date(), channel = 'link' } = {}) {
    const nota = Number(score);
    if (score === null || score === undefined || score === '' || !Number.isInteger(nota) || nota < 0 || nota > 10) {
      return { error: 'invalid_score' };
    }
    const linha = await this.findByToken(raw);
    if (!linha) return { error: 'not_found' };
    if (vencida(linha, now)) return { error: 'expired' };
    const texto = comment === null || comment === undefined ? '' : String(comment).trim().slice(0, COMMENT_MAX);
    const quando = aoSegundo(now.getTime());

    const mudou = await runInTenant(linha.tenant_id, async () => {
      if (linha.status === 'pending') {
        const n = await tdb('platform_nps').where({ id: linha.id, status: 'pending' }).update({
          status: 'answered', score: nota, comment: texto || null, answered_at: quando, answer_channel: channel
        });
        if (n) return true;
      }
      // Já respondida (agora ou numa corrida): só dentro do prazo da primeira.
      const atual = await tdb('platform_nps').where({ id: linha.id }).first();
      const primeira = instanteMs(atual?.answered_at);
      if (!atual || atual.status !== 'answered' || primeira === null
        || now.getTime() > primeira + EDIT_WINDOW_DAYS * DAY_MS) return false;
      await tdb('platform_nps').where({ id: linha.id, status: 'answered' }).update({
        score: nota, comment: texto || null, answer_channel: channel
      });
      return true;
    });
    if (!mudou) return { error: 'already_answered' };
    const depois = await this.findByToken(raw);
    return { view: viewPublica(depois, now) };
  }

  /**
   * A porta do bot do WhatsApp da plataforma (`PlatformOwnerBotService`).
   *
   * Chame com o provedor já identificado pelo telefone e o texto da mensagem
   * que ele mandou. Se há uma pesquisa pendente (e no prazo) para ele e o
   * texto é só uma nota de 0 a 10 ("8", "nota 8", "8/10"), a nota é gravada
   * (`answer_channel = 'whatsapp'`) e a resposta diz o agradecimento a mandar
   * de volta. Qualquer outra coisa devolve `captured: false` e a mensagem
   * segue o fluxo normal do bot. Nunca lança.
   *
   * @param {{ tenantId: number, text: string, now?: Date }} entrada
   * @returns {Promise<{ captured: boolean, score?: number, reply?: string }>}
   */
  static async tryCaptureWhatsappReply({ tenantId, text, now = new Date() } = {}) {
    const nada = { captured: false };
    try {
      const id = Number(tenantId);
      if (!Number.isInteger(id) || id <= 0) return nada;
      const nota = lerNotaNps(text);
      if (nota === null) return nada;
      return await runInTenant(id, async () => {
        const linha = (await tdb('platform_nps').where({ status: 'pending' }).orderBy('id', 'desc'))
          .find(entregue);
        if (!linha || vencida(linha, now)) return nada;
        const n = await tdb('platform_nps').where({ id: linha.id, status: 'pending' }).update({
          status: 'answered', score: nota, answered_at: aoSegundo(now.getTime()), answer_channel: 'whatsapp'
        });
        if (!n) return nada;
        return { captured: true, score: nota, reply: translate(DEFAULT_LOCALE, 'nps.whatsappThanks', { score: nota }) };
      });
    } catch (error) {
      log.warn('nps whatsapp reply not handled', { err: error });
      return nada;
    }
  }

  /**
   * A nota pelo WhatsApp da plataforma, pelo TELEFONE — o gancho numérico do
   * `PlatformOwnerBotService` (registrado em `npsWhatsappReply.js`).
   *
   * O telefone não autentica; ele só pode responder a pergunta que foi feita a
   * ELE. Por isso só conta a pesquisa que:
   *
   *   - está pendente e no prazo;
   *   - saiu pelo WhatsApp (`channel` com `whatsapp`) — a mandada só por
   *     e-mail não foi feita a este número;
   *   - é de um provedor cujo `billing_phone` é este número (em qualquer das
   *     grafias). O telefone de um dono (`users.phone`) nomeia o provedor para
   *     o bot, mas não recebeu a pergunta.
   *
   * E só reclama quando EXATAMENTE um provedor passa: com dois (o mesmo
   * telefone de cobrança em dois provedores), não há como saber de qual é a
   * nota, e o número segue o fluxo do bot. Nunca lança.
   *
   * @param {{ tenantIds: number[], phone: string, text: string, now?: Date }} entrada
   * @returns {Promise<{ captured: boolean, tenantId?: number, score?: number, reply?: string }>}
   */
  static async captureForPhone({ tenantIds = [], phone = null, text = '', now = new Date() } = {}) {
    const nada = { captured: false };
    try {
      const nota = lerNotaNps(text);
      if (nota === null) return nada;
      const minhas = new Set(variantesTelefoneBr(phone));
      if (!minhas.size) return nada;
      const ids = [...new Set((tenantIds ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      const qualificadas = [];
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop -- são os poucos provedores de um telefone
        const tenant = await Tenant.findById(id);
        if (!tenant || tenant.kind === 'platform') continue;
        if (!variantesTelefoneBr(tenant.billing_phone).some((g) => minhas.has(g))) continue;
        // eslint-disable-next-line no-await-in-loop
        const linha = await runInTenant(id, async () => (await tdb('platform_nps')
          .where({ status: 'pending' })
          .orderBy('id', 'desc'))
          .find((l) => String(l.channel ?? '').split(',').includes('whatsapp') && !vencida(l, now)));
        if (linha) qualificadas.push({ tenantId: id, linha });
      }
      if (qualificadas.length !== 1) return nada;
      const [{ tenantId, linha }] = qualificadas;
      const n = await runInTenant(tenantId, () => tdb('platform_nps').where({ id: linha.id, status: 'pending' }).update({
        status: 'answered', score: nota, answered_at: aoSegundo(now.getTime()), answer_channel: 'whatsapp'
      }));
      if (!Number(n)) return nada;
      return {
        captured: true, tenantId, score: nota, reply: translate(DEFAULT_LOCALE, 'nps.whatsappThanks', { score: nota })
      };
    } catch (error) {
      log.warn('nps whatsapp reply not handled', { err: error });
      return nada;
    }
  }

  /**
   * O envio manual do console. Recusa (`recent`) quando já há uma manual
   * pendente mandada há menos de `MANUAL_COOLDOWN_DAYS` dias.
   */
  static async sendManual(tenant, { now = new Date(), userId = null } = {}) {
    const recente = await runInTenant(tenant.id, () => tdb('platform_nps')
      .where({ wave: 'manual', status: 'pending' })
      .orderBy('id', 'desc')
      .first());
    const ms = instanteMs(recente?.asked_at);
    if (ms !== null && now.getTime() - ms < MANUAL_COOLDOWN_DAYS * DAY_MS) return { sent: false, reason: 'recent' };
    return this.ask(tenant, { wave: 'manual', now, createdBy: userId });
  }

  /**
   * Os detratores — a ÚLTIMA resposta de cada provedor, se ela é ≤ 6 — com os
   * sinais de risco de agora. Provedor cancelado (ou apagado) fica de fora:
   * não há mais quem reter.
   */
  static async detractors({ now = new Date(), linhas = null, tenants = null } = {}) {
    const [todas, provedores, subs, abertas, cancelamentos] = await Promise.all([
      linhas ?? todasAsLinhas(),
      tenants ?? Tenant.list(),
      Subscription.listWithPlans(),
      BillingCharge.openAcrossTenants(),
      cancelamentosAbertos()
    ]);
    const porId = new Map(provedores.map((t) => [Number(t.id), t]));
    const assinaturas = new Map(subs.map((s) => [Number(s.tenant_id), s]));
    const cobrancas = new Map();
    for (const c of abertas) {
      const id = Number(c.tenant_id);
      if (!cobrancas.has(id)) cobrancas.set(id, []);
      cobrancas.get(id).push(c);
    }
    const ultima = new Map();
    for (const l of todas) {
      if (l.status !== 'answered' || l.score === null || l.score === undefined) continue;
      const id = Number(l.tenant_id);
      const ms = instanteMs(l.answered_at) ?? 0;
      const antes = ultima.get(id);
      if (!antes || ms > antes.ms || (ms === antes.ms && l.id > antes.linha.id)) ultima.set(id, { linha: l, ms });
    }
    const lista = [];
    for (const [id, { linha, ms }] of ultima) {
      if (Number(linha.score) > 6) continue;
      const tenant = porId.get(id);
      const sub = assinaturas.get(id) ?? null;
      if (!tenant || !sub || sub.status === 'canceled') continue;
      const signals = riskSignals({
        subscription: sub, openCharges: cobrancas.get(id) ?? [], openCancellation: cancelamentos.has(id), now
      });
      lista.push({
        tenant: tenantRef(tenant, id),
        score: Number(linha.score),
        comment: linha.comment ?? null,
        answeredAt: new Date(ms).toISOString(),
        wave: linha.wave,
        signals,
        atRisk: isAtRisk(linha.score, signals)
      });
    }
    lista.sort((a, b) => (Number(b.atRisk) - Number(a.atRisk)) || b.answeredAt.localeCompare(a.answeredAt));
    return lista;
  }

  /** O card da aba Início: quantos detratores, e quantos com sinal de risco. */
  static async riskSummary({ now = new Date() } = {}) {
    const lista = await this.detractors({ now });
    return { detractors: lista.length, atRisk: lista.filter((d) => d.atRisk).length };
  }

  /**
   * O relatório do console (seção "Satisfação" da aba Receita), desde `from`
   * (YYYY-MM-DD, meia-noite de Brasília) — sem ele, tudo.
   */
  static async report({ from = null, now = new Date() } = {}) {
    const desde = from ? instanteMs(`${from}T00:00:00-03:00`) : null;
    const [linhas, tenants] = await Promise.all([todasAsLinhas(), Tenant.list()]);
    const porId = new Map(tenants.map((t) => [Number(t.id), t]));
    const noPeriodo = (valor) => {
      const ms = instanteMs(valor);
      return ms !== null && (desde === null || ms >= desde);
    };
    const respondidas = linhas.filter((l) => l.status === 'answered' && l.score !== null && noPeriodo(l.answered_at));
    // A que não saiu por canal nenhum (`failed:<n>`) não foi pergunta feita.
    const enviadas = linhas.filter((l) => entregue(l) && noPeriodo(l.asked_at));
    const resumo = computeNps(respondidas.map((l) => l.score));

    const trend = mesesAte(now, TREND_MONTHS).map((mes) => {
      const doMes = linhas.filter((l) => {
        if (l.status !== 'answered' || l.score === null) return false;
        const ms = instanteMs(l.answered_at);
        return ms !== null && ms >= mes.startMs && ms < mes.endMs;
      });
      const c = computeNps(doMes.map((l) => l.score));
      return {
        month: mes.month, responses: c.total, nps: c.nps, promoters: c.promoters, passives: c.passives, detractors: c.detractors
      };
    });

    const comments = respondidas
      .filter((l) => String(l.comment ?? '').trim())
      .sort((a, b) => (instanteMs(b.answered_at) ?? 0) - (instanteMs(a.answered_at) ?? 0) || b.id - a.id)
      .slice(0, COMMENTS_LIMIT)
      .map((l) => ({
        id: l.id,
        tenant: tenantRef(porId.get(Number(l.tenant_id)), l.tenant_id),
        score: Number(l.score),
        comment: l.comment,
        wave: l.wave,
        answeredAt: isoOuNulo(l.answered_at)
      }));

    const detractors = await this.detractors({ now, linhas, tenants });

    const ultimaPergunta = new Map();
    for (const l of linhas) {
      if (!entregue(l)) continue;
      const ms = instanteMs(l.asked_at);
      const id = Number(l.tenant_id);
      if (ms !== null && (!ultimaPergunta.has(id) || ms > ultimaPergunta.get(id))) ultimaPergunta.set(id, ms);
    }
    const providers = tenants.map((t) => ({
      ...tenantRef(t, t.id),
      lastAskedAt: ultimaPergunta.has(Number(t.id)) ? new Date(ultimaPergunta.get(Number(t.id))).toISOString() : null
    }));

    return {
      from: from ?? null,
      summary: {
        ...resumo,
        sent: enviadas.length,
        answered: respondidas.length,
        responseRate: enviadas.length ? Math.round((enviadas.filter((l) => l.status === 'answered').length / enviadas.length) * 10000) / 10000 : null
      },
      trend,
      comments,
      detractors,
      atRisk: detractors.filter((d) => d.atRisk).length,
      providers
    };
  }
}

export default NpsService;
