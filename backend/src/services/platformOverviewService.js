import { getDb } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import Tenant from '../models/Tenant.js';
import SubscriptionService, { isCancelScheduled, isPauseScheduled } from './subscriptionService.js';
import DelinquencyService from './delinquencyService.js';
import { FUSO, mesesAte, monthly } from './platformMetricsService.js';
import { instanteMs } from './revenueReportService.js';

/**
 * O painel inicial do console (`GET /api/platform/overview`): uma foto de
 * "como está a plataforma agora", num pedido só, para a aba Início.
 *
 * ## Blocos independentes
 *
 * Cada bloco (receita, inadimplência, alertas, cancelamentos, renovações,
 * trials, novos provedores) é calculado à parte e tolerante a falha: o que
 * lança vira `null` na resposta, o nome dele vai para `errors` e o erro vai
 * para o log — um bloco quebrado não apaga a tela inteira. Os blocos são
 * métodos estáticos chamados por nome, para o teste poder trocar um deles.
 *
 * ## Poucas leituras
 *
 * Os números de dinheiro vêm dos serviços que já existem (as métricas mês a
 * mês da aba Receita e o painel de inadimplência), para a Início nunca
 * divergir das abas para onde os cards levam. A carteira (provedores,
 * assinaturas com o plano, catálogo) é lida UMA vez por pedido e
 * compartilhada pelos blocos que precisam dela; os instantes são comparados
 * em JS (`instanteMs`), como nas métricas: o SQLite guarda dois formatos de
 * instante na mesma coluna, e um `WHERE renews_at >= ?` nele mentiria.
 *
 * ## O mês
 *
 * "Este mês" é o calendário de Brasília, o mesmo da aba Receita.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A janela das renovações e dos trials que vencem. */
export const OVERVIEW_WINDOW_DAYS = 7;
/** O teto das listas curtas. */
export const OVERVIEW_LIST_LIMIT = 10;
/** A janela dos alertas que falharam. */
export const ALERTS_WINDOW_DAYS = 7;

export const OVERVIEW_BLOCKS = Object.freeze([
  'revenue', 'delinquency', 'alerts', 'cancellations', 'renewals', 'trials', 'newTenants'
]);

/** A variação de um número entre dois meses (`pct` nulo sem base). */
export function variacao(atual, anterior) {
  const value = Number.isFinite(atual) ? atual : null;
  const previous = Number.isFinite(anterior) ? anterior : null;
  const delta = value !== null && previous !== null ? value - previous : null;
  const pct = delta !== null && previous ? Math.round((delta / Math.abs(previous)) * 10000) / 10000 : null;
  return { value, previous, delta, pct };
}

/** A carteira lida uma vez: os provedores, as assinaturas deles e o catálogo. */
async function lerCarteira() {
  const [tenants, subscriptions, plans] = await Promise.all([
    Tenant.list(), Subscription.listWithPlans(), Plan.list()
  ]);
  const provedores = new Map(tenants.map((t) => [Number(t.id), t]));
  return {
    tenants,
    provedores,
    planos: new Map(plans.map((p) => [Number(p.id), p])),
    // Só as assinaturas de provedores (a caixa da plataforma não entra).
    assinaturas: subscriptions.filter((s) => provedores.has(Number(s.tenant_id)))
  };
}

class PlatformOverviewService {
  /**
   * A resposta inteira. `now` é o relógio (os testes passam um).
   */
  static async build({ now = new Date() } = {}) {
    let carteira = null;
    const ctx = {
      now,
      // Lida na primeira vez que um bloco pede; a falha dela derruba só os
      // blocos que dependem dela.
      carteira: () => {
        carteira = carteira ?? lerCarteira();
        return carteira;
      }
    };
    const errors = [];
    const resultados = await Promise.all(OVERVIEW_BLOCKS.map(async (nome) => {
      try {
        return await this[nome](ctx);
      } catch (error) {
        console.error(`Platform overview: block "${nome}" failed:`, error);
        errors.push(nome);
        return null;
      }
    }));
    return {
      generatedAt: now.toISOString(),
      timeZone: FUSO,
      windowDays: OVERVIEW_WINDOW_DAYS,
      ...Object.fromEntries(OVERVIEW_BLOCKS.map((nome, i) => [nome, resultados[i]])),
      errors: OVERVIEW_BLOCKS.filter((nome) => errors.includes(nome))
    };
  }

