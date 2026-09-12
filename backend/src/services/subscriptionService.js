import Plan from '../models/Plan.js';
import Subscription, { SUBSCRIPTION_STATUSES } from '../models/Subscription.js';
import BillingEvent, { BILLING_EVENT_TYPES } from '../models/BillingEvent.js';
import { getDb, tdb, isUniqueViolation } from '../config/database.js';
import { TenantCache } from '../config/tenantCache.js';
import { currentTenantId, runInTenant } from '../config/tenantContext.js';

/**
 * O ciclo de vida da assinatura, e o que cada estado deixa fazer.
 *
 * Cinco estados e uma regra por estado — é toda a política, e está aqui e em
 * lugar nenhum mais: o gate pergunta, os limites perguntam, o console pergunta.
 *
 *   trial      passa. Vira `past_due` sozinho quando `trial_ends_at` vence —
 *              sem job, sem cron: é calculado na leitura, então não há janela
 *              em que um teste vencido ainda passe porque o job não rodou.
 *   active     passa — até `renews_at` vencer, e aí vira `past_due` pela mesma
 *              mecânica e pelo mesmo motivo. `renews_at` nulo é assinatura sem
 *              ciclo e não vence; ver `effectiveStatus`.
 *   past_due   passa SÓ PARA LER. Operador atrasado continua vendo a frota e
 *              o assinante continua com o portal de pé; o que para é escrever.
 *              Derrubar o autoatendimento dos clientes finais de um ISP por
 *              fatura atrasada é um tiro no pé comercial — o plano é explícito.
 *   suspended  402. Nós desligamos: inadimplência longa, abuso, o que for.
 *   canceled   402. O contrato acabou; o que resta é exportar e apagar.
 *
 * `suspended` aqui e `tenants.status = 'suspended'` são DUAS chaves, de
 * propósito. A do provedor é operacional: para os jobs de fundo, recusa o
 * webhook do ERP. A da assinatura é comercial: o que o operador vê ao entrar.
 * Uma inadimplência não precisa parar o alerta de ONT caída do assinante, e
 * uma parada operacional não é uma cobrança.
 */
export const STATUSES = SUBSCRIPTION_STATUSES;

/** Códigos que o frontend lê. Estáveis: a tela de bloqueio escolhe o texto por eles. */
export const GATE_CODES = Object.freeze({
  PAST_DUE: 'subscription_past_due',
  TRIAL_EXPIRED: 'subscription_trial_expired',
  SUSPENDED: 'subscription_suspended',
  CANCELED: 'subscription_canceled',
  MISSING: 'subscription_missing'
});

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Quanto tempo o gate confia na última leitura antes de perguntar de novo. */
const CACHE_TTL_MS = 15_000;
const cache = new TenantCache(CACHE_TTL_MS);

const DAY_MS = 24 * 60 * 60 * 1000;
const PAID_PERIOD_DAYS = 30;

export class PlanLimitError extends Error {
  constructor(code, { limit, current, resource }) {
    super(`Plan limit reached for ${resource}: ${current} of ${limit}`);
    this.name = 'PlanLimitError';
    this.code = code;
    this.limit = limit;
    this.current = current;
    this.resource = resource;
  }
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

class SubscriptionService {
  static cache = cache;
  static PAID_PERIOD_DAYS = PAID_PERIOD_DAYS;

  /**
   * O estado que VALE, que nem sempre é o da coluna: um prazo que venceu é
   * `past_due`, e é `past_due` desde o segundo em que venceu.
   *
   * São dois prazos, e por muito tempo só um deles era lido. O teste vencia
   * sozinho; o período PAGO não vencia nunca. `renews_at` era escrito por
   * `recordPayment`, exibido na tela do provedor, no console e no extrato — e
   * nenhuma decisão o consultava. O efeito não era um incômodo operacional: um
   * provedor que pagou UMA vez ficava `active` para sempre, e ninguém percebia,
   * porque a tela mostrava a data certa. Receita saindo em silêncio é pior do
   * que receita saindo com barulho.
   *
   * ## `renews_at` nulo não vence
   *
   * E isso não é descuido, é a regra. A coluna quer dizer "o período pago
   * termina aqui"; sem data, não há período — é a assinatura que nunca foi
   * posta num ciclo. São três populações reais: o provedor que o console pôs
   * num plano sem nunca registrar pagamento (`setPlan` grava `active` e mais
   * nada), a instalação self-hosted, e todo provedor que já está no banco hoje.
   * Tratar nulo como vencido transformaria esta linha, que conserta uma perda
   * de receita, numa parada geral no primeiro deploy.
   */
  static effectiveStatus(subscription, now = new Date()) {
    if (!subscription) return { status: null, reason: 'missing' };
    const stored = STATUSES.includes(subscription.status) ? subscription.status : 'suspended';
    if (stored === 'trial') {
      const ends = asDate(subscription.trial_ends_at);
      if (ends && ends.getTime() <= now.getTime()) {
        return { status: 'past_due', reason: 'trial_expired' };
      }
    }
    if (stored === 'active') {
      const ends = asDate(subscription.renews_at);
      if (ends && ends.getTime() <= now.getTime()) {
        return { status: 'past_due', reason: 'renewal_expired' };
      }
    }
    return { status: stored, reason: null };
  }

