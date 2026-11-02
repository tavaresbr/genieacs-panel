import { getDb } from '../config/database.js';
import { runInTenant, runUnscoped } from '../config/tenantContext.js';
import { DEFAULT_LOCALE } from '../i18n/config.js';
import { translate, TranslatableError } from '../i18n/index.js';
import Plan from '../models/Plan.js';
import Coupon from '../models/Coupon.js';
import Tenant from '../models/Tenant.js';
import AuditLog from '../models/AuditLog.js';
import PlatformAudit from '../models/PlatformAudit.js';
import PlanPriceChange, { PRICE_CHANGE_CYCLES, priceColumnOf } from '../models/PlanPriceChange.js';
import { OPEN_CHARGE_STATUSES } from '../models/BillingCharge.js';
import SubscriptionService, { isBillableStatus, isCancelScheduled, annualAvailable } from './subscriptionService.js';
import ChargeIssuingService from './chargeIssuingService.js';
import SelfBillingService from './selfBillingService.js';
import SubscriptionNoticeService from './subscriptionNoticeService.js';
import { mailTransport } from './mail/index.js';
import { PRODUCT_NAME } from '../config/brand.js';
import { log } from '../utils/logger.js';

/**
 * O reajuste de preço de um plano com data de vigência (0122).
 *
 * Até aqui o preço mudava direto no catálogo, e mudava para todo mundo na
 * hora: a próxima cobrança ainda não emitida já saía pelo valor novo, a já
 * emitida ficava com o velho, e ninguém avisava o provedor. O reajuste
 * agendado separa as três coisas:
 *
 *   1. **O preço** de cada cobrança é o do VENCIMENTO dela: antes da data, o
 *      de sempre; da data em diante, o novo (`PlanPriceChange.planAt`, lido
 *      pela emissão e pela reprecificação). Sem tabela por assinante: o
 *      vencimento decide.
 *   2. **O aviso** sai `notice_days` antes da data, por e-mail e WhatsApp, uma
 *      vez por provedor e por reajuste (`plan_price_change_marks`, `notice`).
 *   3. **A cobrança já emitida** com o preço velho que vence na vigência é
 *      cancelada no gateway e reemitida com o novo, uma vez por cobrança e por
 *      reajuste (`reprice:<id>`) — a de valor mudado à mão pelo console e a de
 *      quem está isento não são tocadas. Cancelado o reajuste, a que foi
 *      reemitida volta ao preço de antes (`revert:<id>`).
 *
 * Na data, o preço novo é gravado no plano (`applied`), e a partir daí o
 * catálogo diz o preço novo para todo mundo.
 *
 * Quem roda os passos é o agendador da plataforma (`schedulerPass`), fora do
 * laço por provedor; cada provedor é tocado dentro do próprio escopo.
 */

export const DEFAULT_NOTICE_DAYS = 30;
export const MIN_NOTICE_DAYS = 1;
export const MAX_NOTICE_DAYS = 365;
/** Até quanto tempo à frente se agenda: dois anos. */
const MAX_AHEAD_DAYS = 730;
const DIA = 86_400_000;
/** A garra de uma marca enquanto a passada manda o aviso ou fala com o gateway. */
const CLAIM_MS = 5 * 60 * 1000;
/** A espera depois de uma falha (gateway fora, nenhum canal saiu). */
const RETRY_MS = 15 * 60 * 1000;
/** Quanto tempo depois de aplicado (ou cancelado) a passada ainda revisita o reajuste. */
const REVISIT_DAYS = 31;

export class PlanPriceChangeError extends TranslatableError {
  constructor(key, { code, status = 400, vars = null } = {}) {
    super(key, vars, { code, status });
    this.name = 'PlanPriceChangeError';
  }
}

/** `YYYY-MM-DD` + `dias`, no calendário (sem fuso: a data já é a do fuso da cobrança). */
export function addDaysIso(iso, dias) {
  const base = Date.parse(`${iso}T00:00:00Z`);
  return new Date(base + dias * DIA).toISOString().slice(0, 10);
}