  /** O MRR e o recebido do mês corrente (Brasília), com a variação sobre o anterior. */
  static async revenue({ now }) {
    const serie = await monthly({ months: 2, now });
    const atual = serie.months.at(-1) ?? null;
    const anterior = serie.months.length > 1 ? serie.months.at(-2) : null;
    return {
      month: atual?.month ?? null,
      currency: serie.currency,
      mrr: variacao(atual?.mrrCents, anterior?.mrrCents),
      received: variacao(atual?.receivedCents, anterior?.receivedCents),
      payingCount: atual?.payingCount ?? 0
    };
  }

  /** O resumo do painel de inadimplência — a mesma conta da aba. */
  static async delinquency({ now }) {
    const { summary } = await DelinquencyService.list({ now });
    return {
      count: summary.count,
      totalOverdueCents: summary.totalOverdueCents,
      totalsByCurrency: summary.totalsByCurrency,
      byBucket: summary.byBucket
    };
  }

  /** Quantos alertas do console falharam nos últimos sete dias. */
  static async alerts({ now }) {
    const desde = new Date(Math.floor((now.getTime() - ALERTS_WINDOW_DAYS * DAY_MS) / 1000) * 1000);
    const db = getDb();
    const consulta = db('platform_alerts').where({ status: 'failed' }).select('created_at');
    // No Postgres e no MySQL o filtro vai para o banco. No SQLite a coluna tem
    // dois formatos de instante — o número em ms (o `Date` que o serviço
    // grava) e o texto (`CURRENT_TIMESTAMP` do padrão, ou um ISO) — e um
    // `>=` só não vale para os dois: número é sempre menor que texto. Então o
    // banco corta cada formato pelo seu limite — o número pelo instante, o
    // texto pela DATA do dia anterior (que começa todo formato de texto, e a
    // folga de um dia cobre um fuso no ISO) — e a conta exata é a daqui de
    // baixo, que vale nos três. O resultado é o mesmo; a leitura, limitada.
    if (!String(db.client?.config?.client ?? '').includes('sqlite')) {
      consulta.where('created_at', '>=', desde);
    } else {
      const diaAntes = new Date(desde.getTime() - DAY_MS).toISOString().slice(0, 10);
      consulta.where((q) => q
        .where((n) => n.whereRaw("typeof(created_at) IN ('integer', 'real')").andWhere('created_at', '>=', desde.getTime()))
        .orWhere((t) => t.whereRaw("typeof(created_at) = 'text'").andWhere('created_at', '>=', diaAntes)));
    }
    const linhas = await consulta;
    const failed = linhas.filter((l) => (instanteMs(l.created_at) ?? 0) >= desde.getTime()).length;
    return { failed, since: desde.toISOString(), windowDays: ALERTS_WINDOW_DAYS };
  }

  /**
   * Os cancelamentos: os pedidos ainda sem decisão (de quem ainda tem a
   * assinatura viva) e os agendados, com o mais próximo.
   */
  static async cancellations(ctx) {
    const { assinaturas } = await ctx.carteira();
    // tenant-scope-exempt: painel do plano de controle, acima dos provedores.
    const abertos = await runUnscoped('the console overview counts every provider\'s open cancellation request', () => getDb()('cancellation_requests')
      .whereNull('outcome')
      .distinct('tenant_id'));
    const porProvedor = new Map(assinaturas.map((s) => [Number(s.tenant_id), s]));
    let pending = 0;
    for (const { tenant_id: tenantId } of abertos) {
      const sub = porProvedor.get(Number(tenantId));
      if (sub && sub.status !== 'canceled' && !isCancelScheduled(sub)) pending += 1;
    }
    let scheduled = 0;
    let nextAt = null;
    for (const sub of assinaturas) {
      if (!isCancelScheduled(sub)) continue;
      scheduled += 1;
      const ms = instanteMs(sub.cancel_at);
      if (ms !== null && (nextAt === null || ms < nextAt)) nextAt = ms;
    }
    return { pending, scheduled, nextScheduledAt: nextAt === null ? null : new Date(nextAt).toISOString() };
  }

