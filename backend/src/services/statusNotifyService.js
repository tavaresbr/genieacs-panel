import { getDb, isUniqueViolation } from '../config/database.js';
import { DEFAULT_LOCALE } from '../i18n/config.js';
import { translate } from '../i18n/index.js';
import Tenant from '../models/Tenant.js';
import { PRODUCT_NAME } from '../config/brand.js';
import { panelBaseDomain, platformExtraHosts } from '../middleware/tenantResolver.js';
import { log } from '../utils/logger.js';
import { instanteMs, parseComponents } from './statusService.js';

/**
 * O aviso aos provedores sobre a página de status (0126): por e-mail e
 * WhatsApp, só nos incidentes com `notify_providers` ligado.
 *
 * Os eventos:
 *
 *   - `opened`: o incidente aberto, enquanto não for resolvido;
 *   - `maintenance`: a manutenção agendada, nas 24 horas antes do início (a
 *     agendada em cima da hora avisa na hora), e só enquanto ela não acabou;
 *   - `resolved`: o fim — e SÓ para quem ouviu o começo (a marca `opened` ou
 *     `maintenance` feita com algum canal). Quem não soube do problema não
 *     precisa saber que acabou, e um incidente de um minuto resolvido antes da
 *     passada não manda nada a ninguém.
 *
 * ## Uma vez por evento
 *
 * Uma linha em `status_notification_marks` por (incidente, provedor, evento),
 * nascida ANTES do envio: o índice único é a garra, como em
 * `plan_price_change_marks`. A passada repetida, dois processos e a reentrega
 * dão no mesmo aviso, que sai uma vez. Se nada sai (SMTP fora, WhatsApp
 * desconectado), a marca fica `failed` e volta a ser tentada depois de
 * `RETRY_MS`, até `MAX_ATTEMPTS`; quem não tem destino nenhum fica marcado
 * `no_recipient` e não é tentado de novo.
 */

export const NOTICE_EVENTS = Object.freeze(['opened', 'maintenance', 'resolved']);
/** A antecedência do aviso de manutenção. */
export const MAINTENANCE_NOTICE_MS = 24 * 60 * 60 * 1000;
const CLAIM_MS = 5 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** Até quanto tempo depois de resolvido o incidente ainda é revisitado pela passada. */
const REVISIT_MS = 3 * 24 * 60 * 60 * 1000;
/** Quantos envios uma passada faz no máximo: o resto fica para a próxima volta. */
const PASS_BUDGET = 200;

const aoSegundo = (d) => new Date(Math.floor(d.getTime() / 1000) * 1000);

/** O endereço da página pública, ou nulo quando o deploy não sabe o próprio. */
export function statusPageUrl() {
  const host = panelBaseDomain() || platformExtraHosts()[0] || null;
  if (host) return `https://${host}/status`;
  const publico = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(publico) ? `${publico}/status` : null;
}

/** Data e hora em Brasília, como o provedor lê. */
function quandoSp(valor) {
  const ms = instanteMs(valor);
  if (ms === null) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(ms));
}

/**
 * Qual evento o incidente pede agora, ou nulo. O `resolved` não é decidido
 * aqui: ele depende de quem ouviu o começo.
 */
export function startEventFor(incident, now = new Date()) {
  if (incident.status === 'resolved') return null;
  if (incident.kind === 'maintenance') {
    const inicio = instanteMs(incident.starts_at);
    const fim = instanteMs(incident.ends_at);
    if (inicio === null) return null;
    if (fim !== null && fim <= now.getTime()) return null;
    return now.getTime() >= inicio - MAINTENANCE_NOTICE_MS ? 'maintenance' : null;
  }
  return 'opened';
}

class StatusNotifyService {
  /** Os canais, trocáveis nos testes. Cada um devolve `true` se saiu e nunca lança. */
  static senders = {
    email: async (to, { subject, text }) => {
      const { mailTransport } = await import('./mail/index.js');
      const transporte = mailTransport();
      if (transporte.name === 'none') return false;
      return Boolean(await transporte.send({ to, subject, text }));
    },
    whatsapp: async (phone, text) => {
      const { default: PlatformNotifyService } = await import('./platformNotifyService.js');
      return PlatformNotifyService.sendWhatsapp(phone, text);
    }
  };