function hojeIso(now) {
  return ChargeIssuingService.isoDate(now);
}

function segundoInteiro(now) {
  return new Date(Math.floor(now.getTime() / 1000) * 1000);
}

/** O reajuste como o console e a tela de Plano o leem. */
export function presentPriceChange(change) {
  if (!change) return null;
  return {
    id: change.id,
    planId: change.plan_id,
    cycle: change.cycle,
    oldCents: change.old_cents,
    newCents: change.new_cents,
    effectiveAt: change.effective_at,
    noticeDays: change.notice_days,
    notify: change.notify,
    status: change.status,
    reason: change.reason ?? null,
    createdAt: change.created_at ?? null,
    notifiedAt: change.notified_at ?? null,
    appliedAt: change.applied_at ?? null,
    canceledAt: change.canceled_at ?? null
  };
}

/** O preço que `cycle` de `plan` cobra hoje — nulo quando o ciclo não tem preço. */
function precoAtual(plan, cycle) {
  if (cycle === 'annual') return annualAvailable(plan) ? Math.floor(Number(plan.price_yearly_cents)) : null;
  const mensal = Math.floor(Number(plan?.price_cents ?? 0));
  return mensal > 0 ? mensal : null;
}

class PlanPriceChangeService {
  static lastPassAt = 0;
  /** A cadência da passada do agendador: os passos são idempotentes, então é só carga. */
  static PASS_INTERVAL_MS = 5 * 60 * 1000;

  // ── Quem o reajuste pega ─────────────────────────────────────────────

  /**
   * As assinaturas no plano, no ciclo do reajuste, que vão de fato pagar o
   * preço novo: cobráveis (`isBillableStatus`), sem isenção e sem
   * cancelamento agendado. `exempt` conta à parte as isentas do mesmo plano e
   * ciclo — a tela diz que existem e que não mudam.
   */
  static async affectedSubscriptions(plan, cycle) {
    // tenant-scope-exempt: o console perguntando quem está neste plano, acima dos provedores.
    const linhas = await runUnscoped('the console lists the providers a price change reaches', () => getDb()('subscriptions')
      .join('tenants', 'tenants.id', 'subscriptions.tenant_id')
      .where('subscriptions.plan_id', plan.id)
      .where((q) => q.whereNull('tenants.kind').orWhereNot('tenants.kind', 'platform'))
      .select('subscriptions.*'));
    const noCiclo = linhas.filter((sub) => SubscriptionService.cycleOf(sub, plan) === cycle);
    const affected = [];
    let exempt = 0;
    for (const sub of noCiclo) {
      if (sub.billing_exempt_at) {
        if (isBillableStatus(sub)) exempt += 1;
        continue;
      }
      if (!isBillableStatus(sub) || isCancelScheduled(sub)) continue;
      affected.push(sub);
    }
    return { affected, exempt };
  }

  /**
   * A prévia: quantos provedores o preço novo pega e quanto a soma das
   * faturas de um ciclo deles fica, antes e depois — com o cupom de cada um
   * (`priceFor`), que desconta sobre o preço novo.
   */
  static async preview({ planId, cycle, newCents = null }) {
    const plan = await Plan.findById(planId);
    if (!plan) throw new PlanPriceChangeError('priceChange.planNotFound', { code: 'not_found', status: 404 });
    if (!PRICE_CHANGE_CYCLES.includes(cycle)) {
      throw new PlanPriceChangeError('priceChange.invalidCycle', { code: 'invalid_cycle' });
    }
    const atual = precoAtual(plan, cycle);
    const novo = newCents === null || newCents === undefined ? atual : Math.floor(Number(newCents));
    const { affected, exempt } = await this.affectedSubscriptions(plan, cycle);
    const coluna = priceColumnOf(cycle);
    const reajustado = { ...plan, [coluna]: novo };
    const cupons = new Map();
    let antes = 0;
    let depois = 0;
    for (const sub of affected) {
      let cupom = null;
      if (sub.coupon_id) {
        if (!cupons.has(sub.coupon_id)) cupons.set(sub.coupon_id, await Coupon.findById(sub.coupon_id));
        cupom = cupons.get(sub.coupon_id);
      }
      antes += SubscriptionService.priceFor(sub, plan, cupom);
      depois += novo > 0 ? SubscriptionService.priceFor(sub, reajustado, cupom) : 0;
    }
    return {
      planId: Number(plan.id),
      cycle,
      currency: plan.currency || 'BRL',
      currentCents: atual,
      newCents: novo,
      affected: affected.length,
      exempt,
      revenueBeforeCents: antes,
      revenueAfterCents: depois,
      deltaCents: depois - antes
    };
  }