  /**
   * O que o gate responde para uma requisição, dado o estado.
   *
   * `write` é o método não ser de leitura. `webhook` é uma entrega de fora —
   * ERP, Evolution — que não é "o operador escrevendo": em `past_due` ela
   * continua entrando, porque recusar o evento do ERP por fatura atrasada
   * perderia dado do assinante, e o assinante não deve nada a ninguém.
   */
  static decide(subscription, { method = 'GET', webhook = false, now = new Date() } = {}) {
    const { status, reason } = this.effectiveStatus(subscription, now);
    if (status === null) return { allowed: false, code: GATE_CODES.MISSING };
    if (status === 'trial' || status === 'active') return { allowed: true, code: null };
    if (status === 'past_due') {
      const reading = READ_METHODS.has(String(method).toUpperCase()) || webhook;
      if (reading) return { allowed: true, code: null };
      return {
        allowed: false,
        code: reason === 'trial_expired' ? GATE_CODES.TRIAL_EXPIRED : GATE_CODES.PAST_DUE
      };
    }
    if (status === 'suspended') return { allowed: false, code: GATE_CODES.SUSPENDED };
    return { allowed: false, code: GATE_CODES.CANCELED };
  }

  /** A assinatura do provedor em escopo, com o plano, do cache quando dá. */
  static async current() {
    const cached = cache.get();
    if (cached) return cached;
    const subscription = await Subscription.current();
    const plan = subscription ? await Plan.findById(subscription.plan_id) : null;
    return cache.set({ subscription, plan });
  }

  /** Esquece a leitura de UM provedor — a que o console acabou de mudar. */
  static invalidate(tenantId) {
    return runInTenant(tenantId, () => cache.invalidate());
  }

  /**
   * O que o provedor (ou a tela de bloqueio) pode ver da própria assinatura.
   * Sem preço: o preço é do console, e o que o operador precisa é o estado,
   * o plano e até quando.
   */
  static present({ subscription, plan }, now = new Date()) {
    if (!subscription) return null;
    const effective = this.effectiveStatus(subscription, now);
    return {
      status: effective.status,
      storedStatus: subscription.status,
      reason: effective.reason,
      plan: plan ? {
        code: plan.code,
        name: plan.name,
        limits: this.limitsOf(plan)
      } : null,
      trialEndsAt: subscription.trial_ends_at ?? null,
      renewsAt: subscription.renews_at ?? null,
      canceledAt: subscription.canceled_at ?? null
    };
  }

  static limitsOf(plan) {
    const asLimit = (value) => (value === null || value === undefined ? null : Number(value));
    return {
      operators: asLimit(plan?.max_operators),
      subscribers: asLimit(plan?.max_subscribers),
      devices: asLimit(plan?.max_devices)
    };
  }

  // ── Limites ──────────────────────────────────────────────────────────

  /** Quantas pessoas trabalham no provedor em escopo. */
  static async operatorCount() {
    const [row] = await getDb()('tenant_users')
      .where({ tenant_id: currentTenantId() })
      .count({ n: '*' });
    return Number(row?.n ?? 0);
  }

  static async subscriberCount() {
    // Só as vivas: uma conta aposentada por troca de ONT não ocupa vaga.
    const [row] = await tdb('customer_accounts').where({ active: true }).count({ n: '*' });
    return Number(row?.n ?? 0);
  }

