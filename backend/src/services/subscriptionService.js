import Plan from '../models/Plan.js';
import Subscription, { SUBSCRIPTION_STATUSES } from '../models/Subscription.js';
import BillingEvent, { BILLING_EVENT_TYPES } from '../models/BillingEvent.js';
import BillingCharge from '../models/BillingCharge.js';
import Coupon, { parseCouponPlanIds } from '../models/Coupon.js';
import { getDb, tdb, isUniqueViolation } from '../config/database.js';
import { TenantCache } from '../config/tenantCache.js';
import { currentTenantId, runInTenant } from '../config/tenantContext.js';
import { IS_SAAS } from '../config/edition.js';

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

/**
 * Qual agendamento de cada provedor já foi avisado como bloqueado pelo uso.
 *
 * Em memória e não no banco: é só para o agendador não repetir a mesma linha
 * de log a cada minuto. Um reinício avisa de novo uma vez, o que é até bom.
 */
const avisosDeBloqueio = new Map();

/**
 * O período pago de quem não tem período no plano.
 *
 * Deixou de ser A verdade e virou a reserva: o prazo agora sai de
 * `plans.period_days` (migração 0046), do mesmo jeito que os dias de teste
 * sempre saíram de `plans.trial_days`. Trinta continua aqui porque é o que toda
 * assinatura deste deploy comprou até hoje — a reserva tem que dizer a verdade
 * sobre o passado, e não um número escolhido agora.
 *
 * Vale para o plano que a coluna ainda não alcançou e para a assinatura cujo
 * plano sumiu debaixo dela. Nos dois casos a alternativa seria não creditar
 * período nenhum, que transforma um dado faltando em um cliente bloqueado.
 */
const PAID_PERIOD_DAYS = 30;

/**
 * O menor valor que um cupom deixa uma fatura ter: R$ 5,00, o mínimo que o
 * Asaas aceita numa cobrança. Sem piso, um desconto grande daria uma fatura
 * que o gateway recusa — ou, no limite, uma de valor zero, que exigiria um
 * caminho de dinheiro que não existe (período pago sem pagamento). Um plano
 * que já custa menos que o piso fica com o preço dele: o cupom não sobe preço.
 */
export const COUPON_FLOOR_CENTS = 500;

/** Os dias que um pagamento compra neste plano, ou a reserva. */
function periodoDoPlano(plano) {
  const dias = Number(plano?.period_days);
  return Number.isFinite(dias) && dias > 0 ? Math.floor(dias) : PAID_PERIOD_DAYS;
}

/**
 * Quanto foi pedido por este pagamento, e em que moeda — ou nada, quando não
 * dá para dizer.
 *
 * Duas fontes, nesta ordem, e a ordem é a diferença entre uma conferência e um
 * palpite:
 *
 *   1. **A cobrança que o painel emitiu**, achada pelo id do gateway. É o valor
 *      que nós pedimos, congelado no instante em que pedimos. O plano pode ter
 *      mudado de preço depois — e se mudou, quem pagou pagou o que viu.
 *   2. **O preço do plano.** É a única resposta para a cobrança criada à mão no
 *      painel do gateway, que é como os primeiros contratos são cobrados, e
 *      para o botão do console.
 *
 * Devolve nulo quando não há referência (plano sem preço: todo provedor
 * herdado está no `unlimited`, que custa zero — ali nada foi pedido e qualquer
 * valor é um presente, não um pagamento a menos) e quando a moeda do pagamento
 * não é a da referência: comparar centavos de moedas diferentes não é uma
 * conferência frouxa, é uma conta errada.
 */
async function valorPedido({ externalId, plano, currency, precoDoPlano = null }) {
  const moedaPaga = String(currency || '').toUpperCase();

  // 1a. A cobrança que NUNCA chegou ao gateway, marcada paga à mão pelo
  //     console: sem id do lado de lá, a baixa manual usa `charge:<id da
  //     linha>` como referência (ver `PlatformSubscriptionsController.settle`),
  //     e é por ele que a linha se acha. Sem isto, a conferência cairia no
  //     preço do plano — e uma cobrança cujo valor o console acabou de ajustar
  //     seria conferida contra um número que não é o que se pediu. `tdb` por
  //     baixo: o id de uma linha do vizinho simplesmente não é achado.
  const daLinha = /^charge:(\d+)$/.exec(String(externalId ?? ''));
  const cobranca = !externalId
    ? null
    : daLinha
      ? await BillingCharge.findById(Number(daLinha[1]))
      : await BillingCharge.byGatewayId(externalId);
  if (cobranca) {
    const valor = Number(cobranca.amount_cents);
    if (Number.isFinite(valor) && valor > 0) {
      const moeda = String(cobranca.currency || '').toUpperCase();
      if (moeda && moeda !== moedaPaga) return { cents: null, motivo: 'currency_mismatch', fonte: 'charge' };
      // `overridden`: o valor foi mudado à mão pelo console (0078) e não é o
      // preço de plano nenhum — ver o destino da descida em `recordPayment`.
      return {
        cents: Math.floor(valor), motivo: null, fonte: 'charge', overridden: Boolean(cobranca.amount_overridden_at)
      };
    }
  }

  // 1b. **A cobrança que a linha JÁ FOI.** A troca de plano cancela no
  //     gateway a cobrança em aberto e reemite a linha com o preço novo — mas
  //     o boleto velho pode já estar impresso, e cancelar lá não desfaz um
  //     pagamento que entrou antes do cancelamento. Esse pagamento chega com
  //     o id velho, e a pergunta continua sendo "quanto se pediu POR ELE": o
  //     valor que aquela cobrança tinha, e não o preço novo — senão quem pagou
  //     exatamente o que viu seria "pago a menos".
  //
  //     Em voz alta, porque é o caso em que o provedor pode acabar pagando o
  //     mesmo período duas vezes: a cobrança nova continua viva no gateway, e
  //     cancelá-la ou estornar é decisão de gente.
  if (!cobranca && externalId) {
    const trocada = await BillingCharge.bySupersededGatewayId(externalId);
    if (trocada) {
      console.warn(
        `Payment ${externalId} settled a SUPERSEDED charge (replaced by charge row ${trocada.row.id} `
        + `after a plan change); the replacement may still be open at the gateway — review it in the console`
      );
      const valor = Number(trocada.superseded.amountCents);
      if (Number.isFinite(valor) && valor > 0) {
        const moeda = String(trocada.superseded.currency || '').toUpperCase();
        if (moeda && moeda !== moedaPaga) return { cents: null, motivo: 'currency_mismatch', fonte: 'charge' };
        return { cents: Math.floor(valor), motivo: null, fonte: 'superseded_charge' };
      }
    }
  }

  // O preço que a emissão teria pedido: o do plano com o cupom, quando há um
  // (`precoDoPlano`, ver `effectivePriceCents`) — senão o pagamento manual do
  // valor com desconto seria chamado de "pago a menos".
  const preco = precoDoPlano ?? Number(plano?.price_cents);
  if (!Number.isFinite(preco) || preco <= 0) return { cents: null, motivo: 'nothing_asked', fonte: null };
  const moedaPlano = String(plano?.currency || '').toUpperCase();
  if (moedaPlano && moedaPlano !== moedaPaga) return { cents: null, motivo: 'currency_mismatch', fonte: 'plan' };
  return { cents: Math.floor(preco), motivo: null, fonte: 'plan' };
}

/**
 * O prazo vivo de uma assinatura — o mesmo que a emissão lê, na mesma ordem:
 * a renovação, ou o fim do teste para quem nunca pagou.
 */
function prazoVivo(linha) {
  return asDate(linha?.renews_at) ?? asDate(linha?.trial_ends_at);
}

/**
 * Leva a cobrança em aberto do prazo velho para o novo, quando um prazo muda
 * à mão (`setDeadlines`, `setStatus` com data). Ver
 * `ChargeIssuingService.followDeadline`, que é quem fala com o gateway.
 *
 * Importado na hora, e não no topo: `chargeIssuingService` importa ESTE
 * arquivo, e o caminho de volta só é preciso quando um prazo é mexido à mão.
 * A recusa (`ChargeFollowError`) sobe como está, e quem chama não grava nada.
 */
async function followOpenCharge(before, patch, now = new Date()) {
  const depois = { ...before, ...patch };
  const de = prazoVivo(before);
  const para = prazoVivo(depois);
  if (!de || !para || de.getTime() === para.getTime()) return null;
  const { default: ChargeIssuingService } = await import('./chargeIssuingService.js');
  return ChargeIssuingService.followDeadline({ from: de, to: para, now });
}

/** Os estados em que o "isento de cobrança" pode ser ligado. */
const ESTADOS_ISENTAVEIS = new Set(['trial', 'active', 'past_due', 'suspended']);

/** Uma data sem os milissegundos: o MySQL guarda ao segundo, e o que se devolve tem de ser o que se gravou. */
function aoSegundo(data) {
  return new Date(Math.floor(data.getTime() / 1000) * 1000);
}

/** Uma recusa de `setBillingExempt`, com o status HTTP e o código que a tela lê. */
export class BillingExemptError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'BillingExemptError';
    this.status = status;
    this.code = code;
  }
}

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