  // ── Agendar e cancelar ───────────────────────────────────────────────

  /**
   * Agenda o reajuste. As recusas (`PlanPriceChangeError`, 400 ou 409):
   * ciclo inválido ou sem preço hoje; preço novo que não é inteiro > 0 ou é
   * igual ao de hoje; antecedência fora de 1–365 dias; data que não é
   * `YYYY-MM-DD`, que fica antes de hoje + antecedência, ou a mais de dois
   * anos; e já haver um reajuste agendado para o mesmo plano e ciclo — um de
   * cada vez, ou o segundo atropelaria o "de" do primeiro.
   */
  static async schedule({
    planId, cycle, newCents, effectiveAt, noticeDays = DEFAULT_NOTICE_DAYS, notify = true, reason = null,
    actorUserId = null, now = new Date()
  }) {
    const plan = await Plan.findById(planId);
    if (!plan) throw new PlanPriceChangeError('priceChange.planNotFound', { code: 'not_found', status: 404 });
    if (!PRICE_CHANGE_CYCLES.includes(cycle)) {
      throw new PlanPriceChangeError('priceChange.invalidCycle', { code: 'invalid_cycle' });
    }
    const atual = precoAtual(plan, cycle);
    if (atual === null) throw new PlanPriceChangeError('priceChange.noCurrentPrice', { code: 'no_current_price' });
    const novo = Number(newCents);
    if (!Number.isInteger(novo) || novo <= 0) {
      throw new PlanPriceChangeError('priceChange.invalidPrice', { code: 'invalid_price' });
    }
    if (novo === atual) throw new PlanPriceChangeError('priceChange.samePrice', { code: 'same_price' });
    const dias = noticeDays === null || noticeDays === undefined || noticeDays === '' ? DEFAULT_NOTICE_DAYS : Number(noticeDays);
    if (!Number.isInteger(dias) || dias < MIN_NOTICE_DAYS || dias > MAX_NOTICE_DAYS) {
      throw new PlanPriceChangeError('priceChange.invalidNoticeDays', {
        code: 'invalid_notice_days', vars: { min: MIN_NOTICE_DAYS, max: MAX_NOTICE_DAYS }
      });
    }
    const data = String(effectiveAt ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(Date.parse(`${data}T00:00:00Z`))
      || new Date(`${data}T00:00:00Z`).toISOString().slice(0, 10) !== data) {
      throw new PlanPriceChangeError('priceChange.invalidDate', { code: 'invalid_date' });
    }
    const hoje = hojeIso(now);
    const primeira = addDaysIso(hoje, dias);
    if (data < primeira) {
      throw new PlanPriceChangeError('priceChange.tooSoon', {
        code: 'effective_too_soon', vars: { date: primeira, days: dias }
      });
    }
    if (data > addDaysIso(hoje, MAX_AHEAD_DAYS)) {
      throw new PlanPriceChangeError('priceChange.tooFar', { code: 'effective_too_far' });
    }
    if (typeof notify !== 'boolean') {
      throw new PlanPriceChangeError('priceChange.invalidNotify', { code: 'invalid_notify' });
    }
    const existente = await PlanPriceChange.scheduledFor(plan.id, cycle);
    if (existente) {
      throw new PlanPriceChangeError('priceChange.alreadyScheduled', {
        code: 'price_change_exists', status: 409, vars: { date: existente.effective_at }
      });
    }
    const motivo = reason === null || reason === undefined ? null : String(reason).trim().slice(0, 255) || null;
    const change = await PlanPriceChange.create({
      plan_id: plan.id,
      cycle,
      old_cents: atual,
      new_cents: novo,
      effective_at: data,
      notice_days: dias,
      notify,
      status: 'scheduled',
      reason: motivo,
      created_by: actorUserId,
      created_at: segundoInteiro(now)
    });
    // Duas abas agendando ao mesmo tempo: a leitura de cima não vê a outra.
    // Quem ficou com o id maior desiste — sobra exatamente um.
    const agendados = await PlanPriceChange.list({ planId: plan.id, statuses: ['scheduled'] });
    const doCiclo = agendados.filter((c) => c.cycle === cycle).sort((a, b) => a.id - b.id);
    if (doCiclo.length > 1 && doCiclo[0].id !== change.id) {
      await getDb()('plan_price_changes').where({ id: change.id }).del();
      throw new PlanPriceChangeError('priceChange.alreadyScheduled', {
        code: 'price_change_exists', status: 409, vars: { date: doCiclo[0].effective_at }
      });
    }
    return { change, plan };
  }