  /**
   * Lança se o provedor em escopo não pode ganhar mais um operador.
   *
   * Conta a partir do banco, não do cache: o limite existe para o dia em que
   * dois administradores criam ao mesmo tempo, e um número guardado 15 s atrás
   * é exatamente o que os dois leriam.
   */
  static async assertCanAddOperator() {
    const { plan } = await this.current();
    const limit = this.limitsOf(plan).operators;
    if (limit === null) return;
    const current = await this.operatorCount();
    if (current >= limit) {
      throw new PlanLimitError('plan_limit_operators', { limit, current, resource: 'operators' });
    }
  }

  /**
   * Quantos assinantes ainda cabem, ou null quando não há limite.
   *
   * Devolve um número em vez de lançar porque quem pergunta é a sincronização
   * de aparelhos, que roda no fundo e cria contas em lote: ela precisa saber
   * quantas ainda pode criar nesta passada, e a passada seguinte pergunta de
   * novo. Lançar ali derrubaria a sincronização inteira por causa da conta que
   * não coube.
   */
  static async remainingSubscribers() {
    const { plan } = await this.current();
    const limit = this.limitsOf(plan).subscribers;
    if (limit === null) return null;
    return Math.max(0, limit - await this.subscriberCount());
  }

  /**
   * Uso contra limites, para a tela e para o console.
   *
   * A contagem de ONTs vem do GenieACS e pode falhar — ACS fora, credencial
   * errada. Ela vira `null` em vez de derrubar a resposta: os outros dois
   * números continuam valendo, e a tela diz "não deu para contar" em vez de
   * nada.
   */
  static async usage({ countDevices } = {}) {
    const state = await this.current();
    const limits = this.limitsOf(state.plan);
    const [operators, subscribers] = await Promise.all([
      this.operatorCount(),
      this.subscriberCount()
    ]);
    let devices = null;
    if (typeof countDevices === 'function') {
      try {
        devices = await countDevices();
      } catch {
        devices = null;
      }
    }
    const over = (used, limit) => (limit !== null && used !== null && used > limit);
    return {
      subscription: this.present(state),
      usage: { operators, subscribers, devices },
      limits,
      over: {
        operators: over(operators, limits.operators),
        subscribers: over(subscribers, limits.subscribers),
        devices: over(devices, limits.devices)
      }
    };
  }

  // ── Mudanças (chamadas pelo console, no escopo do provedor alvo) ─────

  /**
   * Troca o plano do provedor em escopo. O status não muda: quem está em
   * `past_due` continua devendo, só que num plano diferente.
   */
  static async changePlan({ planId, actorUserId = null }) {
    const tenantId = currentTenantId();
    const plan = await Plan.findById(planId);
    if (!plan) throw new Error('Plan not found');
    const before = await Subscription.forTenant(tenantId);
    const subscription = await Subscription.upsertForTenant(tenantId, {
      plan_id: plan.id,
      ...(before ? {} : { status: 'active' })
    });
    await BillingEvent.record({
      subscriptionId: subscription.id,
      type: BILLING_EVENT_TYPES.PLAN_CHANGED,
      createdBy: actorUserId,
      detail: { from: before?.plan_id ?? null, to: plan.id, toCode: plan.code }
    });
    cache.invalidate();
    return subscription;
  }

  /**
   * Muda o status à mão. `active` por aqui não é pagamento — pagamento é
   * `recordPayment`, que estende o período; isto é o botão de "libera" que
   * um humano aperta com razão própria, e a razão vai no extrato.
   */
  static async setStatus({ status, reason = null, actorUserId = null, trialEndsAt, renewsAt }) {
    if (!STATUSES.includes(status)) throw new Error(`Status must be one of: ${STATUSES.join(', ')}`);
    const tenantId = currentTenantId();
    const before = await Subscription.forTenant(tenantId);
    if (!before) throw new Error('Subscription not found');
    const patch = { status };
    if (trialEndsAt !== undefined) patch.trial_ends_at = asDate(trialEndsAt);
    if (renewsAt !== undefined) patch.renews_at = asDate(renewsAt);
    patch.canceled_at = status === 'canceled' ? new Date() : null;
    const subscription = await Subscription.upsertForTenant(tenantId, patch);
    await BillingEvent.record({
      subscriptionId: subscription.id,
      type: BILLING_EVENT_TYPES.STATUS_CHANGED,
      createdBy: actorUserId,
      detail: { from: before.status, to: status, reason }
    });
    cache.invalidate();
    return subscription;
  }

