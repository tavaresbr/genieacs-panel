import Addon, { ADDON_KINDS, ADDON_LIMIT_RESOURCES, normalizeAddonCode } from '../models/Addon.js';
import TenantAddon from '../models/TenantAddon.js';
import Subscription from '../models/Subscription.js';
import Plan from '../models/Plan.js';
import Tenant from '../models/Tenant.js';
import BillingCharge from '../models/BillingCharge.js';
import { TenantCache } from '../config/tenantCache.js';
import { currentTenantId, runInTenant } from '../config/tenantContext.js';
import { isUniqueViolation } from '../config/database.js';
import { TranslatableError } from '../i18n/index.js';
import SubscriptionService, { isBillableStatus } from './subscriptionService.js';

/**
 * Os add-ons pagos (0127): recursos (WhatsApp, IA) e aumentos de teto que o
 * provedor contrata por cima do plano.
 *
 * ## O que este arquivo decide
 *
 *   - **O direito** (`entitlements`): os recursos e os tetos a mais que as
 *     linhas VIVAS do provedor dão — ativas, e com o cancelamento agendado
 *     ainda no futuro. Guardado quinze segundos por provedor, como a
 *     assinatura; quem muda uma linha chama `invalidate`.
 *   - **A porta** (`refusalFor`, usada por `requireAddon`): só recusa quando o
 *     catálogo tem um add-on ATIVO e `gated` para aquela chave. Sem isso o
 *     recurso continua de todo mundo, como era — vender o add-on não tira
 *     nada de quem já usa. A caixa da plataforma passa sempre; quem está em
 *     teste passa quando o add-on diz `trial_access`.
 *   - **A cobrança recorrente** (`renewalItems`): cada add-on vivo e pago vira
 *     uma linha `addons: [{ code, name, cents }]` na conta da renovação
 *     (`pricing_detail`), somada ao preço do plano DEPOIS do cupom — o cupom
 *     vale só sobre o plano. No ciclo anual, o preço anual do add-on, ou doze
 *     vezes o mensal quando ele não tem um. O add-on com cancelamento agendado
 *     para o início do período que a fatura paga já não entra nela.
 *   - **A pró-rata da ativação** (`prorationQuote`): ativar no meio de um
 *     período pago cobra na hora `⌈preço × restante ÷ período⌉`, numa fatura
 *     avulsa (`kind = 'addon'`) com chave própria
 *     (`BillingCharge.addonProrationKey`). Abaixo do mínimo da pró-rata
 *     (`PRORATION_MIN_CENTS`) não sai fatura. Em teste, atrasado ou sem
 *     período pago, nada na hora — a primeira renovação já o cobra.
 *   - **O cancelamento vale na renovação**: `cancel_at` é o fim do período
 *     pago; até lá o add-on vale, e a fatura que começa ali sai sem ele.
 *     Reativar antes disso só apaga o `cancel_at` — sem cobrar de novo.
 *
 * A fatura em aberto da renovação que JÁ saiu acompanha a mudança pela porta
 * da troca de plano (`SelfBillingService.repriceAround`): cancelada no
 * gateway ANTES de a linha do add-on ser gravada (a falha para tudo, e nada
 * muda), e reemitida depois com o valor novo.
 */

/** Quanto vale a leitura do direito de um provedor, e a do catálogo. */
const CACHE_TTL_MS = 15_000;
const cache = new TenantCache(CACHE_TTL_MS);
let catalogo = { value: null, expiresAt: 0 };

/** Os estados da assinatura em que o provedor ainda mexe nos próprios add-ons. */
const ESTADOS_VIVOS = new Set(['trial', 'active', 'past_due']);

const DAY_S = 86_400;

/** Quantas vezes, e com que espera, a mudança tenta de novo a garra da fatura. */
const REPRICE_RETRIES = 6;
const REPRICE_RETRY_MS = 150;

/** Uma recusa com o código que a tela lê e o status HTTP. */
export class AddonError extends TranslatableError {
  constructor(key, { code, status, vars = null, detail = null } = {}) {
    super(key, vars, { code, status });
    this.name = 'AddonError';
    this.detail = detail;
  }
}