  /**
   * As renovações dos próximos sete dias: assinaturas ativas, cobráveis, que
   * vão mesmo renovar (sem cancelamento nem pausa marcados, sem isenção), da
   * mais próxima à mais distante, com o valor que a renovação vai cobrar.
   */
  static async renewals(ctx) {
    const { now } = ctx;
    const { assinaturas, provedores, planos } = await ctx.carteira();
    const fim = now.getTime() + OVERVIEW_WINDOW_DAYS * DAY_MS;
    const candidatas = [];
    for (const sub of assinaturas) {
      if (sub.status !== 'active' || sub.billing_exempt_at) continue;
      if (isCancelScheduled(sub) || isPauseScheduled(sub)) continue;
      const ms = instanteMs(sub.renews_at);
      if (ms === null || ms < now.getTime() || ms > fim) continue;
      const plano = planos.get(Number(sub.plan_id)) ?? null;
      if (SubscriptionService.cyclePriceCents(sub, plano) <= 0) continue;
      candidatas.push({ sub, plano, ms });
    }
    candidatas.sort((a, b) => (a.ms - b.ms) || (Number(a.sub.tenant_id) - Number(b.sub.tenant_id)));
    const lista = candidatas.slice(0, OVERVIEW_LIST_LIMIT);
    // Os cupons só das que aparecem, numa leitura.
    const ids = [...new Set(lista.map((c) => c.sub.coupon_id).filter(Boolean).map(Number))];
    const cupons = new Map((ids.length ? await getDb()('coupons').whereIn('id', ids) : []).map((c) => [Number(c.id), c]));
    const items = [];
    for (const { sub, plano, ms } of lista) {
      let valor = SubscriptionService.cyclePriceCents(sub, plano);
      try {
        const cupom = sub.coupon_id ? (cupons.get(Number(sub.coupon_id)) ?? null) : null;
        // eslint-disable-next-line no-await-in-loop -- sem banco: o cupom já veio
        const efetivo = Number(await SubscriptionService.effectivePriceCents(sub, plano, { coupon: cupom }));
        if (Number.isFinite(efetivo) && efetivo >= 0) valor = Math.round(efetivo);
      } catch {
        // Fica o preço do ciclo, sem o cupom — como nas métricas.
      }
      const tenant = provedores.get(Number(sub.tenant_id));
      const cartao = SubscriptionService.presentCard(sub);
      items.push({
        tenant: { id: Number(sub.tenant_id), name: tenant?.name ?? null, slug: tenant?.slug ?? null },
        plan: { id: sub.plan_id ?? null, code: sub.plan_code ?? null, name: sub.plan_name ?? null },
        billingCycle: SubscriptionService.cycleOf(sub, plano),
        renewsAt: new Date(ms).toISOString(),
        amountCents: valor,
        currency: sub.plan_currency ?? plano?.currency ?? 'BRL',
        // A renovação sai sozinha no cartão (0100)?
        cardAutopay: Boolean(cartao.autopayEnabled && cartao.saved),
        pendingPlanChange: Boolean(sub.pending_plan_id)
      });
    }
    return { total: candidatas.length, items };
  }

  /** Os trials que acabam nos próximos sete dias, do que acaba antes. */
  static async trials(ctx) {
    const { now } = ctx;
    const { assinaturas, provedores } = await ctx.carteira();
    const fim = now.getTime() + OVERVIEW_WINDOW_DAYS * DAY_MS;
    const candidatas = [];
    for (const sub of assinaturas) {
      if (sub.status !== 'trial') continue;
      const ms = instanteMs(sub.trial_ends_at);
      if (ms === null || ms < now.getTime() || ms > fim) continue;
      candidatas.push({ sub, ms });
    }
    candidatas.sort((a, b) => (a.ms - b.ms) || (Number(a.sub.tenant_id) - Number(b.sub.tenant_id)));
    return {
      total: candidatas.length,
      items: candidatas.slice(0, OVERVIEW_LIST_LIMIT).map(({ sub, ms }) => {
        const tenant = provedores.get(Number(sub.tenant_id));
        return {
          tenant: { id: Number(sub.tenant_id), name: tenant?.name ?? null, slug: tenant?.slug ?? null },
          plan: { id: sub.plan_id ?? null, code: sub.plan_code ?? null, name: sub.plan_name ?? null },
          trialEndsAt: new Date(ms).toISOString(),
          // Já deixou um cartão para a primeira cobrança?
          cardSaved: Boolean(sub.card_token_ciphertext)
        };
      })
    };
  }

  /** Os provedores criados neste mês de Brasília, e no anterior para comparar. */
  static async newTenants(ctx) {
    const { tenants } = await ctx.carteira();
    const [anterior, atual] = mesesAte(ctx.now, 2);
    let count = 0;
    let previous = 0;
    for (const tenant of tenants) {
      const ms = instanteMs(tenant.created_at);
      if (ms === null) continue;
      if (ms >= atual.startMs && ms < atual.endMs) count += 1;
      else if (ms >= anterior.startMs && ms < anterior.endMs) previous += 1;
    }
    return { month: atual.month, ...variacao(count, previous), count };
  }
}

export default PlatformOverviewService;