  /** Cancela o reajuste agendado; o aplicado não se desfaz por aqui (edita-se o plano). */
  static async cancel({ id, actorUserId = null, now = new Date() }) {
    const change = await PlanPriceChange.findById(id);
    if (!change) throw new PlanPriceChangeError('priceChange.notFound', { code: 'not_found', status: 404 });
    const ok = await PlanPriceChange.transition(change.id, 'scheduled', {
      status: 'canceled', canceled_at: segundoInteiro(now), canceled_by: actorUserId
    });
    if (!ok) throw new PlanPriceChangeError('priceChange.notScheduled', { code: 'not_scheduled', status: 409 });
    return PlanPriceChange.findById(change.id);
  }

  /**
   * O reajuste agendado que pega ESTA assinatura — para o aviso na tela de
   * Plano do provedor ("o valor muda para X em DD/MM"). Nulo sem reajuste,
   * para quem é isento, e para quem não vai renovar.
   */
  static async upcomingFor(subscription) {
    if (!subscription?.plan_id || subscription.billing_exempt_at) return null;
    if (!isBillableStatus(subscription) || isCancelScheduled(subscription)) return null;
    const plan = await Plan.findById(subscription.plan_id);
    if (!plan) return null;
    const ciclo = SubscriptionService.cycleOf(subscription, plan);
    const change = await PlanPriceChange.scheduledFor(plan.id, ciclo);
    if (!change) return null;
    return {
      cycle: change.cycle,
      oldCents: change.old_cents,
      newCents: change.new_cents,
      effectiveAt: change.effective_at,
      currency: plan.currency || 'BRL'
    };
  }

  // ── A passada do agendador ───────────────────────────────────────────

  /** O que o agendador chama a cada volta; anda de cinco em cinco minutos. Nunca lança. */
  static async schedulerPass({ now = new Date() } = {}) {
    if (now.getTime() - this.lastPassAt < this.PASS_INTERVAL_MS) return null;
    this.lastPassAt = now.getTime();
    try {
      return await this.runDue({ now });
    } catch (error) {
      log.warn('plan price change pass failed', { err: error });
      return { error: error.message };
    }
  }