function asDate(value) {
  if (!value) return null;
  const data = value instanceof Date ? value : new Date(value);
  return Number.isNaN(data.getTime()) ? null : data;
}

function isoOf(value) {
  const data = asDate(value);
  return data ? data.toISOString() : null;
}

/** Se a linha vale agora: ativa, e com o cancelamento agendado (se há) ainda no futuro. */
export function isLive(row, now = new Date()) {
  if (!row || row.status !== 'active') return false;
  const fim = asDate(row.cancel_at);
  return !fim || fim.getTime() > now.getTime();
}

/** O preço de UM período do ciclo — o anual, ou doze vezes o mensal quando ele não tem um. */
export function addonCyclePriceCents(addon, cycle = 'monthly') {
  const mensal = Math.max(0, Math.floor(Number(addon?.price_cents ?? 0)) || 0);
  if (cycle !== 'annual') return mensal;
  const anual = Number(addon?.price_yearly_cents);
  if (addon?.price_yearly_cents !== null && addon?.price_yearly_cents !== undefined
    && Number.isInteger(anual) && anual > 0) {
    return anual;
  }
  return mensal * 12;
}

/**
 * As linhas recorrentes de add-on de UMA fatura de renovação — pura: quem
 * emite, quem reprecifica e o teste fazem a mesma conta.
 *
 * `rows` são as linhas de `tenant_addons` do provedor; `catalog`, o catálogo
 * por id; `periodKey`, a chave do período que a fatura paga (o dia em que ele
 * começa); `keyOf`, a função que dá a chave de um instante no fuso da
 * cobrança. Fica de fora a linha cancelada, a dada de graça pelo console, a
 * de preço zero e a que tem cancelamento agendado para o início deste
 * período ou antes.
 *
 * @returns {Array<{ code: string, name: string, cents: number }>}
 */
export function renewalItemsFor({ rows, catalog, cycle = 'monthly', periodKey, keyOf }) {
  const itens = [];
  // Uma linha viva por add-on (o índice único); a lista de DEPOIS montada por
  // quem reprecifica pode trazer a mesma duas vezes numa corrida — conta uma.
  const vistos = new Set();
  for (const linha of rows ?? []) {
    if (!linha || linha.status !== 'active' || linha.free) continue;
    if (vistos.has(Number(linha.addon_id))) continue;
    vistos.add(Number(linha.addon_id));
    const addon = catalog.get(Number(linha.addon_id));
    if (!addon) continue;
    const fim = asDate(linha.cancel_at);
    if (fim && periodKey && keyOf(fim) <= String(periodKey).slice(0, 10)) continue;
    const cents = addonCyclePriceCents(addon, cycle);
    if (!(cents > 0)) continue;
    itens.push({ code: addon.code, name: addon.name, cents, sort: Number(addon.sort ?? 0), id: Number(addon.id) });
  }
  itens.sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
  return itens.map(({ code, name, cents }) => ({ code, name, cents }));
}

/** O add-on como a tela do provedor e o console o leem. */
export function presentAddon(addon) {
  return {
    id: Number(addon.id),
    code: addon.code,
    name: addon.name,
    description: addon.description ?? null,
    priceCents: Math.max(0, Number(addon.price_cents ?? 0)),
    priceYearlyCents: addon.price_yearly_cents === null || addon.price_yearly_cents === undefined
      ? null : Number(addon.price_yearly_cents),
    currency: addon.currency || 'BRL',
    kind: addon.kind,
    feature: addon.feature ?? null,
    limitResource: addon.limit_resource ?? null,
    limitAmount: addon.limit_amount === null || addon.limit_amount === undefined ? null : Number(addon.limit_amount),
    gated: Boolean(addon.gated),
    trialAccess: Boolean(addon.trial_access),
    active: Boolean(addon.active),
    public: Boolean(addon.public),
    sort: Number(addon.sort ?? 0)
  };
}