/** Uma data como ISO, venha como vier do banco — ou nulo. */
function isoOf(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

/** O `detail` de uma linha do extrato, lido — nunca lança. */
function detalheDe(evento) {
  if (!evento?.detail) return null;
  try {
    const lido = JSON.parse(evento.detail);
    return lido && typeof lido === 'object' ? lido : null;
  } catch {
    return null;
  }
}

/** Os estados em que um pagamento empurra o prazo — o `reactivates` de `recordPayment`. */
const ESTADOS_QUE_ESTENDEM = new Set(['trial', 'active', 'past_due']);

/**
 * O que o pagamento de `detalhe` comprou, e de onde saiu a conta. Ver
 * `reversePayment`, que é quem decide QUANTO disto se desfaz.
 *
 *   - `from`/`to`: o prazo de antes (`renewsBefore`, gravado desde o estorno)
 *     e o de depois (`renewsAt`). É o que permite a `reversePayment` devolver
 *     EXATAMENTE o prazo de antes quando nada o mexeu depois do pagamento.
 *   - `ms`: o período COMPRADO — e só ele. O prazo novo de um pagamento é
 *     sempre `base + periodDays`, com `base` o maior entre o prazo de antes e
 *     o instante do pagamento; `renewsAt − max(renewsBefore, pago em)` é,
 *     então, os `periodDays` que ele gravou. É isto que se subtrai quando
 *     outra coisa mexeu no prazo depois (outro pagamento, uma cortesia): a
 *     diferença crua `renewsAt − renewsBefore` de um pagamento ATRASADO
 *     incluiria os dias vencidos entre o prazo velho e o pagamento — que
 *     ninguém comprou — e tiraria do pagamento seguinte o que era dele.
 *   - `basis`: `purchased` (o evento gravou `periodDays`), `period_days` (o
 *     evento é de antes do estorno existir: o período do plano do evento, se
 *     gravado, ou o de hoje) ou `not_extended` — o pagamento não empurrou
 *     nada, porque foi a menos e ninguém aceitou a diferença, ou porque a
 *     assinatura estava parada por gente (`suspended`, `canceled`). Estornar
 *     esse não devolve dia nenhum.
 */
async function duracaoCreditada(detalhe, planoAtual) {
  if (!detalhe || detalhe.underpaid) return { ms: 0, basis: 'not_extended', from: null, to: null };
  if (detalhe.statusBefore && !ESTADOS_QUE_ESTENDEM.has(detalhe.statusBefore)) {
    return { ms: 0, basis: 'not_extended', from: null, to: null };
  }
  const from = asDate(detalhe.renewsBefore);
  const to = asDate(detalhe.renewsAt);
  const gravado = Number(detalhe.periodDays);
  if (Number.isFinite(gravado) && gravado > 0) {
    return { ms: Math.floor(gravado) * DAY_MS, basis: 'purchased', from, to };
  }
  const planoDoEvento = detalhe.planId ? await Plan.findById(detalhe.planId) : null;
  return { ms: periodoDoPlano(planoDoEvento ?? planoAtual) * DAY_MS, basis: 'period_days', from, to };
}

class SubscriptionService {
  static cache = cache;

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
    // Isento de cobrança (`setBillingExempt`): ativo, e nunca vencido — não
    // há fatura, então não há prazo que vença. Só o `canceled` continua
    // valendo por cima: o contrato acabou, e a isenção era de cobrança, não de
    // contrato. E o `suspended` gravado também: suspender é o console
    // bloqueando de propósito, e a isenção perdoa a fatura, não o bloqueio.
    if (subscription.billing_exempt_at && stored !== 'canceled' && stored !== 'suspended') {
      return { status: 'active', reason: null };
    }
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
   * O prazo que está para vencer e ainda não foi avisado, ou nulo.
   *
   * Um provedor tem no máximo um prazo vivo: `trial_ends_at` enquanto está em
   * teste, `renews_at` depois que pagou. `suspended` e `canceled` não têm prazo
   * nenhum — já estão parados, e avisar quem já foi bloqueado é ruído.
   *
   * A janela vale também depois de vencer: quem passou do prazo sem ver o aviso
   * precisa receber um, e é justamente o caso em que o painel já está recusando
   * escrita. A marca `expiry_warned_for` guarda o prazo avisado, então um
   * segundo aviso só sai quando o prazo MUDA — e um pagamento que empurra
   * `renews_at` recomeça o ciclo sozinho.
   *
   * **A janela acompanha o período**, desde que o período passou a ser do plano
   * (migração 0046). Sete dias é a medida certa de um plano mensal e é pouco
   * para um anual: a fatura é doze vezes maior, passa por aprovação de alguém
   * que não é quem opera o painel, e uma semana não é tempo de conseguir isso.
   * Um doze avos do período, com piso de uma semana e teto de um mês — trinta
   * dias vira sete, trezentos e sessenta e cinco vira trinta, e nada entre os
   * dois surpreende. O teto existe porque avisar com dois meses de antecedência
   * não é aviso, é ruído que se esquece antes de vencer.
   */
  static WARN_WINDOW_DAYS = 7;

  static WARN_WINDOW_MAX_DAYS = 30;

  /** Quantos dias antes do prazo o aviso sai, neste plano. */
  static warnWindowDays(plano) {
    const periodo = periodoDoPlano(plano);
    return Math.min(
      this.WARN_WINDOW_MAX_DAYS,
      Math.max(this.WARN_WINDOW_DAYS, Math.ceil(periodo / 12))
    );
  }

  static pendingExpiryNotice(subscription, now = new Date(), plano = null) {
    if (!subscription) return null;
    // Isento de cobrança: não há prazo a avisar nem fatura a pagar.
    if (subscription.billing_exempt_at) return null;
    const stored = STATUSES.includes(subscription.status) ? subscription.status : 'suspended';
    if (stored !== 'trial' && stored !== 'active' && stored !== 'past_due') return null;

    // `past_due` é estado gravado à mão pelo console; o prazo dele é o que
    // houver. Em `trial` o prazo é o do teste, em `active` o do período pago.
    const prazo = stored === 'trial'
      ? asDate(subscription.trial_ends_at)
      : asDate(subscription.renews_at) ?? asDate(subscription.trial_ends_at);
    if (!prazo) return null;

    // Sem plano em mãos, a janela é a do piso: quem chama sem passá-lo recebe o
    // comportamento de antes, que é o certo para o teste — `trial_days` já é do
    // plano e o prazo de teste não escala com o período pago.
    const dias = stored === 'trial' ? this.WARN_WINDOW_DAYS : this.warnWindowDays(plano);
    const janela = now.getTime() + dias * DAY_MS;
    if (prazo.getTime() > janela) return null;

    const avisado = asDate(subscription.expiry_warned_for);
    if (avisado && avisado.getTime() === prazo.getTime()) return null;

    return {
      kind: stored === 'trial' ? 'trial' : 'renewal',
      deadline: prazo,
      expired: prazo.getTime() <= now.getTime()
    };
  }

  /** Anota que o aviso daquele prazo saiu. Idempotente por construção. */
  static async markExpiryWarned(deadline) {
    const tenantId = currentTenantId();
    await Subscription.upsertForTenant(tenantId, { expiry_warned_for: asDate(deadline) });
    cache.invalidate();
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
    // A descida agendada (0074) viaja junto porque a tela e o console a
    // mostram ao lado do plano atual — e uma consulta a mais só para quem tem
    // uma, que é quase ninguém.
    const pendingPlan = subscription?.pending_plan_id ? await Plan.findById(subscription.pending_plan_id) : null;
    // O cupom (0093) pela mesma razão: a tela mostra o preço com desconto.
    const coupon = subscription?.coupon_id ? await Coupon.findById(subscription.coupon_id) : null;
    return cache.set({ subscription, plan, pendingPlan, coupon });
  }

  /** Esquece a leitura de UM provedor — a que o console acabou de mudar. */
  static invalidate(tenantId) {
    return runInTenant(tenantId, () => cache.invalidate());
  }

  /**
   * O que o provedor (ou a tela de bloqueio) pode ver da própria assinatura:
   * o estado, o plano e até quando.
   *
   * Sem preço, mas não por o preço ser segredo do console — deixou de ser
   * quando o provedor passou a escolher o próprio plano. O preço mora em
   * `GET /api/tenant/plans` (`SelfBillingService.listPlans`), junto do resto
   * do catálogo, e o valor de fato cobrado mora na cobrança. Este objeto é
   * também o que a porta da assinatura põe no corpo do 402, e ali a pergunta
   * é "por que parei", não "quanto custa".
   */
  static present({ subscription, plan, pendingPlan = null, coupon = null }, opcoes = {}) {
    if (!subscription) return null;
    // O segundo argumento já foi só `now`; continua aceito assim.
    const { now = new Date(), withExemptReason = false } = opcoes instanceof Date ? { now: opcoes } : (opcoes ?? {});
    const effective = this.effectiveStatus(subscription, now);
    return {
      status: effective.status,
      storedStatus: subscription.status,
      reason: effective.reason,
      plan: plan ? {
        code: plan.code,
        name: plan.name,
        limits: this.limitsOf(plan),
        retention: this.retentionCapsOf(plan)
      } : null,
      trialEndsAt: subscription.trial_ends_at ?? null,
      renewsAt: subscription.renews_at ?? null,
      canceledAt: subscription.canceled_at ?? null,
      pendingPlan: this.presentPendingPlan(subscription, pendingPlan),
      coupon: this.presentCoupon(subscription, plan, coupon),
      ...this.presentBillingExempt(subscription, { withReason: withExemptReason })
    };
  }

  // ── Cupom de desconto (0093) ─────────────────────────────────────────

  /**
   * Se o cupom `coupon` vale para a fatura de `plan` desta assinatura.
   *
   * Vale quando é o cupom DA assinatura, ainda tem ciclo (o `forever` não
   * conta ciclo) e o plano está na lista dele, quando ele tem lista. A
   * validade, o teto de resgates e o `active` NÃO entram: são regras do
   * RESGATE. Quem já resgatou fica com o desconto que resgatou — desativar um
   * cupom fecha a porta para os próximos, não tira de quem entrou.
   *
   * O plano conta a cada fatura, e não só na aplicação: a descida para um
   * plano fora da lista faz o cupom parar de valer ali (e voltar a valer se o
   * provedor voltar a um plano da lista, enquanto houver ciclo).
   */
  static couponApplies(subscription, plan, coupon) {
    if (!subscription?.coupon_id || !coupon || !plan) return false;
    if (Number(coupon.id) !== Number(subscription.coupon_id)) return false;
    if (coupon.duration !== 'forever') {
      const restantes = Number(subscription.coupon_cycles_left);
      if (!Number.isFinite(restantes) || restantes <= 0) return false;
    }
    const planos = parseCouponPlanIds(coupon.plan_ids);
    return planos === null || planos.includes(Number(plan.id));
  }

  /**
   * `priceCents` com o desconto de `coupon`, respeitando o piso
   * (`COUPON_FLOOR_CENTS`). Percentual arredonda o DESCONTO para baixo: o
   * centavo que sobra fica com quem cobra, e a conta é a mesma em toda tela.
   */
  static priceWithCoupon(priceCents, coupon) {
    const preco = Math.floor(Number(priceCents));
    if (!Number.isFinite(preco) || preco <= 0) return 0;
    if (!coupon || preco <= COUPON_FLOOR_CENTS) return preco;
    const valor = Math.floor(Number(coupon.value));
    if (!Number.isFinite(valor) || valor <= 0) return preco;
    const desconto = coupon.kind === 'percent' ? Math.floor((preco * valor) / 100) : valor;
    return Math.max(COUPON_FLOOR_CENTS, preco - desconto);
  }

  /**
   * O preço da fatura de `plan` para esta assinatura, com o cupom já lido —
   * a versão síncrona de `effectivePriceCents`, para quem lista muitas
   * assinaturas de uma vez com os cupons em mãos.
   */
  static priceFor(subscription, plan, coupon) {
    const preco = Math.max(0, Math.floor(Number(plan?.price_cents ?? 0)) || 0);
    return this.couponApplies(subscription, plan, coupon) ? this.priceWithCoupon(preco, coupon) : preco;
  }

  /**
   * O preço que a fatura de `plan` vai pedir a esta assinatura: o do plano,
   * com o cupom dela quando ele vale (`couponApplies`), nunca abaixo do piso.
   *
   * É a ÚNICA conta de preço da cobrança: a emissão (`issueCurrent`, inclusive
   * o preço da descida agendada), a reprecificação da fatura em aberto
   * (`reprecificarCobranca`), o "pagar agora" e a conferência do pagamento
   * leem daqui. O valor mudado à mão pelo console numa cobrança (0078) vence
   * isto — quem decide isso é quem lê a cobrança.
   *
   * Assíncrona porque lê o cupom; `{ coupon }` poupa a leitura a quem já o
   * tem (nulo é "sem cupom").
   */
  static async effectivePriceCents(subscription, plan, { coupon } = {}) {
    if (!subscription?.coupon_id) return this.priceFor(subscription, plan, null);
    const cupom = coupon !== undefined ? coupon : await Coupon.findById(subscription.coupon_id);
    return this.priceFor(subscription, plan, cupom);
  }

  /**
   * O cupom como a tela e o console o leem — ou nulo. `priceCents` é o preço
   * que a próxima fatura do plano atual vai pedir; `appliesToPlan` diz se o
   * cupom vale no plano de agora (um cupom restrito a outros planos fica na
   * assinatura, sem desconto, até o provedor voltar a um deles ou ele sair).
   */
  static presentCoupon(subscription, plan, coupon) {
    if (!subscription?.coupon_id || !coupon || Number(coupon.id) !== Number(subscription.coupon_id)) return null;
    const restantes = subscription.coupon_cycles_left;
    return {
      id: Number(coupon.id),
      code: coupon.code,
      kind: coupon.kind,
      value: Number(coupon.value),
      duration: coupon.duration,
      durationCycles: coupon.duration_cycles === null || coupon.duration_cycles === undefined
        ? null : Number(coupon.duration_cycles),
      cyclesLeft: restantes === null || restantes === undefined ? null : Number(restantes),
      planIds: parseCouponPlanIds(coupon.plan_ids),
      appliesToPlan: this.couponApplies(subscription, plan, coupon),
      priceCents: this.priceFor(subscription, plan, coupon),
      appliedAt: isoOf(subscription.coupon_applied_at)
    };
  }

  /**
   * O "isento de cobrança" como a tela e o console o leem: se está, desde
   * quando, e o motivo que o console escreveu. Função própria porque a lista
   * de Assinaturas monta a linha dela à mão, e duas cópias destes três campos
   * seriam duas telas que um dia discordam.
   *
   * O motivo é anotação interna do console ("parceiro", "acordo comercial"):
   * o provedor sabe que está isento, não por que o anotamos. Por isso ele sai
   * NULO por padrão, e só as telas do console o pedem (`withReason`) — quem
   * esquecer de pedir mostra menos, e não o contrário.
   */
  static presentBillingExempt(subscription, { withReason = false } = {}) {
    return {
      billingExempt: Boolean(subscription?.billing_exempt_at),
      billingExemptSince: isoOf(subscription?.billing_exempt_at),
      billingExemptReason: withReason && subscription?.billing_exempt_at
        ? (subscription.billing_exempt_reason ?? null)
        : null
    };
  }

  /**
   * A descida agendada, como a tela e o console a leem — ou nulo.
   *
   * Com o preço, ao contrário do plano atual logo acima: a pergunta que este
   * campo responde é "quanto vou pagar a partir de quando", e sem o número a
   * tela teria de cruzar com o catálogo para dizer uma frase. `blockedBy` não
   * mora aqui: ele depende do uso, que só `usage` conta — é lá que ele entra.
   */
  static presentPendingPlan(subscription, pendingPlan) {
    if (!subscription?.pending_plan_id || !pendingPlan) return null;
    const quando = asDate(subscription.pending_plan_at);
    return {
      id: Number(pendingPlan.id),
      name: pendingPlan.name,
      priceCents: Number(pendingPlan.price_cents ?? 0),
      effectiveAt: quando ? quando.toISOString() : null,
      // Paga pelo preço dela: não se cancela nem se troca mais pela tela.
      locked: this.isPendingLocked(subscription)
    };
  }

  /**
   * O primeiro teto de `limits` que `usage` já passa — ou nulo.
   *
   * Um recurso sem teto, ou sem contagem (a de ONTs falha quando o ACS está
   * fora), não decide nada: dado que não se tem não vira recusa, a mesma regra
   * de `usage`. A ordem é a da tela — operadores, assinantes, ONTs — para que
   * a mesma situação dê sempre a mesma resposta.
   */
  static overLimitFor(limits, usage) {
    for (const resource of ['operators', 'subscribers', 'devices']) {
      const limit = limits?.[resource] ?? null;
      const used = usage?.[resource];
      if (limit === null || used === null || used === undefined) continue;
      if (used > limit) return { resource, used, limit };
    }
    return null;
  }

  /**
   * O que impede o plano `plan` de valer para o provedor em escopo agora, ou
   * nulo — contando só o que o plano limita.
   *
   * É a pergunta que a descida agendada faz ao chegar a hora, e ela é feita
   * pelo agendador a cada minuto enquanto o uso não couber: contar ONTs no ACS
   * a cada minuto para um plano que nem limita ONTs seria carga à toa.
   */
  static async overLimitOf(plan, { countDevices = null } = {}) {
    const limits = this.limitsOf(plan);
    const usage = {};
    if (limits.operators !== null) usage.operators = await this.operatorCount();
    if (limits.subscribers !== null) usage.subscribers = await this.subscriberCount();
    if (limits.devices !== null && typeof countDevices === 'function') {
      try {
        usage.devices = await countDevices();
      } catch {
        usage.devices = null;
      }
    }
    return this.overLimitFor(limits, usage);
  }

  /** Os dias que um pagamento compra neste plano (ou a reserva de trinta). */
  static periodDaysOf(plan) {
    return periodoDoPlano(plan);
  }

  static limitsOf(plan) {
    const asLimit = (value) => (value === null || value === undefined ? null : Number(value));
    return {
      operators: asLimit(plan?.max_operators),
      subscribers: asLimit(plan?.max_subscribers),
      devices: asLimit(plan?.max_devices)
    };
  }

  /**
   * Os tetos de retenção do plano, em dias; `null` é sem teto.
   *
   * `audit` é a trilha de auditoria, `messages` e `media` são o histórico e os
   * anexos do WhatsApp. Separados dos `limits` porque não são contagem de uso
   * — ninguém "passa" de um teto de retenção, o que passa é apagado.
   */
  static retentionCapsOf(plan) {
    const asCap = (value) => {
      const n = Number(value);
      return value === null || value === undefined || !Number.isInteger(n) || n < 1 ? null : n;
    };
    return {
      audit: asCap(plan?.max_audit_retention_days),
      messages: asCap(plan?.max_message_retention_days),
      media: asCap(plan?.max_media_retention_days)
    };
  }

  /** Os tetos do provedor em escopo. Na self-hosted não há plano, e não há teto. */
  static async retentionCaps() {
    if (!IS_SAAS) return this.retentionCapsOf(null);
    const { plan } = await this.current();
    return this.retentionCapsOf(plan);
  }

  /**
   * Os dias que valem, dado o que o provedor escolheu e o teto do plano.
   *
   * Sem teto, é o que o provedor escolheu — inclusive zero, "para sempre". Com
   * teto, o menor dos dois, e "para sempre" vira o teto: guardar para sempre
   * é justamente o que o teto existe para impedir.
   */
  static capRetention(days, cap) {
    const escolhido = Math.trunc(Number(days));
    if (cap === null || cap === undefined) return Number.isFinite(escolhido) && escolhido > 0 ? escolhido : 0;
    if (!Number.isFinite(escolhido) || escolhido <= 0) return cap;
    return Math.min(escolhido, cap);
  }

  /** `capRetention` para o provedor em escopo; `kind` é `audit`, `messages` ou `media`. */
  static async effectiveRetention(kind, days) {
    const caps = await this.retentionCaps();
    return this.capRetention(days, caps[kind] ?? null);
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
    const subscription = this.present(state);
    // A descida agendada que não vai se aplicar enquanto o uso não couber:
    // calculada aqui, com as contagens que esta tela já fez, para a tela
    // avisar ANTES da renovação — e não o provedor descobrir depois que
    // continuou pagando o plano caro porque tinha operadores demais.
    // A travada (paga pelo preço dela) não tem bloqueio: aplica-se na data
    // com o uso que houver.
    if (subscription?.pendingPlan?.locked) {
      subscription.pendingPlan.blockedBy = null;
    } else if (subscription?.pendingPlan) {
      subscription.pendingPlan.blockedBy = this.overLimitFor(
        this.limitsOf(state.pendingPlan), { operators, subscribers, devices }
      );
    }
    return {
      subscription,
      usage: { operators, subscribers, devices },
      limits,
      retention: IS_SAAS ? this.retentionCapsOf(state.plan) : this.retentionCapsOf(null),
      over: {
        operators: over(operators, limits.operators),
        subscribers: over(subscribers, limits.subscribers),
        devices: over(devices, limits.devices)
      }
    };
  }

  // ── Mudanças (chamadas pelo console, no escopo do provedor alvo — e, a
  // troca de plano, também pelo próprio provedor, via `SelfBillingService`,
  // que confere antes o que só vale para quem troca por dentro) ──────────

  /**
   * Troca o plano do provedor em escopo, NA HORA. O status não muda: quem está
   * em `past_due` continua devendo, só que num plano diferente.
   *
   * E apaga a descida agendada, se houver uma: uma troca que vale agora é a
   * última palavra sobre o plano, venha do console ou do provedor (a subida,
   * a descida sem período pago correndo). Deixar a agendada viva faria o
   * plano escolhido agora ser trocado de novo na renovação por uma decisão
   * que a de agora já substituiu.
   */
  static async changePlan({ planId, actorUserId = null, upgradedAt = null }) {
    const tenantId = currentTenantId();
    const plan = await Plan.findById(planId);
    if (!plan) throw new Error('Plan not found');
    const before = await Subscription.forTenant(tenantId);
    const subscription = await Subscription.upsertForTenant(tenantId, {
      plan_id: plan.id,
      pending_plan_id: null,
      pending_plan_at: null,
      pending_plan_locked_at: null,
      // A marca da subida no meio do período pago (0075): quem sobe agora a
      // passa (`SelfBillingService`), e qualquer outra troca — o console, a
      // descida na hora — a apaga, porque o plano de agora não é mais o que
      // subiu sem pagar.
      upgraded_at: upgradedAt,
      ...(before ? {} : { status: 'active' })
    });
    await BillingEvent.record({
      subscriptionId: subscription.id,
      type: BILLING_EVENT_TYPES.PLAN_CHANGED,
      createdBy: actorUserId,
      detail: {
        from: before?.plan_id ?? null,
        to: plan.id,
        toCode: plan.code,
        ...(before?.pending_plan_id ? { pendingCleared: Number(before.pending_plan_id) } : {})
      }
    });
    cache.invalidate();
    return subscription;
  }

  /**
   * Agenda a descida para `at` — o fim do período pago que está correndo.
   *
   * Só a linha e o cache: nenhum evento no extrato, porque nada mudou ainda —
   * o plano, os tetos e o preço deste período são os de antes. O "plano
   * trocado" entra no extrato quando a troca de fato acontece
   * (`applyPendingPlan`), e a trilha de auditoria de quem pediu é do
   * controlador. Uma segunda descida por cima substitui a primeira: é a mesma
   * coluna, e só existe uma renovação por vez.
   */
  static async schedulePlanChange({ planId, at }) {
    const tenantId = currentTenantId();
    const quando = asDate(at);
    if (!quando) throw new Error('A scheduled plan change needs a date');
    const subscription = await Subscription.upsertForTenant(tenantId, {
      pending_plan_id: planId,
      pending_plan_at: quando,
      pending_plan_locked_at: null
    });
    cache.invalidate();
    return subscription;
  }

  /** Desiste da descida agendada: o plano atual segue depois da renovação. */
  static async cancelPendingPlan() {
    const tenantId = currentTenantId();
    const subscription = await Subscription.upsertForTenant(tenantId, {
      pending_plan_id: null,
      pending_plan_at: null,
      pending_plan_locked_at: null
    });
    cache.invalidate();
    return subscription;
  }

  /**
   * Se a descida agendada já foi PAGA pelo preço dela (0075): o período que
   * começa na data da descida teve o pagamento conferido contra o plano
   * novo. Dali em diante ela não se desfaz nem espera o uso caber.
   */
  static isPendingLocked(subscription) {
    return Boolean(subscription?.pending_plan_id && subscription?.pending_plan_locked_at);
  }

  /**
   * Aplica a descida agendada do provedor em escopo, se chegou a hora e se o
   * uso cabe no plano novo.
   *
   * Chamada pelo agendador a cada passada, ANTES da emissão, e por
   * `recordPayment` quando o pagamento abre o período que já é do plano novo.
   * Nunca lança por causa do uso: não caber é o caso esperado de quem pediu a
   * descida e não se ajustou, e a resposta é continuar no plano atual — que é
   * o que ele comporta — com a agendada viva, até caber ou até alguém
   * desistir dela. O aviso sai uma vez por agendamento, e não a cada minuto;
   * a tela mostra o mesmo bloqueio o tempo todo (`pendingPlan.blockedBy`).
   *
   * @returns {Promise<{ applied: boolean, reason?: string, from?: number,
   *   to?: number, blockedBy?: object }>}
   */
  static async applyPendingPlan({ now = new Date(), countDevices = null } = {}) {
    const tenantId = currentTenantId();
    const subscription = await Subscription.forTenant(tenantId);
    if (!subscription?.pending_plan_id) return { applied: false, reason: 'none' };
    const quando = asDate(subscription.pending_plan_at);
    if (quando && quando.getTime() > now.getTime()) return { applied: false, reason: 'not_due' };

    const plano = await Plan.findById(subscription.pending_plan_id);
    if (!plano) {
      // O console não apaga plano, mas um banco mexido à mão pode. Uma
      // agendada para lugar nenhum não tem como se aplicar nunca, e ficaria
      // tentando para sempre: sai, e o provedor fica onde está.
      await this.cancelPendingPlan();
      return { applied: false, reason: 'plan_gone' };
    }

    // Paga pelo preço dela, a descida se aplica na data com o uso que houver:
    // segurá-la porque o uso cresceu DEPOIS de pagar o barato seria entregar
    // o plano caro pelo preço do barato — o buraco que a trava fecha. Acima
    // dos tetos, o provedor só não cresce mais (o 402 de operador, a
    // sincronização que não cria assinante); o que já existe fica.
    const travada = this.isPendingLocked(subscription);
    const blockedBy = travada ? null : await this.overLimitOf(plano, { countDevices });
    if (blockedBy) {
      const marca = `${subscription.pending_plan_id}@${quando ? quando.getTime() : 'now'}`;
      if (avisosDeBloqueio.get(tenantId) !== marca) {
        avisosDeBloqueio.set(tenantId, marca);
        console.warn(
          `Scheduled plan change of provider ${tenantId} to plan ${plano.id} was not applied: `
          + `${blockedBy.used} ${blockedBy.resource} over the limit of ${blockedBy.limit}; it stays pending`
        );
      }
      return { applied: false, reason: 'over_limit', blockedBy };
    }

    const aplicou = await Subscription.applyPendingPlan(tenantId, plano.id);
    if (!aplicou) return { applied: false, reason: 'raced' };
    avisosDeBloqueio.delete(tenantId);
    await BillingEvent.record({
      subscriptionId: subscription.id,
      type: BILLING_EVENT_TYPES.PLAN_CHANGED,
      detail: {
        from: subscription.plan_id ?? null, to: plano.id, toCode: plano.code, scheduled: true,
        ...(travada ? { locked: true } : {})
      }
    });
    cache.invalidate();
    return { applied: true, from: subscription.plan_id ?? null, to: plano.id, locked: travada };
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
    // O prazo mudado junto com o status leva a cobrança em aberto com ele,
    // ANTES de ser gravado — ver `followOpenCharge`.
    if (trialEndsAt !== undefined || renewsAt !== undefined) await followOpenCharge(before, patch);
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
   * Mexe nos PRAZOS do provedor em escopo sem mexer no estado — a cortesia de
   * alguns dias, a data corrigida à mão pelo console.
   *
   * Três formas de pedir, e o controlador garante que venha uma só:
   *
   *   - `extendDays`: soma ao prazo VIVO. Em `trial`, o fim do teste; em
   *     qualquer outro estado, a renovação. Soma a partir do maior entre o
   *     prazo e agora — estender em cinco dias quem venceu há dez não pode
   *     devolver um prazo que continua vencido, e estender quem vence daqui a
   *     vinte não pode jogar fora os vinte.
   *   - `renewsAt` e/ou `trialEndsAt`: a data exata. `trialEndsAt: null` apaga
   *     o prazo do teste; `renewsAt` nulo não é aceito lá em cima, porque
   *     "sem renovação" é assinatura fora de ciclo, e isso é decisão de
   *     status, não de prazo.
   *
   * O status NÃO muda — com uma exceção, a do `past_due` GRAVADO que ganha um
   * prazo no futuro, e que volta a `active` (ver abaixo) —, e é o que separa
   * isto de `setStatus`. Mas o estado que
   * VALE pode mudar, e é o ponto: `effectiveStatus` calcula `past_due` a partir
   * do prazo, então um `active` vencido volta a passar no instante em que o
   * prazo anda — sem ninguém gravar `active` à mão e sem registrar pagamento
   * que não houve.
   *
   * A descida agendada (0074) que estava marcada para o fim do período anda
   * junto com ele: ela quer dizer "na renovação", e deixá-la na data velha a
   * aplicaria no meio do período que a cortesia acabou de esticar. Só quando
   * ela está exatamente na renovação antiga — uma agendada para outra data é
   * outra decisão, e fica como está.
   *
   * A cobrança em aberto do prazo velho vai junto para o novo — no gateway
   * e na linha —, antes de o prazo ser gravado (`followOpenCharge`). Sem
   * isso, a emissão abriria outra para o prazo novo com a primeira ainda viva
   * na Asaas: duas faturas, e o provedor cobrado pela que o painel esqueceu.
   *
   * Uma linha no extrato (`deadline.changed`, com `courtesy: true` quando é
   * uma extensão), porque é o extrato que responde "por que este provedor
   * renovou sem pagar?".
   *
   * @returns {Promise<object>} a assinatura depois da mudança.
   */
  static async setDeadlines({
    renewsAt = undefined, trialEndsAt = undefined, extendDays = null,
    reason = null, actorUserId = null, now = new Date()
  }) {
    const tenantId = currentTenantId();
    const before = await Subscription.forTenant(tenantId);
    if (!before) throw new Error('Subscription not found');

    const patch = {};
    if (extendDays !== null && extendDays !== undefined) {
      const dias = Number(extendDays);
      if (!Number.isInteger(dias) || dias < 1) throw new Error('extendDays must be a positive integer');
      const coluna = before.status === 'trial' ? 'trial_ends_at' : 'renews_at';
      const atual = asDate(before[coluna]);
      const base = atual && atual.getTime() > now.getTime() ? atual : now;
      patch[coluna] = new Date(base.getTime() + dias * DAY_MS);
    } else {
      if (renewsAt !== undefined) {
        const data = asDate(renewsAt);
        if (!data) throw new Error('renewsAt must be a date');
        patch.renews_at = data;
      }
      if (trialEndsAt !== undefined) {
        const data = trialEndsAt === null ? null : asDate(trialEndsAt);
        if (trialEndsAt !== null && !data) throw new Error('trialEndsAt must be a date or null');
        patch.trial_ends_at = data;
      }
    }
    if (!Object.keys(patch).length) throw new Error('Nothing to change');

    // A cortesia a quem está `past_due` GRAVADO (o console o pôs lá à mão)
    // precisa destravá-lo, ou não é cortesia nenhuma: `effectiveStatus` só
    // calcula `past_due` a partir do prazo em `active`, e um `past_due`
    // gravado continua bloqueando escrita com a renovação no ano que vem. Só
    // quando o prazo novo está de fato no futuro — mexer num prazo e deixá-lo
    // vencido não destrava nada, e o status fica como estava.
    if (before.status === 'past_due' && patch.renews_at && patch.renews_at.getTime() > now.getTime()) {
      patch.status = 'active';
    }

    // A cobrança em aberto acompanha o prazo, e ANTES de ele ser gravado: se o
    // gateway recusa, o prazo não se move — ver `followOpenCharge`.
    await followOpenCharge(before, patch, now);

    const renovacaoAntiga = asDate(before.renews_at);
    const agendada = asDate(before.pending_plan_at);
    if (patch.renews_at && before.pending_plan_id && renovacaoAntiga && agendada
      && agendada.getTime() === renovacaoAntiga.getTime()) {
      patch.pending_plan_at = patch.renews_at;
    }

    const iso = (valor) => {
      const data = asDate(valor);
      return data ? data.toISOString() : null;
    };
    const subscription = await getDb().transaction(async (trx) => {
      const depois = await Subscription.upsertForTenant(tenantId, patch, trx);
      await BillingEvent.record({
        subscriptionId: before.id,
        type: BILLING_EVENT_TYPES.DEADLINE_CHANGED,
        createdBy: actorUserId,
        detail: {
          ...(extendDays ? { courtesy: true, extendDays: Number(extendDays) } : {}),
          from: { renewsAt: iso(before.renews_at), trialEndsAt: iso(before.trial_ends_at) },
          to: { renewsAt: iso(depois.renews_at), trialEndsAt: iso(depois.trial_ends_at) },
          status: before.status,
          ...(patch.status ? { statusAfter: patch.status } : {}),
          reason
        }
      }, trx);
      return depois;
    });
    cache.invalidate();
    return subscription;
  }

  /**
   * Liga ou desliga o "isento de cobrança" de um provedor: ativo, sem fatura,
   * até alguém desligar. Chamado pelo console.
   *
   * ## Ligar
   *
   *   - grava `billing_exempt_at` (agora) e o motivo;
   *   - o `past_due` ou `suspended` GRAVADO vira `active` — isentar quem
   *     continua bloqueado não isentaria nada. `trial` fica `trial` na coluna
   *     (e `active` para quem lê: `effectiveStatus`);
   *   - cancela as cobranças em aberto, no gateway e aqui, pelo mesmo gesto do
   *     "cancelar" da tela de Assinaturas (`ChargeIssuingService.cancelOpenCharges`).
   *     A que o gateway recusar fica em aberto e é dita no log: a isenção vale
   *     mesmo assim.
   *
   * A isenção é gravada ANTES de falar com o gateway: a partir dela a emissão
   * para (`issueCurrent` → `billing_exempt`), e o agendador não abre uma
   * cobrança nova no meio do cancelamento das velhas.
   *
   * Só de assinatura viva ou parada por inadimplência (`trial`, `active`,
   * `past_due`, `suspended`); a `canceled` é 409 `not_billable` — o contrato
   * acabou, e não há cobrança de que isentar.
   *
   * ## Desligar
   *
   * Limpa os dois campos, e a cobrança volta pelo plano atual. Se o prazo vivo
   * já passou — ou, num plano pago, não existe —, ganha `LEAD_DAYS` a partir de
   * agora: sem isso o provedor ficaria vencido no mesmo segundo em que a
   * isenção sai, sem ter recebido fatura nenhuma. Com isso a emissão acha o
   * prazo dentro da janela e manda a fatura na próxima passada. O `past_due`
   * gravado com o prazo no futuro volta a `active` (a regra de `setDeadlines`),
   * e a cobrança do período atual que a própria isenção cancelou é reaberta
   * para a emissão (`ChargeIssuingService.reopenExemptCanceled`).
   *
   * ## Uma linha no extrato, e idempotente
   *
   * `billing_exempt.enabled`/`disabled`, sem referência externa (nulos não
   * colidem no índice único). Pedir o estado em que já está não grava nada e
   * responde `alreadyInState: true`.
   *
   * @returns {Promise<{ subscription: object, canceledCharges: number,
   *   alreadyInState: boolean, failedCharges: number[], reopenedCharge: boolean,
   *   statusBefore: string, statusAfter: string }>}
   */
  static async setBillingExempt({
    tenantId, exempt, reason = null, actorUserId = null, now = new Date()
  }) {
    const ligar = Boolean(exempt);
    const motivo = reason === null || reason === undefined ? null : (String(reason).trim().slice(0, 255) || null);
    return runInTenant(tenantId, async () => {
      const before = await Subscription.forTenant(tenantId);
      if (!before) throw new BillingExemptError(404, 'subscription_not_found', 'Subscription not found');
      const jaIsento = Boolean(before.billing_exempt_at);
      const semMudanca = {
        subscription: before,
        canceledCharges: 0,
        failedCharges: [],
        reopenedCharge: false,
        alreadyInState: true,
        statusBefore: before.status,
        statusAfter: before.status
      };
      if (ligar === jaIsento) return semMudanca;
      if (ligar && !ESTADOS_ISENTAVEIS.has(before.status)) {
        throw new BillingExemptError(409, 'not_billable', `A ${before.status} subscription cannot be exempted from billing`);
      }

      const { default: ChargeIssuingService } = await import('./chargeIssuingService.js');
      const patch = {};
      const detalhe = { reason: motivo, statusBefore: before.status };
      if (ligar) {
        patch.billing_exempt_at = aoSegundo(now);
        patch.billing_exempt_reason = motivo;
        if (before.status === 'past_due' || before.status === 'suspended') patch.status = 'active';
      } else {
        patch.billing_exempt_at = null;
        patch.billing_exempt_reason = null;
        detalhe.exemptSince = isoOf(before.billing_exempt_at);
        // O prazo vivo, pela mesma coluna que a cortesia (`setDeadlines`) usa.
        const coluna = before.status === 'trial' ? 'trial_ends_at' : 'renews_at';
        const prazo = asDate(before[coluna]);
        const plano = before.plan_id ? await Plan.findById(before.plan_id) : null;
        const pago = Number(plano?.price_cents ?? 0) > 0;
        const cobravel = before.status !== 'canceled';
        if (cobravel && ((prazo && prazo.getTime() <= now.getTime()) || (!prazo && pago))) {
          patch[coluna] = aoSegundo(new Date(now.getTime() + ChargeIssuingService.LEAD_DAYS * DAY_MS));
          detalhe.deadlineFrom = isoOf(prazo);
          detalhe.deadlineTo = patch[coluna].toISOString();
          detalhe.deadlineColumn = coluna;
          // A descida agendada para a renovação velha anda junto com ela, como
          // na cortesia: ela quer dizer "na renovação".
          const agendada = asDate(before.pending_plan_at);
          if (coluna === 'renews_at' && before.pending_plan_id && prazo && agendada
            && agendada.getTime() === prazo.getTime()) {
            patch.pending_plan_at = patch.renews_at;
          }
        }
        // O `past_due` GRAVADO com o prazo (talvez o de agora mesmo) no futuro
        // volta a `active`, pela mesma regra da cortesia (`setDeadlines`): quem
        // lê o estado não o recalcula a partir do prazo quando o gravado já
        // diz `past_due`, e o provedor sairia da isenção direto para o
        // bloqueio sem ter recebido a fatura do prazo que ainda nem venceu.
        const prazoDepois = coluna === 'renews_at' ? (patch.renews_at ?? prazo) : null;
        if (before.status === 'past_due' && prazoDepois && prazoDepois.getTime() > now.getTime()) {
          patch.status = 'active';
        }
      }
      if (patch.status) detalhe.statusAfter = patch.status;

      const subscription = await getDb().transaction(async (trx) => {
        const depois = await Subscription.upsertForTenant(tenantId, patch, trx);
        await BillingEvent.record({
          subscriptionId: before.id,
          type: ligar ? BILLING_EVENT_TYPES.BILLING_EXEMPT_ENABLED : BILLING_EVENT_TYPES.BILLING_EXEMPT_DISABLED,
          createdBy: actorUserId,
          detail: detalhe
        }, trx);
        return depois;
      });
      cache.invalidate();

      let cancelamento = { canceled: 0, failed: [] };
      let reaberta = false;
      if (ligar) {
        try {
          cancelamento = await ChargeIssuingService.cancelOpenCharges({ now });
        } catch (error) {
          // A isenção já está gravada e vale; o que sobrou em aberto a
          // varredura do agendador cancela (`issueCurrent` → `billing_exempt`).
          console.warn(`Could not cancel the open charges of provider ${tenantId} after exempting it: ${error.message}`);
        }
      } else {
        // A cobrança do período atual que a isenção cancelou volta à emissão:
        // sem isto ela ficaria `canceled`, o agendador responderia
        // `already_settled` e o provedor venceria sem fatura. O período é o do
        // prazo de AGORA (talvez o que acabou de ganhar `LEAD_DAYS`), lido como
        // a emissão o lê.
        const prazoVivo = asDate(subscription?.renews_at ?? subscription?.trial_ends_at);
        if (prazoVivo) {
          try {
            reaberta = await ChargeIssuingService.reopenExemptCanceled(
              ChargeIssuingService.periodKey(prazoVivo), { now }
            );
          } catch (error) {
            console.warn(`Could not reopen the exempted charge of provider ${tenantId}: ${error.message}`);
          }
        }
      }

      return {
        subscription,
        canceledCharges: cancelamento.canceled,
        failedCharges: cancelamento.failed,
        reopenedCharge: reaberta,
        alreadyInState: false,
        statusBefore: before.status,
        statusAfter: subscription?.status ?? before.status
      };
    });
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
    actorUserId = null, periodDays = null, allowUnderpayment = false, now = new Date()
  }) {
    const tenantId = currentTenantId();
    const before = await Subscription.forTenant(tenantId);
    if (!before) throw new Error('Subscription not found');
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount < 0) throw new Error('Amount must be a non-negative integer of cents');

    if (externalId && await BillingEvent.findByExternalId(externalId)) {
      return { subscription: before, duplicate: true };
    }

    // O plano, lido agora e não do cache.
    //
    // `this.current()` traria o plano junto e de graça, e é exatamente o que
    // NÃO serve aqui: aquele cache tem quinze segundos de validade, e uma
    // leitura de quinze segundos atrás não pode decidir por quanto tempo um
    // pagamento vale. Uma consulta a mais por pagamento, e um pagamento é raro.
    //
    // `periodDays` explícito ainda vence o plano: é a saída para um ajuste
    // manual ou uma migração de contrato, e quem o passa está dizendo que sabe
    // mais que o catálogo naquele caso.
    const planoAtual = before.plan_id ? await Plan.findById(before.plan_id) : null;

    // O período que este pagamento compra começa em `base`: no fim do período
    // atual, quando ainda não venceu (pagou adiantado), ou agora (atrasado).
    const currentEnd = asDate(before.renews_at);
    const base = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;

    // A descida agendada (0074) e o período que ela alcança.
    //
    // Se o período comprado começa na data da descida ou depois dela, ele é do
    // plano NOVO: é o preço dele que a cobrança daquele prazo pediu (a emissão
    // já saiu com ele), e é o período dele que o pagamento estende. Conferir
    // contra o plano velho chamaria de "pago a menos" quem pagou exatamente a
    // fatura que recebeu.
    //
    // Aplicar a troca, porém, só quando a data já chegou (`now`): pago
    // adiantado, o provedor ainda está no período do plano caro, que já pagou,
    // e perder os tetos dele antes da hora seria cobrar um e entregar o outro.
    // Nesse caso quem troca é o agendador, quando a data chegar.
    const dataDaDescida = before.pending_plan_id ? asDate(before.pending_plan_at) : null;
    const planoAgendado = before.pending_plan_id && (!dataDaDescida || base.getTime() >= dataDaDescida.getTime())
      ? await Plan.findById(before.pending_plan_id)
      : null;
    // Com a mesma guarda da emissão: se o uso não cabe no plano agendado, a
    // descida não vai se aplicar e a cobrança do prazo saiu (ou foi
    // reprecificada) pelo preço do atual — é contra ele que se confere, QUANDO
    // não há cobrança (a cobrança, havendo, é quem responde: `valorPedido`).
    // As ONTs ficam de fora pela razão de sempre aqui: quem chama é o webhook,
    // sem ACS em mãos — e não precisam entrar, porque o destino da descida
    // abaixo não depende do uso, e sim do preço que foi pago. Contado FORA da
    // transação — no SQLite a transação segura a única conexão, e uma
    // contagem por fora dela esperaria para sempre. A travada não conta nada:
    // já foi paga pelo preço dela.
    const descidaBloqueada = planoAgendado && !this.isPendingLocked(before)
      ? await this.overLimitOf(planoAgendado)
      : null;
    const plano = planoAgendado && !descidaBloqueada ? planoAgendado : planoAtual;
    const dias = periodDays ?? periodoDoPlano(plano);

    // O cupom (0093): o preço que a fatura deste período pediu já tem o
    // desconto, e é contra ele que se confere quando não há cobrança.
    const cupom = before.coupon_id ? await Coupon.findById(before.coupon_id) : null;

    // A conferência do valor, que é o que separa "recebi dinheiro" de "esta
    // conta está paga".
    //
    // Sem ela, um centavo comprava o mesmo período que a fatura inteira: o
    // pagamento virava um interruptor, e o número que ele carrega era enfeite
    // de extrato. Não é um caso de laboratório — a cobrança dos primeiros
    // contratos é criada à mão no painel do gateway, e um valor digitado com um
    // zero a menos passaria como mês pago para sempre, sem uma linha de log.
    //
    // Pagar A MAIS credita: um boleto quitado depois do vencimento chega com
    // juros, e recusar o período de quem pagou mais do que devia seria o
    // absurdo simétrico.
    //
    // Pagar A MENOS não credita, e o dinheiro **não some**: o evento é gravado
    // com a diferença dentro, porque ele de fato aconteceu e o extrato é o que
    // responde "quanto este provedor já nos mandou". O que não anda é
    // `renews_at` — e `past_due` deixa ler e para de deixar escrever, que é
    // onde alguém que pagou a menos deve ficar: visível, avisado e recuperável,
    // não trancado do lado de fora.
    const pedido = await valorPedido({
      externalId, plano, currency, precoDoPlano: this.priceFor(before, plano, cupom)
    });
    const faltou = pedido.cents !== null && amount < pedido.cents;
    const underpaid = faltou && !allowUnderpayment;
    if (pedido.motivo === 'currency_mismatch') {
      // Nem credita errado nem bloqueia por uma condição que quem recebeu o
      // pagamento não tem como consertar: diz em voz alta e segue.
      console.warn(
        `Payment ${externalId ?? '(no reference)'} arrived in ${String(currency).toUpperCase()} `
        + `and the ${pedido.fonte} is priced in another currency: the amount was not checked`
      );
    }

    const patch = {};
    const reactivates = !underpaid
      && (before.status === 'trial' || before.status === 'active' || before.status === 'past_due');

    // O destino da descida agendada, decidido pelo PREÇO que este pagamento
    // pagou pelo período que começa nela — e não pelo uso, que é o que um
    // provedor mexe à vontade depois de pagar:
    //
    //   - pagou o preço de baixo (o que se pediu é menor que o preço do plano
    //     atual): a descida fica TRAVADA (0075). Não se cancela nem se troca
    //     mais, e se aplica na data com o uso que houver — sem isto, pagar o
    //     barato adiantado e desistir da descida depois (ou crescer o uso para
    //     ela não se aplicar) era um mês de plano caro pelo preço do barato.
    //     Se a data já chegou (pagamento atrasado), aplica-se aqui mesmo, na
    //     transação do pagamento, para o período novo nascer no plano novo.
    //   - pagou o preço de cima (a descida estava bloqueada pelo uso e a
    //     cobrança saiu pelo atual): o período é do plano atual, e a descida
    //     vai para a renovação SEGUINTE — tenta de novo lá, pela mesma regra.
    let destinoDaDescida = null;
    if (reactivates && planoAgendado) {
      // Com o cupom, quando ele vale no plano atual: a fatura do atual teria
      // saído com o desconto, e é com ela que a do agendado se compara.
      const precoAtual = this.priceFor(before, planoAtual, cupom);
      // A cobrança com valor mudado à mão pelo console (o desconto) não diz
      // nada sobre QUAL plano foi pago: menos que o preço do atual ali é
      // abatimento, não o preço do barato. Aí vale o plano que a cobrança
      // teria pedido sem o desconto — o agendado, se a descida cabe no uso;
      // o atual, se não cabe —, que é a mesma resposta de quando não há
      // cobrança nenhuma.
      const pagoBarato = pedido.cents !== null && !pedido.overridden
        ? pedido.cents < precoAtual
        : plano === planoAgendado;
      destinoDaDescida = pagoBarato ? 'lock' : 'postpone';
    }
    const descidaVenceu = !dataDaDescida || dataDaDescida.getTime() <= now.getTime();
    const descida = destinoDaDescida === 'lock' && descidaVenceu ? planoAgendado : null;

    if (reactivates) {
      patch.renews_at = new Date(base.getTime() + dias * DAY_MS);
      patch.status = 'active';
      patch.trial_ends_at = null;
      // A subida no meio do período (0075) foi paga: o período que este
      // pagamento compra é cobrado pelo plano de agora.
      patch.upgraded_at = null;
      if (destinoDaDescida === 'lock' && !descida) patch.pending_plan_locked_at = now;
      if (destinoDaDescida === 'postpone') {
        console.warn(
          `Payment for provider ${tenantId} paid the renewal at the current plan's price because the `
          + `scheduled change to plan ${planoAgendado.id} is blocked by usage; it moves to the next renewal`
        );
        patch.pending_plan_at = patch.renews_at;
        patch.pending_plan_locked_at = null;
      }
    }
    const statusAfter = patch.status ?? before.status;
    const renewsAt = patch.renews_at ?? before.renews_at ?? null;

    // O ciclo do cupom que ESTE pagamento gasta: só quando ele estende o
    // período (é a fatura com desconto sendo paga), só nos cupons que contam
    // ciclo, e só se o cupom vale no plano do período pago — a fatura de um
    // plano fora da lista saiu sem desconto, e não gastou nada.
    const gastaCupom = reactivates && cupom && cupom.duration !== 'forever'
      && this.couponApplies(before, plano, cupom);

    try {
      const subscription = await getDb().transaction(async (trx) => {
        // Dentro da transação do evento: a reentrega do mesmo pagamento morre
        // no índice único do evento logo abaixo, e o ciclo gasto aqui volta
        // junto no rollback — o cupom é consumido uma vez por pagamento.
        const consumo = gastaCupom ? await Subscription.consumeCouponCycle(tenantId, cupom.id, trx) : null;
        await BillingEvent.record({
          subscriptionId: before.id,
          type: BILLING_EVENT_TYPES.PAYMENT_RECORDED,
          amountCents: amount,
          currency,
          provider,
          externalId,
          createdBy: actorUserId,
          detail: {
            statusBefore: before.status,
            statusAfter,
            renewsAt,
            // O prazo de ANTES, e quantos dias o plano deu, viajam junto para
            // o estorno (`reversePayment`): desfazer um pagamento é devolver o
            // prazo exatamente o quanto ESTE pagamento o empurrou — e sem o
            // ponto de partida gravado aqui, a única resposta seria o período
            // do plano de hoje, que pode não ser o de quando se pagou.
            renewsBefore: isoOf(before.renews_at),
            ...(reactivates ? { periodDays: dias, planId: plano?.id ?? null } : {}),
            // A trava da descida agendada foi posta POR este pagamento, e
            // QUANDO: o estorno dele a tira, porque o que a pagou voltou — mas
            // só se ela ainda tem este instante (ver `reversePayment`).
            ...(patch.pending_plan_locked_at
              ? { pendingLocked: true, pendingLockedAt: patch.pending_plan_locked_at.toISOString() }
              : {}),
            // O que foi pedido viaja com o evento porque o extrato é o único
            // lugar onde alguém reconstrói, meses depois, por que aquele
            // pagamento não esticou o período.
            expectedCents: pedido.cents,
            ...(pedido.motivo ? { amountCheck: pedido.motivo } : {}),
            ...(underpaid ? { underpaid: true, shortfallCents: pedido.cents - amount } : {}),
            ...(faltou && allowUnderpayment ? { underpaymentAccepted: true } : {}),
            // O ciclo do cupom que este pagamento gastou, para o estorno o
            // devolver (`reversePayment`) — e, se o zerou, o cupom inteiro.
            ...(consumo ? { coupon: { id: Number(cupom.id), code: cupom.code, ...consumo } } : {})
          }
        }, trx);
        // Na mesma transação do pagamento: um período novo que começasse no
        // plano velho porque a troca falhou depois do commit seria exatamente
        // a mistura que a descida agendada existe para não fazer. Condicional
        // (ver `Subscription.applyPendingPlan`): se o agendador aplicou no
        // mesmo minuto, o extrato ganha uma linha de troca, e não duas.
        if (descida && await Subscription.applyPendingPlan(tenantId, descida.id, trx)) {
          await BillingEvent.record({
            subscriptionId: before.id,
            type: BILLING_EVENT_TYPES.PLAN_CHANGED,
            createdBy: actorUserId,
            detail: {
              from: before.plan_id ?? null,
              to: descida.id,
              toCode: descida.code,
              scheduled: true,
              byPayment: true,
              locked: true
            }
          }, trx);
        }
        return Object.keys(patch).length
          ? Subscription.upsertForTenant(tenantId, patch, trx)
          : Subscription.forTenant(tenantId, trx);
      });
      return {
        subscription,
        duplicate: false,
        underpaid,
        expectedCents: pedido.cents,
        paidCents: amount
      };
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

  /**
   * O dinheiro de um pagamento VOLTOU: desfaz o período que ele comprou.
   *
   * Decisão de quem opera o SaaS: o estorno é só o inteiro, e desfaz o período
   * pago. Quando nada mexeu no prazo depois do pagamento, `renews_at` volta
   * EXATAMENTE ao prazo de antes dele; quando algo mexeu (outro pagamento,
   * uma cortesia), volta só o período que ele COMPROU (ver
   * `duracaoCreditada`), e o que os outros deram fica. Se a data que sobra já passou, o provedor é
   * `past_due` pela regra de sempre (`effectiveStatus`), e nenhum `past_due` é
   * gravado aqui: o status da coluna não muda, do mesmo jeito que o prazo que
   * vence sozinho não o muda. Um `trial` que pagou e virou `active` não volta a
   * `trial` — o teste acabou quando ele pagou, e devolver o dinheiro não
   * devolve o teste.
   *
   * Quem chama: o console (o botão de estorno, depois de falar com o gateway) e
   * o webhook (`PAYMENT_REFUNDED`, o estorno feito no painel da Asaas). Os dois
   * no escopo do provedor, e os dois pela referência do PAGAMENTO — a mesma com
   * que ele foi registrado.
   *
   * ## Uma vez só, pela mesma trava do pagamento
   *
   * O estorno do console faz a Asaas mandar `PAYMENT_REFUNDED` do mesmo
   * pagamento, minutos depois, e ele não pode devolver outro período. O evento
   * do estorno é gravado com a referência `<pagamento>:refund`, e é o índice
   * único `(tenant_id, external_id)` que decide — a leitura antes, para a
   * reentrega comum, e a inserção na mesma transação da data, para a corrida.
   * Quem chega depois recebe `duplicate: true` e nada muda.
   *
   * ## O aceite da diferença
   *
   * O pagamento a menos não empurra nada; quem empurra é o aceite
   * (`<referência>:accepted`, ver `PlatformSubscriptionsController`). Então é
   * a conta DELE que se desfaz — e o estorno do pagamento curto sem aceite não
   * devolve dia nenhum, só registra que o dinheiro voltou.
   *
   * ## O que NÃO se desfaz
   *
   * A descida agendada que o pagamento APLICOU (pagou atrasado e o período
   * novo nasceu no plano novo) continua aplicada, e a marca de subida no meio
   * do período que ele apagou continua apagada: trocar o plano de novo é
   * decisão de gente, com o console. A trava da descida que ele PÔS sai — o
   * que a pagou voltou —, mas só se ainda é a MESMA trava: o evento grava o
   * instante em que travou (`pendingLockedAt`), e uma trava posta depois, por
   * outro pagamento, tem outro instante e fica. A descida marcada para a
   * renovação anda junto com ela, como na cortesia (`setDeadlines`).
   *
   * @returns {Promise<{ subscription: object, duplicate: boolean, found: boolean,
   *   renewsAtBefore: string|null, renewsAtAfter: string|null, basis: string|null }>}
   */
  static async reversePayment({
    externalId, reason = null, actorUserId = null, source = 'console'
  }) {
    const tenantId = currentTenantId();
    const referencia = String(externalId ?? '').trim();
    if (!referencia) throw new Error('A refund needs the payment reference');
    const before = await Subscription.forTenant(tenantId);
    if (!before) throw new Error('Subscription not found');
    const referenciaDoEstorno = `${referencia}:refund`;
    const intacta = (extra) => ({
      subscription: before,
      renewsAtBefore: isoOf(before.renews_at),
      renewsAtAfter: isoOf(before.renews_at),
      basis: null,
      ...extra
    });
    // O estorno que já aconteceu responde com as datas DELE — as que o
    // primeiro a gravar moveu —, e não com o prazo de agora repetido nos dois
    // campos: quem chega depois (o botão do console que perdeu a corrida para
    // o próprio webhook) precisa dizer na tela e na trilha o que de fato
    // mudou.
    const jaFeito = async (marca) => {
      const agora = await Subscription.forTenant(tenantId);
      const lido = detalheDe(marca);
      return {
        subscription: agora,
        duplicate: true,
        found: true,
        renewsAtBefore: lido && 'renewsBefore' in lido ? lido.renewsBefore : isoOf(agora?.renews_at),
        renewsAtAfter: lido && 'renewsAt' in lido ? lido.renewsAt : isoOf(agora?.renews_at),
        basis: lido?.basis ?? null
      };
    };

    const marcaAnterior = await BillingEvent.findByExternalId(referenciaDoEstorno);
    if (marcaAnterior) return jaFeito(marcaAnterior);

    // O pagamento que se estorna. Sem ele não há período a desfazer — e nem
    // marca a gravar: um estorno de algo que o extrato não conhece (a
    // cobrança criada à mão no gateway e nunca creditada aqui) não tem o que
    // travar contra a segunda vez.
    const pagamento = await BillingEvent.findByExternalId(referencia);
    if (!pagamento || pagamento.type !== BILLING_EVENT_TYPES.PAYMENT_RECORDED) {
      return intacta({ duplicate: false, found: false });
    }
    const detalhe = detalheDe(pagamento);
    let quemEstendeu = detalhe;
    if (detalhe?.underpaid) {
      const aceite = await BillingEvent.findByExternalId(`${referencia}:accepted`);
      quemEstendeu = aceite?.type === BILLING_EVENT_TYPES.PAYMENT_RECORDED ? detalheDe(aceite) : null;
    }
    const planoAtual = before.plan_id ? await Plan.findById(before.plan_id) : null;
    const credito = await duracaoCreditada(quemEstendeu, planoAtual);
    const { ms, from, to } = credito;
    let { basis } = credito;

    const patch = {};
    const prazo = asDate(before.renews_at);
    if (ms > 0 && prazo) {
      // O caso comum — nada mexeu no prazo depois deste pagamento — volta
      // EXATAMENTE ao prazo de antes, sem conta: a subtração carregaria o
      // arredondamento do MySQL (que guarda ao segundo) para a data. Com
      // outra coisa no meio (outro pagamento, uma cortesia), subtrai-se o que
      // este deu, e o resto fica.
      const intocado = from && to && Math.abs(prazo.getTime() - to.getTime()) < 1000;
      patch.renews_at = intocado ? new Date(from.getTime()) : new Date(prazo.getTime() - ms);
      if (intocado) basis = 'restored';
      const agendada = asDate(before.pending_plan_at);
      if (before.pending_plan_id && agendada && agendada.getTime() === prazo.getTime()) {
        patch.pending_plan_at = patch.renews_at;
      }
    } else if (ms > 0) {
      // Sem prazo para voltar: alguém tirou a assinatura do ciclo depois do
      // pagamento. Não há de onde subtrair — dito em voz alta, e o estorno
      // segue registrado.
      console.warn(`Refund of payment ${referencia} for provider ${tenantId}: the subscription has no renewal date to roll back`);
    }
    // A trava só sai se é a que ESTE pagamento pôs — o mesmo instante, com a
    // folga do segundo que o MySQL arredonda. Evento antigo, sem o instante
    // gravado, não destrava nada: sem como provar de quem é a trava, ela fica.
    const travouEm = asDate(quemEstendeu?.pendingLockedAt);
    const travaAtual = asDate(before.pending_plan_locked_at);
    if (travouEm && travaAtual && Math.abs(travouEm.getTime() - travaAtual.getTime()) < 1000) {
      patch.pending_plan_locked_at = null;
    }

    try {
      const subscription = await getDb().transaction(async (trx) => {
        // O ciclo do cupom que o pagamento gastou volta com o dinheiro — na
        // mesma transação da marca do estorno, então o segundo estorno do
        // mesmo pagamento (o webhook depois do console) não devolve outro.
        const gastou = quemEstendeu?.coupon?.id ? quemEstendeu.coupon : null;
        const devolucao = gastou ? await Subscription.restoreCouponCycle(tenantId, gastou, trx) : null;
        await BillingEvent.record({
          subscriptionId: before.id,
          type: BILLING_EVENT_TYPES.PAYMENT_REFUNDED,
          amountCents: pagamento.amount_cents === null || pagamento.amount_cents === undefined
            ? null : Number(pagamento.amount_cents),
          currency: pagamento.currency,
          provider: pagamento.provider || 'manual',
          externalId: referenciaDoEstorno,
          createdBy: actorUserId,
          detail: {
            reference: referencia,
            source: source === 'webhook' ? 'webhook' : 'console',
            reason: reason ? String(reason).slice(0, 255) : null,
            status: before.status,
            renewsBefore: isoOf(before.renews_at),
            renewsAt: patch.renews_at ? patch.renews_at.toISOString() : isoOf(before.renews_at),
            reversedDays: patch.renews_at && prazo
              ? Math.round(((prazo.getTime() - patch.renews_at.getTime()) / DAY_MS) * 1000) / 1000
              : 0,
            basis,
            ...(patch.pending_plan_locked_at === null ? { pendingUnlocked: true } : {}),
            ...(devolucao ? { couponRestored: { id: Number(gastou.id), code: gastou.code ?? null, ...devolucao } } : {})
          }
        }, trx);
        return Object.keys(patch).length
          ? Subscription.upsertForTenant(tenantId, patch, trx)
          : Subscription.forTenant(tenantId, trx);
      });
      return {
        subscription,
        duplicate: false,
        found: true,
        renewsAtBefore: isoOf(before.renews_at),
        renewsAtAfter: isoOf(subscription?.renews_at),
        basis
      };
    } catch (error) {
      // A corrida: o console e o webhook estornando o mesmo pagamento ao mesmo
      // tempo. Quem gravou primeiro desfez o período; este não desfaz outro.
      if (isUniqueViolation(error)) {
        return jaFeito(await BillingEvent.findByExternalId(referenciaDoEstorno));
      }
      throw error;
    } finally {
      cache.invalidate();
    }
  }
}

export default SubscriptionService;