  /**
   * Um passo de cada reajuste vivo: o aviso, a reemissão das cobranças já
   * emitidas que vencem na vigência, e a aplicação na data. Os cancelados há
   * pouco devolvem ao preço de antes o que já tinha sido reemitido.
   */
  static async runDue({ now = new Date() } = {}) {
    const hoje = hojeIso(now);
    const desde = addDaysIso(hoje, -REVISIT_DAYS);
    const vivos = await getDb()('plan_price_changes')
      .where({ status: 'scheduled' })
      .orWhere((q) => q.where({ status: 'applied' }).where('effective_at', '>=', desde))
      .orWhere((q) => q.where({ status: 'canceled' }).where('canceled_at', '>=', new Date(now.getTime() - REVISIT_DAYS * DIA)))
      .orderBy('id', 'asc')
      .select('id');
    const resumo = { notified: 0, repriced: 0, reverted: 0, applied: 0, failed: 0 };
    for (const linha of vivos) {
      // eslint-disable-next-line no-await-in-loop -- um reajuste de cada vez, e são poucos
      const change = await PlanPriceChange.findById(linha.id);
      if (!change) continue;
      try {
        if (change.status === 'canceled') {
          // eslint-disable-next-line no-await-in-loop
          const r = await this.revertCharges(change, { now });
          resumo.reverted += r.reverted;
          resumo.failed += r.failed;
          continue;
        }
        if (change.status === 'scheduled' && change.notify && hoje >= addDaysIso(change.effective_at, -change.notice_days)) {
          // eslint-disable-next-line no-await-in-loop
          const r = await this.notifyAll(change, { now });
          resumo.notified += r.sent;
          resumo.failed += r.failed;
        }
        // eslint-disable-next-line no-await-in-loop
        const r = await this.repriceCharges(change, { now });
        resumo.repriced += r.repriced;
        resumo.failed += r.failed;
        // eslint-disable-next-line no-await-in-loop
        if (change.status === 'scheduled' && hoje >= change.effective_at && await this.apply(change, { now })) {
          resumo.applied += 1;
        }
      } catch (error) {
        resumo.failed += 1;
        log.warn('plan price change step failed', { err: error, changeId: change.id });
      }
    }
    return resumo;
  }

  /**
   * A data chegou: o preço novo vai para o plano, junto com a marca de
   * aplicado, numa transação — um plano com o preço velho e um reajuste
   * "aplicado" deixaria a cobrança da vigência sem o preço novo. Condicional
   * ao `scheduled`: de duas passadas, uma aplica.
   */
  static async apply(change, { now = new Date() } = {}) {
    const coluna = priceColumnOf(change.cycle);
    const aplicou = await getDb().transaction(async (trx) => {
      const ok = await PlanPriceChange.transition(change.id, 'scheduled', {
        status: 'applied', applied_at: segundoInteiro(now)
      }, trx);
      if (!ok) return false;
      await trx('plans').where({ id: change.plan_id }).update({ [coluna]: change.new_cents, updated_at: segundoInteiro(now) });
      return true;
    });
    if (!aplicou) return false;
    const plan = await Plan.findById(change.plan_id);
    await PlatformAudit.record({
      action: PlatformAudit.ACTIONS.PLAN_PRICE_CHANGE_APPLIED,
      detail: {
        changeId: change.id, planId: change.plan_id, planCode: plan?.code ?? null, cycle: change.cycle,
        oldCents: change.old_cents, newCents: change.new_cents, effectiveAt: change.effective_at
      }
    });
    return true;
  }