/** Uma linha de `tenant_addons` como a tela a lê. */
export function presentTenantAddon(row, addon = null, now = new Date()) {
  return {
    id: Number(row.id),
    addonId: Number(row.addon_id),
    code: addon?.code ?? null,
    name: addon?.name ?? null,
    status: row.status,
    live: isLive(row, now),
    free: Boolean(row.free),
    source: row.source ?? null,
    reason: row.reason ?? null,
    startedAt: isoOf(row.started_at),
    cancelAt: isoOf(row.cancel_at),
    canceledAt: isoOf(row.canceled_at)
  };
}

class AddonService {
  /** O mínimo da pró-rata, o mesmo da subida de plano (o piso do gateway). */
  static get PRORATION_MIN_CENTS() {
    return SubscriptionService.PRORATION_MIN_CENTS;
  }

  // ── O catálogo ───────────────────────────────────────────────────────

  /** O catálogo inteiro, guardado quinze segundos — para a porta e o direito, nunca para cobrar. */
  static async cachedCatalog() {
    if (catalogo.value && catalogo.expiresAt > Date.now()) return catalogo.value;
    const linhas = await Addon.list();
    catalogo = { value: linhas, expiresAt: Date.now() + CACHE_TTL_MS };
    return linhas;
  }

  /** Esquece o catálogo guardado — o console acabou de mudá-lo — e o direito de todos. */
  static invalidateCatalog() {
    catalogo = { value: null, expiresAt: 0 };
    cache.clear();
  }

  /** Esquece o direito de UM provedor. */
  static invalidate(tenantId = null) {
    if (tenantId === null || tenantId === undefined) {
      cache.invalidate();
      return;
    }
    runInTenant(tenantId, () => cache.invalidate());
  }

  /**
   * Os add-ons ativos e `gated` do catálogo para a chave `feature` — vazio
   * quando o recurso não exige add-on (o padrão).
   */
  static async gatesFor(feature) {
    const chave = String(feature ?? '');
    return (await this.cachedCatalog()).filter((addon) => addon.active && addon.gated
      && addon.kind === 'feature' && addon.feature === chave);
  }

  // ── O direito ────────────────────────────────────────────────────────

  /**
   * O que os add-ons vivos dão ao provedor (o em escopo, ou `tenantId`):
   * `{ features: string[], limits: { operators, subscribers, devices }, codes }`
   * — os `limits` são o que se SOMA aos tetos do plano.
   */
  static async entitlements(tenantId = null, { now = new Date() } = {}) {
    const ler = async () => {
      const guardado = cache.get();
      if (guardado) return guardado;
      const linhas = await TenantAddon.listActive();
      const porId = new Map((await this.cachedCatalog()).map((addon) => [Number(addon.id), addon]));
      const features = new Set();
      const limits = { operators: 0, subscribers: 0, devices: 0 };
      const codes = [];
      for (const linha of linhas) {
        if (!isLive(linha, now)) continue;
        const addon = porId.get(Number(linha.addon_id));
        if (!addon) continue;
        codes.push(addon.code);
        if (addon.kind === 'feature' && addon.feature) features.add(addon.feature);
        const quanto = Math.floor(Number(addon.limit_amount ?? 0));
        if (addon.kind === 'limit' && ADDON_LIMIT_RESOURCES.includes(addon.limit_resource) && quanto > 0) {
          limits[addon.limit_resource] += quanto;
        }
      }
      return cache.set({ features: [...features], limits, codes });
    };
    return tenantId === null || tenantId === undefined ? ler() : runInTenant(tenantId, ler);
  }

  /**
   * Os tetos de `plan` com o que os add-ons de limite somam — `limitsOf` do
   * plano, mais o bônus onde o plano TEM teto (sem teto continua sem teto).
   */
  static applyLimitBonus(limits, bonus) {
    const saida = { ...limits };
    for (const recurso of ADDON_LIMIT_RESOURCES) {
      if (saida[recurso] === null || saida[recurso] === undefined) continue;
      saida[recurso] += Math.max(0, Number(bonus?.[recurso] ?? 0));
    }
    return saida;
  }