  // ── As marcas ────────────────────────────────────────────────────────

  /** Toma a marca para esta passada; `false` se já foi feita, está com outra ou esgotou. */
  static async claim({ incidentId, tenantId, event, now }) {
    const db = getDb();
    const ate = aoSegundo(new Date(now.getTime() + CLAIM_MS));
    try {
      await db('status_notification_marks').insert({
        incident_id: incidentId, tenant_id: tenantId, event, status: 'claimed', claimed_until: ate, attempts: 0,
        created_at: aoSegundo(now)
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existente = await db('status_notification_marks')
        .where({ incident_id: incidentId, tenant_id: tenantId, event }).first();
      if (!existente || existente.status === 'done') return false;
      if (Number(existente.attempts ?? 0) >= MAX_ATTEMPTS) return false;
      const n = await db('status_notification_marks')
        .where({ id: existente.id })
        .whereNot({ status: 'done' })
        .where((q) => q.whereNull('claimed_until').orWhere('claimed_until', '<=', now))
        .update({ status: 'claimed', claimed_until: ate });
      return Number(n) > 0;
    }
  }

  static async finish({ incidentId, tenantId, event, detail, now }) {
    await getDb()('status_notification_marks')
      .where({ incident_id: incidentId, tenant_id: tenantId, event })
      .update({ status: 'done', done_at: aoSegundo(now), claimed_until: null, detail: String(detail ?? '').slice(0, 255) || null });
  }

  static async fail({ incidentId, tenantId, event, detail, now }) {
    const db = getDb();
    await db('status_notification_marks')
      .where({ incident_id: incidentId, tenant_id: tenantId, event })
      .update({
        status: 'failed',
        claimed_until: aoSegundo(new Date(now.getTime() + RETRY_MS)),
        attempts: db.raw('attempts + 1'),
        detail: String(detail ?? '').slice(0, 255) || null
      });
  }

  // ── A mensagem ───────────────────────────────────────────────────────

  /** O assunto e o texto do evento, em português (a língua da cobrança). */
  static compose(incident, event, tenant, lastMessage = '') {
    const componentes = parseComponents(incident.components)
      .map((c) => translate(DEFAULT_LOCALE, `status.component.${c}`))
      .join(', ');
    const link = statusPageUrl();
    const vars = {
      product: PRODUCT_NAME,
      provider: tenant.name || tenant.slug || '',
      title: incident.title,
      components: componentes,
      start: quandoSp(incident.starts_at),
      end: quandoSp(incident.ends_at),
      message: String(lastMessage || '').trim()
    };
    const chave = event === 'resolved'
      ? (incident.kind === 'maintenance' ? 'maintenanceDone' : 'resolved')
      : event;
    const subject = translate(DEFAULT_LOCALE, `status.notice.${chave}Subject`, vars);
    let text = translate(DEFAULT_LOCALE, `status.notice.${chave}Body`, vars);
    if (vars.message) text += `\n\n${vars.message}`;
    if (link) text += `\n\n${translate(DEFAULT_LOCALE, 'status.notice.follow', { link })}`;
    return { subject, text };
  }

  /** Manda a um provedor: `{ sent, channels?, reason? }`. Não lança. */
  static async deliverTo(tenant, mensagem) {
    const { default: SubscriptionNoticeService } = await import('./subscriptionNoticeService.js');
    const para = await SubscriptionNoticeService.recipients(tenant).catch(() => []);
    const fone = String(tenant.billing_phone ?? '').trim();
    if (!para.length && !fone) return { sent: false, reason: 'no_recipient' };
    const canais = [];
    const emails = await Promise.all(para.map((to) => Promise.resolve()
      .then(() => this.senders.email(to, mensagem))
      .catch(() => false)));
    if (emails.some(Boolean)) canais.push('email');
    if (fone) {
      const zap = await Promise.resolve()
        .then(() => this.senders.whatsapp(fone, `*${mensagem.subject}*\n\n${mensagem.text}`))
        .catch(() => false);
      if (zap) canais.push('whatsapp');
    }
    return canais.length ? { sent: true, channels: canais } : { sent: false, reason: 'send_failed' };
  }

  // ── A passada ────────────────────────────────────────────────────────

  /** Os provedores que recebem aviso: clientes ativos (nunca a caixa da plataforma). */
  static async audience() {
    const lista = await Tenant.list();
    return lista.filter((t) => t.kind !== 'platform' && t.status === 'active');
  }

  /**
   * Um passo de cada incidente com aviso ligado. Nunca lança; devolve quantos
   * saíram, falharam e ficaram sem destino.
   */
  static async processDue({ now = new Date() } = {}) {
    const resumo = { sent: 0, failed: 0, skipped: 0 };
    try {
      const db = getDb();
      const candidatos = await db('status_incidents')
        .where({ notify_providers: true })
        .where((q) => q.whereNull('resolved_at').orWhere('resolved_at', '>=', new Date(now.getTime() - REVISIT_MS)))
        .orderBy('id', 'asc')
        .limit(50);
      if (!candidatos.length) return resumo;
      let publico = null;
      let orcamento = PASS_BUDGET;
      for (const incidente of candidatos) {
        if (orcamento <= 0) break;
        const inicio = startEventFor(incidente, now);
        let alvos;
        let evento;
        if (inicio) {
          evento = inicio;
          // eslint-disable-next-line no-await-in-loop -- uma vez por passada
          publico = publico ?? await this.audience();
          alvos = publico;
        } else if (incidente.status === 'resolved') {
          evento = 'resolved';
          // eslint-disable-next-line no-await-in-loop
          const avisados = await db('status_notification_marks')
            .where({ incident_id: incidente.id, status: 'done' })
            .whereIn('event', ['opened', 'maintenance'])
            .whereNotIn('detail', ['no_recipient'])
            .select('tenant_id');
          if (!avisados.length) continue;
          // eslint-disable-next-line no-await-in-loop
          publico = publico ?? await this.audience();
          const ids = new Set(avisados.map((m) => Number(m.tenant_id)));
          alvos = publico.filter((t) => ids.has(Number(t.id)));
        } else {
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const ultima = await db('status_incident_updates')
          .where({ incident_id: incidente.id })
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .first('message');
        for (const tenant of alvos) {
          if (orcamento <= 0) break;
          const marca = { incidentId: incidente.id, tenantId: Number(tenant.id), event: evento, now };
          // eslint-disable-next-line no-await-in-loop -- um provedor por vez: SMTP e WhatsApp não aguentam rajada
          if (!(await this.claim(marca))) continue;
          orcamento -= 1;
          try {
            const mensagem = this.compose(incidente, evento, tenant, ultima?.message);
            // eslint-disable-next-line no-await-in-loop
            const r = await this.deliverTo(tenant, mensagem);
            if (r.sent) {
              // eslint-disable-next-line no-await-in-loop
              await this.finish({ ...marca, detail: r.channels.join(',') });
              resumo.sent += 1;
            } else if (r.reason === 'no_recipient') {
              // eslint-disable-next-line no-await-in-loop
              await this.finish({ ...marca, detail: 'no_recipient' });
              resumo.skipped += 1;
            } else {
              // eslint-disable-next-line no-await-in-loop
              await this.fail({ ...marca, detail: r.reason });
              resumo.failed += 1;
            }
          } catch (error) {
            log.warn('status notice failed', { incidentId: incidente.id, err: error });
            // eslint-disable-next-line no-await-in-loop
            await this.fail({ ...marca, detail: 'error' }).catch(() => {});
            resumo.failed += 1;
          }
        }
      }
    } catch (error) {
      log.warn('status notice pass failed', { err: error });
      resumo.error = error.message;
    }
    return resumo;
  }
}

export default StatusNotifyService;