  /** Avisa cada provedor afetado que ainda não foi avisado deste reajuste. */
  static async notifyAll(change, { now = new Date() } = {}) {
    const plan = await Plan.findById(change.plan_id);
    if (!plan) return { sent: 0, failed: 0 };
    const { affected } = await this.affectedSubscriptions(plan, change.cycle);
    let sent = 0;
    let failed = 0;
    let completo = true;
    for (const sub of affected) {
      const tenantId = Number(sub.tenant_id);
      // eslint-disable-next-line no-await-in-loop -- um provedor por vez: SMTP e WhatsApp não aguentam rajada
      const minha = await PlanPriceChange.claimMark({
        changeId: change.id, tenantId, mark: 'notice', now, until: new Date(now.getTime() + CLAIM_MS), maxAttempts: 5
      });
      if (!minha) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const resultado = await runInTenant(tenantId, () => this.notifyTenant({ change, plan, tenantId }));
        if (resultado.sent || resultado.reason === 'no_recipient') {
          // eslint-disable-next-line no-await-in-loop
          await PlanPriceChange.finishMark({
            changeId: change.id, tenantId, mark: 'notice', now,
            detail: resultado.sent ? resultado.channels.join(',') : resultado.reason
          });
          if (resultado.sent) sent += 1;
        } else {
          failed += 1;
          completo = false;
          // eslint-disable-next-line no-await-in-loop
          await PlanPriceChange.failMark({
            changeId: change.id, tenantId, mark: 'notice', detail: resultado.reason, retryAt: new Date(now.getTime() + RETRY_MS)
          });
        }
      } catch (error) {
        failed += 1;
        completo = false;
        // eslint-disable-next-line no-await-in-loop
        await PlanPriceChange.failMark({
          changeId: change.id, tenantId, mark: 'notice', detail: error.message, retryAt: new Date(now.getTime() + RETRY_MS)
        });
      }
    }
    if (completo && !change.notified_at) {
      await PlanPriceChange.update(change.id, { notified_at: segundoInteiro(now) });
    }
    return { sent, failed };
  }

  /** A mensagem do aviso para o provedor em escopo; `{ sent, channels?, reason? }`. Não lança. */
  static async notifyTenant({ change, plan, tenantId }) {
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || tenant.kind === 'platform') return { sent: false, reason: 'no_recipient' };
    const transporte = mailTransport();
    const temEmail = transporte.name !== 'none';
    const para = temEmail ? await SubscriptionNoticeService.recipients(tenant) : [];
    const fone = String(tenant.billing_phone ?? '').trim();
    if (!para.length && !fone) return { sent: false, reason: 'no_recipient' };
    const moeda = plan.currency || 'BRL';
    const [ano, mes, dia] = change.effective_at.split('-');
    const vars = {
      provider: tenant.name || PRODUCT_NAME,
      plan: plan.name,
      cycle: translate(DEFAULT_LOCALE, change.cycle === 'annual' ? 'priceChange.cycleAnnual' : 'priceChange.cycleMonthly'),
      old: SubscriptionNoticeService.formatAmount(change.old_cents, moeda),
      new: SubscriptionNoticeService.formatAmount(change.new_cents, moeda),
      date: `${dia}/${mes}/${ano}`
    };
    const assunto = translate(DEFAULT_LOCALE, 'priceChange.noticeSubject', vars);
    const texto = translate(DEFAULT_LOCALE, 'priceChange.noticeBody', vars);
    const canais = await SubscriptionNoticeService.send({ para, fone, transporte, assunto, texto });
    if (!canais.length) return { sent: false, reason: 'send_failed' };
    await AuditLog.record({
      action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
      actorKind: 'system',
      subjectType: 'subscription',
      subjectId: tenantId,
      detail: {
        platformAction: 'plan.price_change_notified', changeId: change.id, cycle: change.cycle,
        oldCents: change.old_cents, newCents: change.new_cents, effectiveAt: change.effective_at, channels: canais
      }
    });
    return { sent: true, channels: canais };
  }

  /**
   * As cobranças em aberto, já no gateway, que vencem na vigência do
   * reajuste, de quem está (ou vai estar, pela troca agendada) no plano —
   * menos as de valor mudado à mão e as que este reajuste já tratou
   * (`prefix`). Lidas de cima, numa consulta: a passada não abre o escopo de
   * provedor nenhum que não tenha o que fazer.
   */
  static async candidateCharges(change, prefix) {
    // tenant-scope-exempt: o agendador da plataforma procurando, acima dos provedores, o que um reajuste do catálogo alcança.
    const linhas = await runUnscoped('the platform scheduler finds the charges a price change reaches', () => getDb()('billing_charges as bc')
      .join('subscriptions as s', 's.tenant_id', 'bc.tenant_id')
      .where((q) => q.where('s.plan_id', change.plan_id).orWhere('s.pending_plan_id', change.plan_id))
      .whereIn('bc.status', OPEN_CHARGE_STATUSES)
      .whereNotNull('bc.gateway_charge_id')
      .whereNull('bc.amount_overridden_at')
      .where((q) => q.whereNull('bc.kind').orWhere('bc.kind', 'renewal'))
      .where('bc.period_end', '>=', change.effective_at)
      .select('bc.id', 'bc.tenant_id', 'bc.amount_cents', 'bc.period_end'));
    if (!linhas.length) return [];
    const feitas = new Set((await PlanPriceChange.marksOf(change.id, { prefix, status: 'done' }))
      .map((m) => `${m.tenant_id}:${m.mark}`));
    return linhas.filter((linha) => !feitas.has(`${linha.tenant_id}:${prefix}${linha.id}`));
  }

  /** Reemite, uma vez por cobrança, as que saíram com o preço velho e vencem na vigência. */
  static async repriceCharges(change, { now = new Date() } = {}) {
    const candidatas = await this.candidateCharges(change, 'reprice:');
    let repriced = 0;
    let failed = 0;
    for (const linha of candidatas) {
      // eslint-disable-next-line no-await-in-loop -- uma conversa com o gateway por vez
      const r = await this.repriceOne(change, linha, `reprice:${linha.id}`, { now });
      if (r === 'reissued') repriced += 1;
      if (r === 'failed') failed += 1;
    }
    return { repriced, failed };
  }

  /**
   * O reajuste cancelado: a cobrança em aberto que saiu pelo preço novo —
   * reemitida por ele, ou já emitida com ele depois do agendamento — volta ao
   * preço de antes. `planAt` já não vê o cancelado, e a mesma porta a põe no
   * preço que a emissão pediria agora; a que já está nele fica (`none`). Uma
   * vez por cobrança (`revert:<id>`).
   */
  static async revertCharges(change, { now = new Date() } = {}) {
    const candidatas = await this.candidateCharges(change, 'revert:');
    let reverted = 0;
    let failed = 0;
    for (const linha of candidatas) {
      // eslint-disable-next-line no-await-in-loop -- uma conversa com o gateway por vez
      const r = await this.repriceOne(change, linha, `revert:${linha.id}`, { now });
      if (r === 'reissued') reverted += 1;
      if (r === 'failed') failed += 1;
    }
    return { reverted, failed };
  }

  /** Uma cobrança, sob a marca dela: `'reissued' | 'none' | 'skipped' | 'busy' | 'failed'`. */
  static async repriceOne(change, linha, mark, { now }) {
    const tenantId = Number(linha.tenant_id);
    const minha = await PlanPriceChange.claimMark({
      changeId: change.id, tenantId, mark, now, until: new Date(now.getTime() + CLAIM_MS)
    });
    if (!minha) return 'busy';
    try {
      const tenant = await Tenant.findById(tenantId);
      const resultado = tenant
        ? await runInTenant(tenantId, () => SelfBillingService.repriceForPriceChange({
          tenant, planId: change.plan_id, cycle: change.cycle
        }))
        : { charge: 'skipped', reason: 'tenant_gone' };
      await PlanPriceChange.finishMark({
        changeId: change.id, tenantId, mark, now, detail: resultado.charge === 'skipped' ? `skipped:${resultado.reason}` : resultado.charge
      });
      if (resultado.charge === 'reissued') {
        await runInTenant(tenantId, () => AuditLog.record({
          action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
          actorKind: 'system',
          subjectType: 'subscription',
          subjectId: tenantId,
          detail: {
            platformAction: mark.startsWith('revert:') ? 'plan.price_change_reverted' : 'plan.price_change_repriced',
            changeId: change.id,
            chargeId: Number(linha.id),
            fromCents: Number(linha.amount_cents),
            issued: Boolean(resultado.reissue?.issued)
          }
        }));
      }
      return resultado.charge;
    } catch (error) {
      await PlanPriceChange.failMark({
        changeId: change.id, tenantId, mark, detail: error.code || error.message, retryAt: new Date(now.getTime() + RETRY_MS)
      });
      log.warn('plan price change reprice failed', { err: error, changeId: change.id, tenantId });
      return 'failed';
    }
  }
}

export default PlanPriceChangeService;