  /**
   * Um pagamento entrou. O período pago se estende a partir do fim do período
   * atual quando ele ainda não venceu (pagou adiantado), ou de hoje quando já
   * venceu (pagou atrasado) — e o status volta a `active`, que é o que o
   * dinheiro compra. Um provedor `suspended` ou `canceled` NÃO é reativado por
   * pagamento: essas duas são decisões de gente, e é gente que as desfaz.
   */
  /**
   * Um pagamento: registra o fato e, se a assinatura está viva, empurra o
   * período pago.
   *
   * @returns {Promise<{ subscription: object, duplicate: boolean }>} a
   *   assinatura depois do pagamento, e se esta chamada foi uma REENTREGA —
   *   uma referência já vista, que não creditou nada.
   *
   * ## A mesma referência credita uma vez só
   *
   * Todo gateway reentrega webhook, e reentrega é a regra: sem isto, cada
   * entrega repetida de `PIX-001` empurrava o período pago mais trinta dias.
   * Medido antes da correção: a segunda entrega era aceita sem erro, a data
   * saía de 10/10 para 09/11 e o extrato ganhava um segundo evento. O
   * extrato tinha a coluna `external_id` mas não o índice único que o seu
   * próprio comentário dizia existir, e ninguém lia a referência antes de
   * creditar.
   *
   * Duas defesas, para dois casos. A leitura da referência é para o caso
   * comum — a reentrega minutos depois — e responde a primeira gravação. O
   * índice único `(tenant_id, external_id)` é para a corrida — duas entregas
   * iguais ao mesmo tempo, que passam as duas pela leitura — e a segunda
   * perde na inserção. Nulos não colidem nos três bancos, então a marca
   * manual sem referência continua podendo repetir-se.
   *
   * ## O evento antes da data, numa transação
   *
   * A ordem antiga era assinatura primeiro, evento depois, sem transação. Com
   * o índice no lugar, isso ainda creditaria: a reentrega empurrava os trinta
   * dias e SÓ ENTÃO estourava na inserção — 500 para quem chamou, mês dado.
   * O evento é o que a unicidade recusa, então é ele que vai primeiro, e a
   * data só se move na mesma transação em que ele entrou.
   */
  static async recordPayment({
    amountCents, currency = 'BRL', provider = 'manual', externalId = null,
    actorUserId = null, periodDays = PAID_PERIOD_DAYS, now = new Date()
  }) {
    const tenantId = currentTenantId();
    const before = await Subscription.forTenant(tenantId);
    if (!before) throw new Error('Subscription not found');
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount < 0) throw new Error('Amount must be a non-negative integer of cents');

    if (externalId && await BillingEvent.findByExternalId(externalId)) {
      return { subscription: before, duplicate: true };
    }

    const patch = {};
    const reactivates = before.status === 'trial' || before.status === 'active' || before.status === 'past_due';
    if (reactivates) {
      const currentEnd = asDate(before.renews_at);
      const base = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
      patch.renews_at = new Date(base.getTime() + periodDays * DAY_MS);
      patch.status = 'active';
      patch.trial_ends_at = null;
    }
    const statusAfter = patch.status ?? before.status;
    const renewsAt = patch.renews_at ?? before.renews_at ?? null;

    try {
      const subscription = await getDb().transaction(async (trx) => {
        await BillingEvent.record({
          subscriptionId: before.id,
          type: BILLING_EVENT_TYPES.PAYMENT_RECORDED,
          amountCents: amount,
          currency,
          provider,
          externalId,
          createdBy: actorUserId,
          detail: { statusBefore: before.status, statusAfter, renewsAt }
        }, trx);
        return Object.keys(patch).length
          ? Subscription.upsertForTenant(tenantId, patch, trx)
          : before;
      });
      return { subscription, duplicate: false };
    } catch (error) {
      // A corrida: a outra entrega igual chegou primeiro e já está gravada. A
      // resposta certa é a mesma da leitura lá em cima — o que já existe.
      if (externalId && isUniqueViolation(error)) {
        return { subscription: await Subscription.forTenant(tenantId), duplicate: true };
      }
      throw error;
    } finally {
      cache.invalidate();
    }
  }
}

export default SubscriptionService;