  /** O bônus de teto do provedor em escopo; zero em tudo quando a leitura falha. */
  static async limitBonus() {
    try {
      return (await this.entitlements()).limits;
    } catch (error) {
      console.warn(`Could not read the add-on limits of provider ${currentTenantId()}: ${error.message}`);
      return { operators: 0, subscribers: 0, devices: 0 };
    }
  }

  /**
   * Por que o provedor em escopo NÃO pode usar o recurso `feature` — ou nulo.
   * Ver o topo do arquivo: sem add-on `gated` no catálogo, nunca recusa.
   */
  static async refusalFor(feature, { now = new Date() } = {}) {
    const portas = await this.gatesFor(feature);
    if (!portas.length) return null;
    const tenantId = currentTenantId();
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || tenant.kind === 'platform') return null;
    const direito = await this.entitlements(null, { now });
    if (direito.features.includes(feature)) return null;
    const { subscription } = await SubscriptionService.current();
    // Isento de cobrança (o parceiro, a conta de demonstração): não há fatura
    // onde o add-on entraria, então a porta não o cobra dele.
    if (subscription?.billing_exempt_at) return null;
    if (portas.some((addon) => addon.trial_access)) {
      if (subscription && SubscriptionService.effectiveStatus(subscription, now).status === 'trial') return null;
    }
    return { feature, addons: portas.map((addon) => addon.code) };
  }

  /**
   * A porta nos caminhos de FUNDO (o bot, a IA, as campanhas, a régua, o
   * alerta por WhatsApp): se o provedor em escopo pode usar `feature`. Sem
   * add-on `gated` no catálogo responde sim sem consulta (o padrão). Uma
   * falha na leitura também responde sim — no fundo, ficar mudo por um erro
   * de banco seria pior que mandar uma mensagem que o add-on cobraria.
   */
  static async allows(feature, { now = new Date() } = {}) {
    try {
      return !(await this.refusalFor(feature, { now }));
    } catch (error) {
      console.warn(`Could not check the add-on "${feature}" of provider ${currentTenantId()}: ${error.message}`);
      return true;
    }
  }

  // ── A cobrança ───────────────────────────────────────────────────────

  /** A chave de período de um instante, no fuso da cobrança (`ChargeIssuingService.periodKey`). */
  static async keyOf() {
    const { default: ChargeIssuingService } = await import('./chargeIssuingService.js');
    return (instante) => ChargeIssuingService.periodKey(instante);
  }

  /**
   * As linhas de add-on da fatura de renovação do período `periodKey` do
   * provedor em escopo, pelo ciclo de `subscription` em `plan`. Lidas do banco
   * agora, sem cache — é dinheiro. `rows` troca as linhas lidas pelas de
   * DEPOIS de uma mudança ainda não gravada (`repriceAround`).
   */
  static async renewalItems({ subscription, plan, periodKey, rows = undefined }) {
    if (!periodKey) return [];
    const linhas = rows ?? await TenantAddon.listActive();
    if (!linhas.length) return [];
    const catalog = new Map((await Addon.list()).map((addon) => [Number(addon.id), addon]));
    return renewalItemsFor({
      rows: linhas,
      catalog,
      cycle: SubscriptionService.cycleOf(subscription, plan),
      periodKey,
      keyOf: await this.keyOf()
    });
  }

  /**
   * Quanto a ATIVAÇÃO de `addon` cobra agora: `⌈preço do ciclo × segundos
   * restantes ÷ segundos do período⌉`, o mesmo desenho de
   * `SubscriptionService.prorationQuote`. Pura e síncrona — a tela mostra o
   * valor antes do clique e a ativação cobra o mesmo.
   */
  static prorationQuote(subscription, plan, addon, now = new Date()) {
    const nada = { eligible: false, amountCents: 0 };
    if (!subscription || !addon) return nada;
    if (subscription.status !== 'active' || subscription.billing_exempt_at) return nada;
    const renovacao = asDate(subscription.renews_at);
    if (!renovacao || renovacao.getTime() <= now.getTime()) return nada;
    const ciclo = SubscriptionService.cycleOf(subscription, plan);
    const preco = addonCyclePriceCents(addon, ciclo);
    if (!(preco > 0)) return nada;
    const dias = SubscriptionService.cyclePeriodDays(subscription, plan);
    const periodoS = dias * DAY_S;
    const restantesS = Math.floor((renovacao.getTime() - now.getTime()) / 1000);
    const numerador = BigInt(preco) * BigInt(restantesS);
    const denominador = BigInt(periodoS);
    const valor = Number((numerador + denominador - 1n) / denominador);
    const quote = {
      eligible: true,
      amountCents: valor,
      addonId: Number(addon.id),
      addonCode: addon.code,
      addonName: addon.name,
      priceCents: preco,
      remainingSeconds: restantesS,
      periodSeconds: periodoS,
      remainingDays: Math.ceil(restantesS / DAY_S),
      renewsAt: renovacao.toISOString(),
      currency: String(addon.currency || plan?.currency || 'BRL').toUpperCase(),
      billingCycle: ciclo
    };
    if (valor < this.PRORATION_MIN_CENTS) return { ...quote, skipped: 'below_minimum' };
    return quote;
  }

  // ── A tela do provedor ───────────────────────────────────────────────

  /**
   * O catálogo público e o que o provedor em escopo tem: cada cartão com o
   * preço dos dois ciclos, o estado dele aqui e a prévia da pró-rata.
   */
  static async listForTenant({ now = new Date() } = {}) {
    await TenantAddon.finalizeDue(now);
    const subscription = await Subscription.forTenant(currentTenantId());
    const plan = subscription?.plan_id ? await Plan.findById(subscription.plan_id) : null;
    const ciclo = SubscriptionService.cycleOf(subscription, plan);
    const linhas = await TenantAddon.listActive();
    const porAddon = new Map(linhas.map((linha) => [Number(linha.addon_id), linha]));
    const catalogo = await Addon.list();
    const visiveis = catalogo.filter((addon) => (addon.active && addon.public) || porAddon.has(Number(addon.id)));
    return {
      billingCycle: ciclo,
      addons: visiveis.map((addon) => {
        const linha = porAddon.get(Number(addon.id)) ?? null;
        const quote = linha ? null : this.prorationQuote(subscription, plan, addon, now);
        return {
          ...presentAddon(addon),
          // O preço recorrente que a fatura vai pedir, no ciclo de agora.
          cycleCents: addonCyclePriceCents(addon, ciclo),
          subscription: linha ? presentTenantAddon(linha, addon, now) : null,
          // O que ativar cobraria AGORA, ou nulo (não cobra nada na hora).
          proration: quote?.eligible
            ? { amountCents: quote.skipped ? 0 : quote.amountCents, remainingDays: quote.remainingDays, ...(quote.skipped ? { skipped: quote.skipped } : {}) }
            : null,
          // Se dá para ativar: à venda, e não o tem.
          available: Boolean(addon.active && addon.public && !linha)
        };
      })
    };
  }

  /** A assinatura do provedor em escopo, conferida para uma mudança feita por ele. */
  static async assinaturaViva() {
    const tenant = await Tenant.findById(currentTenantId());
    if (!tenant || tenant.kind === 'platform') {
      throw new AddonError('addons.notChangeable', { code: 'not_changeable', status: 409 });
    }
    const subscription = await Subscription.forTenant(tenant.id);
    if (!subscription || !ESTADOS_VIVOS.has(subscription.status)) {
      throw new AddonError('addons.notChangeable', { code: 'not_changeable', status: 409 });
    }
    return { tenant, subscription };
  }

  /**
   * Grava `escrever` com a fatura em aberto da renovação posta no valor de
   * DEPOIS (`rowsAfter`) — a porta da troca de plano. A falha do gateway ao
   * cancelar a fatura velha lança e nada é gravado.
   *
   * `rowsAfter` é uma FUNÇÃO das linhas ativas (`(atuais) => depois`): a
   * reprecificação a aplica de novo às linhas relidas depois de tomar a garra
   * da fatura, e por isso duas ativações ao mesmo tempo (WhatsApp e IA) saem
   * as duas na renovação. Quem chega com a garra tomada pela outra (`busy`)
   * espera um pouco e tenta de novo, antes de gravar nada.
   */
  static async withReprice({ tenant, subscription, rowsAfter, escrever }) {
    const { default: SelfBillingService } = await import('./selfBillingService.js');
    for (let tentativa = 0; ; tentativa += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop -- só repete quando a garra é de outro
        return await SelfBillingService.repriceAround({ depois: subscription, tenant, escrever, addonRows: rowsAfter });
      } catch (error) {
        if (error?.code !== 'busy' || tentativa >= REPRICE_RETRIES) throw error;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, REPRICE_RETRY_MS * (tentativa + 1)); });
      }
    }
  }

  /**
   * Ativa o add-on `code` no provedor em escopo, a pedido dele.
   *
   * Idempotente: o add-on já ativo devolve `already: true` sem cobrar nada; o
   * com cancelamento agendado é REATIVADO (o `cancel_at` some, sem cobrar de
   * novo — o período já estava pago). O duplo clique perde no índice único e
   * vira `already`. A pró-rata sai DEPOIS de a linha estar gravada, e a falha
   * do gateway nela não desfaz a ativação (a linha fica para o agendador,
   * como a da subida).
   *
   * Recusas: código desconhecido, inativo ou fora da vitrine (404
   * `addon_not_found`); assinatura parada ou da plataforma (409
   * `not_changeable`); plano de graça (409 `paid_plan_required` — a fatura
   * do add-on não sairia nunca).
   */
  static async activate({ code, actorUserId = null, now = new Date() }) {
    const addon = await Addon.findByCode(normalizeAddonCode(code));
    if (!addon || !addon.active || !addon.public) {
      throw new AddonError('addons.notFound', { code: 'addon_not_found', status: 404 });
    }
    const { tenant, subscription } = await this.assinaturaViva();
    await TenantAddon.finalizeDue(now);
    const existente = await TenantAddon.activeFor(addon.id);
    if (existente && !existente.cancel_at) {
      return { addon, already: true, row: existente, proration: null, charge: 'none' };
    }
    const plan = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;

    if (existente) {
      // A reativação antes da renovação: o período já está pago com ele.
      const depois = (linhas) => linhas.map((linha) => (Number(linha.id) === Number(existente.id) ? { ...linha, cancel_at: null } : linha));
      const { charge, reissue } = await this.withReprice({
        tenant,
        subscription,
        rowsAfter: depois,
        escrever: () => TenantAddon.update(existente.id, { cancel_at: null, canceled_by: null })
      });
      this.invalidate(tenant.id);
      return {
        addon, reactivated: true, row: await TenantAddon.findById(existente.id), proration: null, charge, ...(reissue ? { reissue } : {})
      };
    }

    if (!(SubscriptionService.cyclePriceCents(subscription, plan) > 0)) {
      throw new AddonError('addons.paidPlanRequired', { code: 'paid_plan_required', status: 409 });
    }

    // A linha nova como vai ficar, para a fatura em aberto ser reprecificada
    // antes de ela existir.
    const nova = {
      id: 0, addon_id: addon.id, status: 'active', active_key: addon.id, free: false, cancel_at: null
    };
    let rowId = null;
    let perdeu = false;
    const resultado = await this.withReprice({
      tenant,
      subscription,
      // Sem a própria linha, se ela já estiver lá (a repetição da garra
      // depois de gravar não acontece, mas a conta não pode contá-la duas
      // vezes — `renewalItemsFor` também deduplica).
      rowsAfter: (linhas) => [...linhas.filter((linha) => Number(linha.addon_id) !== Number(addon.id)), nova],
      escrever: async () => {
        try {
          rowId = await TenantAddon.insertActive({ addonId: addon.id, startedAt: now, createdBy: actorUserId });
        } catch (error) {
          // O outro clique ganhou: a linha dele é a do add-on, e esta passada
          // não cobra nada.
          if (!isUniqueViolation(error)) throw error;
          perdeu = true;
        }
      }
    });
    this.invalidate(tenant.id);
    if (perdeu) {
      return { addon, already: true, row: await TenantAddon.activeFor(addon.id), proration: null, charge: resultado.charge };
    }

    const quote = this.prorationQuote(subscription, plan, addon, now);
    const proration = await this.cobrarProrata({ tenant, subscription, quote, now });
    return {
      addon,
      activated: true,
      row: await TenantAddon.findById(rowId),
      proration,
      charge: resultado.charge,
      ...(resultado.reissue ? { reissue: resultado.reissue } : {})
    };
  }

  /** A fatura de pró-rata da ativação — melhor esforço, como a da subida. */
  static async cobrarProrata({ tenant, subscription, quote, now }) {
    if (!quote?.eligible) return null;
    const resumo = { amountCents: quote.amountCents, remainingDays: quote.remainingDays, currency: quote.currency };
    if (quote.skipped) return { ...resumo, issued: false, skipped: quote.skipped };
    try {
      const { default: ChargeIssuingService } = await import('./chargeIssuingService.js');
      const resultado = await ChargeIssuingService.createAddonProration({ tenant, subscription, quote, now });
      return {
        ...resumo,
        issued: Boolean(resultado.issued),
        ...(resultado.issued ? {} : { reason: resultado.reason }),
        charge: resultado.charge ? BillingCharge.present(resultado.charge) : null
      };
    } catch (error) {
      console.error(`Add-on proration of provider ${tenant.id} failed:`, error.message);
      return { ...resumo, issued: false, reason: 'error' };
    }
  }

  /**
   * Cancela o add-on `code` do provedor em escopo, a pedido dele: vale até o
   * fim do período pago (`cancel_at = renews_at`) e a renovação já sai sem
   * ele. Sem período pago correndo (teste, atraso), sai na hora — não há mês
   * pago a respeitar. Idempotente: o já agendado devolve `already: true`.
   */
  static async cancel({ code, actorUserId = null, now = new Date() }) {
    const addon = await Addon.findByCode(normalizeAddonCode(code));
    if (!addon) throw new AddonError('addons.notFound', { code: 'addon_not_found', status: 404 });
    const { tenant, subscription } = await this.assinaturaViva();
    await TenantAddon.finalizeDue(now);
    const linha = await TenantAddon.activeFor(addon.id);
    if (!linha) throw new AddonError('addons.notActive', { code: 'addon_not_active', status: 409 });
    if (linha.cancel_at) return { addon, already: true, row: linha, charge: 'none' };

    const renovacao = asDate(subscription.renews_at);
    const correndo = subscription.status === 'active' && renovacao && renovacao.getTime() > now.getTime();
    const depois = (linhas) => (correndo
      ? linhas.map((item) => (Number(item.id) === Number(linha.id) ? { ...item, cancel_at: renovacao } : item))
      : linhas.filter((item) => Number(item.id) !== Number(linha.id)));
    const { charge, reissue } = await this.withReprice({
      tenant,
      subscription,
      rowsAfter: depois,
      escrever: () => (correndo
        ? TenantAddon.update(linha.id, { cancel_at: renovacao, canceled_by: actorUserId ?? null })
        : TenantAddon.endNow(linha.id, { at: now, by: actorUserId }))
    });
    this.invalidate(tenant.id);
    return {
      addon,
      scheduled: Boolean(correndo),
      effectiveAt: correndo ? renovacao.toISOString() : now.toISOString(),
      row: await TenantAddon.findById(linha.id),
      charge,
      ...(reissue ? { reissue } : {})
    };
  }

  // ── O console ────────────────────────────────────────────────────────

  /** Os add-ons de UM provedor, como o console os lê: os vivos e o histórico. */
  static async presentForConsole(tenantId, { now = new Date() } = {}) {
    return runInTenant(tenantId, async () => {
      await TenantAddon.finalizeDue(now);
      const porId = new Map((await Addon.list()).map((addon) => [Number(addon.id), addon]));
      const linhas = await TenantAddon.listAll();
      return {
        addons: linhas.map((linha) => presentTenantAddon(linha, porId.get(Number(linha.addon_id)), now)),
        catalog: [...porId.values()].map(presentAddon)
      };
    });
  }

  /** O que muda o preço da fatura do provedor `tenantId` — pela porta da troca, ou só gravado. */
  static async consoleWrite(tenantId, rowsAfterOf, escrever) {
    return runInTenant(tenantId, async () => {
      const tenant = await Tenant.findById(tenantId);
      const subscription = await Subscription.forTenant(tenantId);
      if (!subscription || !isBillableStatus(subscription)) {
        await escrever();
        return { charge: 'none' };
      }
      return this.withReprice({ tenant, subscription, rowsAfter: rowsAfterOf, escrever });
    });
  }

  /**
   * O console dá o add-on `code` ao provedor, de graça (`free`), com o
   * motivo. Se ele já o tem pago, a linha passa a ser de graça (e o
   * cancelamento agendado, se havia, some). Nunca cobra pró-rata.
   */
  static async grant({ tenantId, code, reason, actorUserId = null, now = new Date() }) {
    const addon = await Addon.findByCode(normalizeAddonCode(code));
    if (!addon) throw new AddonError('addons.notFound', { code: 'addon_not_found', status: 404 });
    const existente = await runInTenant(tenantId, async () => {
      await TenantAddon.finalizeDue(now);
      return TenantAddon.activeFor(addon.id);
    });
    if (existente && existente.free && !existente.cancel_at) {
      return { addon, already: true, row: existente, charge: 'none' };
    }
    let rowId = existente?.id ?? null;
    const resultado = await this.consoleWrite(
      tenantId,
      (atuais) => (existente
        ? atuais.map((linha) => (Number(linha.id) === Number(existente.id) ? { ...linha, free: true, cancel_at: null } : linha))
        : [...atuais, { id: 0, addon_id: addon.id, status: 'active', free: true, cancel_at: null }]),
      async () => {
        if (existente) {
          await TenantAddon.update(existente.id, {
            free: true, cancel_at: null, source: 'console', reason: String(reason).slice(0, 255)
          });
          return;
        }
        try {
          rowId = await TenantAddon.insertActive({
            addonId: addon.id, startedAt: now, free: true, source: 'console', reason, createdBy: actorUserId
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          const outra = await TenantAddon.activeFor(addon.id);
          rowId = outra?.id ?? null;
          if (outra) await TenantAddon.update(outra.id, { free: true, cancel_at: null, source: 'console', reason: String(reason).slice(0, 255) });
        }
      }
    );
    this.invalidate(tenantId);
    const row = await runInTenant(tenantId, () => TenantAddon.findById(rowId));
    return { addon, granted: true, row, charge: resultado.charge };
  }

  /** O console tira o add-on `code` do provedor NA HORA, com o motivo. Sem estorno. */
  static async revoke({ tenantId, code, reason, actorUserId = null, now = new Date() }) {
    const addon = await Addon.findByCode(normalizeAddonCode(code));
    if (!addon) throw new AddonError('addons.notFound', { code: 'addon_not_found', status: 404 });
    const linha = await runInTenant(tenantId, async () => {
      await TenantAddon.finalizeDue(now);
      return TenantAddon.activeFor(addon.id);
    });
    if (!linha) throw new AddonError('addons.notActive', { code: 'addon_not_active', status: 409 });
    const resultado = await this.consoleWrite(
      tenantId,
      (atuais) => atuais.filter((item) => Number(item.id) !== Number(linha.id)),
      () => TenantAddon.endNow(linha.id, { at: now, by: actorUserId, reason })
    );
    this.invalidate(tenantId);
    const row = await runInTenant(tenantId, () => TenantAddon.findById(linha.id));
    return { addon, revoked: true, row, charge: resultado.charge };
  }

  /** Os valores aceitos do catálogo, para o controlador do console validar. */
  static get KINDS() {
    return ADDON_KINDS;
  }

  static get LIMIT_RESOURCES() {
    return ADDON_LIMIT_RESOURCES;
  }
}

export default AddonService;
