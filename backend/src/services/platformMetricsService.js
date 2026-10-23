import { getDb } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';
import { OPEN_CHARGE_STATUSES, isoDateOf } from '../models/BillingCharge.js';
import { BILLING_EVENT_TYPES } from '../models/BillingEvent.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import Tenant from '../models/Tenant.js';
import SubscriptionService from './subscriptionService.js';
import { aggregateRevenue, datasDaCobranca, indexarEventos, instanteMs } from './revenueReportService.js';

/**
 * As métricas mês a mês do console: a série que a aba Receita desenha e que o
 * relatório mensal (`platformAlertService`, `monthly_report`) manda.
 *
 * ## Os meses são os de Brasília
 *
 * Ao contrário do relatório de receita (meses em UTC, como as datas `from`/`to`
 * dele), aqui o mês é o calendário de America/Sao_Paulo: o relatório mensal sai
 * no dia 1º às 8h de Brasília e fala do mês que acabou à meia-noite de
 * Brasília. Um pagamento às 23h do dia 31 é do mês 31, e não do seguinte.
 * O agrupamento é feito aqui, em JS, pelo mesmo motivo do relatório de receita:
 * três dialetos de SQL para a mesma pergunta, e o SQLite com dois formatos de
 * instante na mesma coluna.
 *
 * ## Poucas leituras
 *
 * Uma leitura de cada tabela (provedores, assinaturas, planos, cupons das
 * assinaturas com cupom, cobranças, extrato) e a soma em memória — nada por
 * provedor, nada por mês.
 *
 * ## O que é exato e o que é aproximado
 *
 * - **Recebido** (líquido) é exato: os `payment.recorded` do mês menos os
 *   `payment.refunded` do mês, pelo instante do evento, como no relatório de
 *   receita (o aceite da diferença é um evento de zero e não soma nada).
 * - **Novos** e **cancelados** são exatos: o `created_at` do provedor e os
 *   `status.changed` para `canceled` do extrato (sem o evento, o `canceled_at`
 *   da assinatura).
 * - **MRR do mês corrente** é a foto de agora, com a regra e os preços do
 *   relatório de receita (só `active` de verdade, sem isenção, preço com o
 *   cupom acima de zero, normalizado por 30/dias do ciclo — 1/12 no anual).
 * - **MRR dos meses fechados** é RECONSTRUÍDO pelo extrato, porque o estado da
 *   assinatura não tem histórico: conta a assinatura cujo último pagamento
 *   antes do fim do mês (não estornado até lá, e que não seja pró-rata) cobria
 *   o fim do mês — até o `renewsAt` que ele gravou, ou, sem ele, até o
 *   pagamento mais os dias do ciclo e uma folga de cinco dias —, e que não
 *   estava cancelada. O valor é o preço do plano com o cupom que o pagamento
 *   gravou (`baseCents`; sem ele, o pedido; sem ele, o pago), normalizado do
 *   mesmo jeito. Trial e isento não pagam, então ficam de fora sozinhos. Vem
 *   marcado `mrrApproximate: true`.
 * - **Inadimplência** do mês corrente é a de agora (a mesma conta do
 *   relatório de receita); a dos meses fechados é reconstruída: as cobranças
 *   com vencimento até o último dia do mês, criadas antes do fim dele, e que no
 *   fim dele não estavam pagas — abertas ainda hoje, pagas depois, ou
 *   canceladas depois (a data do cancelamento de uma cobrança é a do
 *   `updated_at`, a última vez que alguém a tocou). `overdueApproximate`.
 *
 * ## Moeda
 *
 * Só BRL, como o relatório de receita: os planos e as cobranças da
 * plataforma são todos em reais, e o valor é somado sem conversão. A resposta
 * diz `currency: 'BRL'` para que a tela não suponha outra coisa.
 */

export const FUSO = 'America/Sao_Paulo';
export const MIN_MONTHS = 1;
export const MAX_MONTHS = 24;
export const DEFAULT_MONTHS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A folga do pagamento sem `renewsAt` gravado: o pagamento que chega uns dias atrasado. */
const FOLGA_MS = 5 * DAY_MS;
/** Quanto do extrato ler antes do primeiro mês: o anual cobre um ano. */
const HISTORICO_MS = 400 * DAY_MS;

/** Uma recusa do número de meses, com o código que a tela traduz. */
export class MetricsRangeError extends Error {
  constructor(message, code = 'invalid_months') {
    super(message);
    this.status = 400;
    this.code = code;
  }
}

/** `?months=` validado: ausente é 12; inteiro de 1 a 24, ou 400. */
export function parseMonths(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return DEFAULT_MONTHS;
  const texto = String(valor).trim();
  if (!/^\d+$/.test(texto)) throw new MetricsRangeError(`months must be an integer from ${MIN_MONTHS} to ${MAX_MONTHS}`);
  const n = Number(texto);
  if (n < MIN_MONTHS || n > MAX_MONTHS) throw new MetricsRangeError(`months must be an integer from ${MIN_MONTHS} to ${MAX_MONTHS}`);
  return n;
}

const formatoSp = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function partesSp(ms) {
  const p = Object.fromEntries(formatoSp.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    ano: Number(p.year), mes: Number(p.month), dia: Number(p.day),
    hora: Number(p.hour), minuto: Number(p.minute), segundo: Number(p.second)
  };
}

/** O deslocamento de Brasília em `ms` (negativo: -3 h hoje, -2 h no antigo horário de verão). */
function deslocamento(ms) {
  const p = partesSp(ms);
  return Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - Math.floor(ms / 1000) * 1000;
}

/** `YYYY-MM` de um instante, no calendário de Brasília. */
export function mesSp(ms) {
  const p = partesSp(ms);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` de um instante, no calendário de Brasília. */
export function diaSp(ms) {
  const p = partesSp(ms);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

/** A meia-noite de Brasília do dia 1º de `mes0` (0 a 11, pode transbordar), em ms UTC. */
export function inicioDoMesSp(ano, mes0) {
  const palpite = Date.UTC(ano, mes0, 1);
  let inicio = palpite - deslocamento(palpite);
  // Na virada de um horário de verão o deslocamento do palpite não é o da
  // meia-noite; uma segunda volta acerta.
  const outro = deslocamento(inicio);
  if (palpite - outro !== inicio) inicio = palpite - outro;
  return inicio;
}

/** Os `meses` meses de Brasília que terminam no mês de `now`, do mais antigo ao atual. */
export function mesesAte(now, meses) {
  const p = partesSp(now.getTime());
  const lista = [];
  for (let i = meses - 1; i >= 0; i -= 1) {
    const ano = p.ano;
    const mes0 = p.mes - 1 - i;
    const startMs = inicioDoMesSp(ano, mes0);
    const endMs = inicioDoMesSp(ano, mes0 + 1);
    const primeiro = new Date(Date.UTC(ano, mes0, 1));
    const seguinte = new Date(Date.UTC(ano, mes0 + 1, 1));
    lista.push({
      month: primeiro.toISOString().slice(0, 7),
      startMs,
      endMs,
      // O 1º dia do mês seguinte: vencido no fim do mês é vencimento antes dele.
      nextFirstDay: seguinte.toISOString().slice(0, 10)
    });
  }
  return lista;
}

/** O `detail` de um evento, lido — ou nulo. */
function detalheDe(evento) {
  const bruto = evento?.detail;
  if (!bruto) return null;
  if (typeof bruto === 'object') return bruto;
  try {
    const lido = JSON.parse(bruto);
    return lido && typeof lido === 'object' ? lido : null;
  } catch {
    return null;
  }
}

/** Os dias que um pagamento compra: 365 no anual, os do plano no mensal. */
function diasDoCiclo(ciclo, plano, detalhe) {
  if (ciclo === 'annual') return 365;
  if (plano) return SubscriptionService.cyclePeriodDays({ billing_cycle: 'monthly' }, plano);
  const dias = Number(detalhe?.periodDays);
  return Number.isFinite(dias) && dias > 0 ? dias : 30;
}

const mensalDe = (preco, dias) => Math.round((preco * 30) / dias);

/**
 * A soma, sem banco. Pura de propósito, como `aggregateRevenue`: é aqui que
 * mora cada decisão (ver o topo do arquivo), e é aqui que os testes as fixam.
 */
export function aggregateMonthly({
  months = DEFAULT_MONTHS, now = new Date(), tenants, subscriptions, plans, prices = new Map(), charges, events
}) {
  // Um mês a mais no começo: o churn do primeiro mês divide pelos pagantes do anterior.
  const janela = mesesAte(now, months + 1);
  const atual = janela[janela.length - 1];
  const provedores = new Map(tenants.map((t) => [Number(t.id), t]));
  const planos = new Map(plans.map((p) => [Number(p.id), p]));
  const assinaturaPorProvedor = new Map();
  for (const sub of subscriptions) {
    if (provedores.has(Number(sub.tenant_id))) assinaturaPorProvedor.set(Number(sub.tenant_id), sub);
  }
  const doMes = (ms) => {
    if (ms === null) return null;
    for (const mes of janela) if (ms >= mes.startMs && ms < mes.endMs) return mes.month;
    return null;
  };
  const linhas = new Map(janela.map((m) => [m.month, {
    month: m.month,
    current: m === atual,
    mrrCents: 0,
    payingCount: 0,
    mrrApproximate: m !== atual,
    receivedCents: 0,
    grossCents: 0,
    refundedCents: 0,
    payments: 0,
    newTenants: 0,
    canceledTenants: 0,
    churnRate: null,
    overdueCents: 0,
    overdueCount: 0,
    overdueTenants: 0,
    overdueApproximate: m !== atual
  }]));

  // O extrato, separado por tipo e por provedor.
  const pagamentosPorProvedor = new Map();
  const estornoEm = new Map();
  const cancelamentos = new Map();
  const temEventoDeCancelamento = new Set();
  for (const evento of events) {
    const tenantId = Number(evento.tenant_id);
    if (!provedores.has(tenantId)) continue;
    const ms = instanteMs(evento.created_at);
    if (ms === null) continue;
    const valor = Number(evento.amount_cents) || 0;
    if (evento.type === BILLING_EVENT_TYPES.PAYMENT_RECORDED) {
      const mes = linhas.get(doMes(ms));
      if (mes) {
        mes.grossCents += valor;
        mes.receivedCents += valor;
        if (!String(evento.external_id ?? '').endsWith(':accepted')) mes.payments += 1;
      }
      const lista = pagamentosPorProvedor.get(tenantId) ?? [];
      lista.push({ ms, evento, detalhe: detalheDe(evento) });
      pagamentosPorProvedor.set(tenantId, lista);
    } else if (evento.type === BILLING_EVENT_TYPES.PAYMENT_REFUNDED) {
      const mes = linhas.get(doMes(ms));
      if (mes) {
        mes.refundedCents += valor;
        mes.receivedCents -= valor;
      }
      const externo = String(evento.external_id ?? '');
      const ref = detalheDe(evento)?.reference ?? (externo.endsWith(':refund') ? externo.slice(0, -':refund'.length) : null);
      if (ref) {
        const chave = `${tenantId}|${ref}`;
        if (!estornoEm.has(chave) || ms < estornoEm.get(chave)) estornoEm.set(chave, ms);
      }
    } else if (evento.type === BILLING_EVENT_TYPES.STATUS_CHANGED) {
      const detalhe = detalheDe(evento);
      const lista = cancelamentos.get(tenantId) ?? [];
      lista.push({ ms, to: detalhe?.to ?? null });
      cancelamentos.set(tenantId, lista);
      if (detalhe?.to === 'canceled') temEventoDeCancelamento.add(tenantId);
    }
  }
  for (const lista of pagamentosPorProvedor.values()) lista.sort((a, b) => a.ms - b.ms);
  for (const lista of cancelamentos.values()) lista.sort((a, b) => a.ms - b.ms);

  // Novos e cancelados.
  for (const tenant of provedores.values()) {
    const mes = linhas.get(doMes(instanteMs(tenant.created_at)));
    if (mes) mes.newTenants += 1;
  }
  const canceladosPorMes = new Map();
  const marcarCancelado = (mes, tenantId) => {
    if (!mes) return;
    const conjunto = canceladosPorMes.get(mes) ?? new Set();
    conjunto.add(tenantId);
    canceladosPorMes.set(mes, conjunto);
  };
  for (const [tenantId, lista] of cancelamentos) {
    for (const mudanca of lista) if (mudanca.to === 'canceled') marcarCancelado(doMes(mudanca.ms), tenantId);
  }
  for (const [tenantId, sub] of assinaturaPorProvedor) {
    if (temEventoDeCancelamento.has(tenantId) || sub.status !== 'canceled') continue;
    marcarCancelado(doMes(instanteMs(sub.canceled_at)), tenantId);
  }
  for (const [mes, conjunto] of canceladosPorMes) linhas.get(mes).canceledTenants = conjunto.size;

  // Cancelada no instante `fimMs`?
  const canceladaEm = (tenantId, fimMs) => {
    const lista = cancelamentos.get(tenantId);
    if (lista?.length) {
      let ultimo = null;
      for (const mudanca of lista) if (mudanca.ms < fimMs) ultimo = mudanca;
      if (ultimo) return ultimo.to === 'canceled';
    }
    const sub = assinaturaPorProvedor.get(tenantId);
    const quando = instanteMs(sub?.canceled_at);
    return sub?.status === 'canceled' && quando !== null && quando < fimMs;
  };

  // O MRR reconstruído dos meses fechados.
  for (const mes of janela) {
    if (mes === atual) continue;
    const linha = linhas.get(mes.month);
    for (const [tenantId, lista] of pagamentosPorProvedor) {
      if (canceladaEm(tenantId, mes.endMs)) continue;
      let ultimo = null;
      for (const pagamento of lista) {
        if (pagamento.ms >= mes.endMs) break;
        if (pagamento.detalhe?.proration) continue;
        const estorno = estornoEm.get(`${tenantId}|${pagamento.evento.external_id}`);
        if (pagamento.evento.external_id && estorno !== undefined && estorno < mes.endMs) continue;
        ultimo = pagamento;
      }
      if (!ultimo) continue;
      const { detalhe, evento, ms } = ultimo;
      const sub = assinaturaPorProvedor.get(tenantId);
      const planoId = detalhe?.planId ?? sub?.plan_id ?? null;
      const plano = planoId === null || planoId === undefined ? null : planos.get(Number(planoId)) ?? null;
      const ciclo = detalhe?.billingCycle ?? sub?.billing_cycle ?? 'monthly';
      const dias = diasDoCiclo(ciclo, plano, detalhe);
      const renovaEm = instanteMs(detalhe?.renewsAt);
      const cobreAte = renovaEm ?? (ms + dias * DAY_MS + FOLGA_MS);
      if (cobreAte <= mes.endMs) continue;
      const candidatos = [detalhe?.baseCents, detalhe?.expectedCents, evento.amount_cents];
      const preco = Number(candidatos.find((v) => v !== null && v !== undefined && Number.isFinite(Number(v))));
      if (!(preco > 0)) continue;
      linha.mrrCents += mensalDe(preco, dias);
      linha.payingCount += 1;
    }
  }

  // O mês corrente: a foto de agora, com a conta do relatório de receita.
  const foto = aggregateRevenue({
    range: { from: null, to: null, startMs: atual.startMs, endMs: atual.endMs, months: [] },
    now, tenants: [...provedores.values()], subscriptions, plans, prices, charges, events: []
  });
  const linhaAtual = linhas.get(atual.month);
  linhaAtual.mrrCents = foto.mrrCents;
  linhaAtual.payingCount = foto.activeCount;
  linhaAtual.overdueCents = foto.overdueCents;
  linhaAtual.overdueTenants = foto.overdueTenants;

  // A inadimplência no fim de cada mês.
  const hojeUtc = new Date(now.getTime()).toISOString().slice(0, 10);
  const indice = indexarEventos(events);
  const devedoresPorMes = new Map(janela.map((m) => [m.month, new Set()]));
  for (const charge of charges) {
    const tenantId = Number(charge.tenant_id);
    if (!provedores.has(tenantId)) continue;
    const valor = Number(charge.amount_cents) || 0;
    const vencimento = isoDateOf(charge.due_date);
    const aberta = OPEN_CHARGE_STATUSES.includes(charge.status);
    // O mês corrente conta como o relatório de receita (o vencimento em UTC).
    if (aberta && (charge.status === 'overdue' || (vencimento && vencimento < hojeUtc))) linhaAtual.overdueCount += 1;
    if (!vencimento) continue;
    const criada = instanteMs(charge.created_at);
    let pagaEm = null;
    if (charge.status === 'paid' || charge.status === 'refunded') pagaEm = datasDaCobranca(charge, indice).paidAtMs;
    const tocada = instanteMs(charge.updated_at);
    for (const mes of janela) {
      if (mes === atual) continue;
      if (vencimento >= mes.nextFirstDay) continue;
      if (criada !== null && criada >= mes.endMs) continue;
      const devia = aberta
        || ((charge.status === 'paid' || charge.status === 'refunded') && pagaEm !== null && pagaEm >= mes.endMs)
        || (charge.status === 'canceled' && tocada !== null && tocada >= mes.endMs);
      if (!devia) continue;
      const linha = linhas.get(mes.month);
      linha.overdueCents += valor;
      linha.overdueCount += 1;
      devedoresPorMes.get(mes.month).add(tenantId);
    }
  }
  for (const mes of janela) {
    if (mes !== atual) linhas.get(mes.month).overdueTenants = devedoresPorMes.get(mes.month).size;
  }

  // O churn: cancelados do mês sobre os pagantes no fim do mês anterior.
  const serie = janela.map((m) => linhas.get(m.month));
  for (let i = 1; i < serie.length; i += 1) {
    const base = serie[i - 1].payingCount;
    serie[i].churnRate = base > 0 ? Math.round((serie[i].canceledTenants / base) * 10000) / 10000 : null;
  }

  // A receita por plano do último mês: o recebido (pelo plano que o pagamento
  // pagou) e o MRR de agora.
  const porPlano = new Map();
  const linhaDoPlano = (planId) => {
    const chave = planId === null || planId === undefined ? null : Number(planId);
    if (!porPlano.has(chave)) {
      porPlano.set(chave, {
        planId: chave, name: chave === null ? null : (planos.get(chave)?.name ?? null),
        receivedCents: 0, mrrCents: 0, payingCount: 0
      });
    }
    return porPlano.get(chave);
  };
  for (const [tenantId, lista] of pagamentosPorProvedor) {
    for (const { ms, evento, detalhe } of lista) {
      if (ms < atual.startMs || ms >= atual.endMs) continue;
      const valor = Number(evento.amount_cents) || 0;
      if (!valor) continue;
      const planoId = detalhe?.planId ?? assinaturaPorProvedor.get(tenantId)?.plan_id ?? null;
      const conhecido = planoId !== null && planoId !== undefined && planos.has(Number(planoId));
      linhaDoPlano(conhecido ? planoId : null).receivedCents += valor;
    }
  }
  for (const linha of foto.byPlan) {
    if (!(linha.activeCount > 0)) continue;
    const destino = linhaDoPlano(linha.planId);
    destino.mrrCents += linha.mrrCents;
    destino.payingCount += linha.activeCount;
  }
  const revenueByPlan = [...porPlano.values()]
    .filter((l) => l.receivedCents > 0 || l.mrrCents > 0)
    .sort((a, b) => (b.receivedCents - a.receivedCents) || (b.mrrCents - a.mrrCents)
      || String(a.name ?? '').localeCompare(String(b.name ?? '')));

  return {
    currency: 'BRL',
    timeZone: FUSO,
    months: serie.slice(1),
    revenueByPlan,
    revenueByPlanMonth: atual.month
  };
}

/** As linhas cruas, numa leitura de cada tabela. */
async function carregar(desdeMs) {
  const [tenants, subscriptions, plans] = await Promise.all([
    Tenant.list(), Subscription.listWithPlans(), Plan.list()
  ]);
  const db = getDb();
  // tenant-scope-exempt: métricas do plano de controle, acima dos provedores.
  const charges = await runUnscoped('the console monthly metrics read every provider\'s charges', () => db('billing_charges')
    .select(
      'id', 'tenant_id', 'subscription_id', 'amount_cents', 'currency', 'status', 'due_date',
      'gateway_charge_id', 'superseded_charges', 'created_at', 'updated_at'
    )
    .orderBy('id', 'asc'));
  // tenant-scope-exempt: idem — o extrato desde um ano antes do primeiro mês.
  const events = await runUnscoped('the console monthly metrics read every provider\'s ledger', () => db('billing_events')
    .whereIn('type', [
      BILLING_EVENT_TYPES.PAYMENT_RECORDED, BILLING_EVENT_TYPES.PAYMENT_REFUNDED, BILLING_EVENT_TYPES.STATUS_CHANGED
    ])
    .where('created_at', '>=', new Date(Math.floor(desdeMs / 1000) * 1000))
    .select('tenant_id', 'subscription_id', 'type', 'external_id', 'amount_cents', 'detail', 'created_at'));
  // Os cupons das assinaturas com cupom, numa leitura só — o preço efetivo
  // perguntaria um por um.
  const ids = [...new Set(subscriptions.map((s) => s.coupon_id).filter(Boolean).map(Number))];
  const cupons = ids.length ? await db('coupons').whereIn('id', ids) : [];
  return { tenants, subscriptions, plans, charges, events, cupons: new Map(cupons.map((c) => [Number(c.id), c])) };
}

/** O preço efetivo de cada assinatura, com o cupom já lido. */
async function precos(subscriptions, plans, cupons) {
  const planos = new Map(plans.map((p) => [Number(p.id), p]));
  const mapa = new Map();
  for (const sub of subscriptions) {
    const plano = planos.get(Number(sub.plan_id));
    let preco = SubscriptionService.cyclePriceCents(sub, plano);
    try {
      const cupom = sub.coupon_id ? (cupons.get(Number(sub.coupon_id)) ?? null) : null;
      // eslint-disable-next-line no-await-in-loop -- sem banco: o cupom já veio
      const efetivo = Number(await SubscriptionService.effectivePriceCents(sub, plano, { coupon: cupom }));
      if (Number.isFinite(efetivo) && efetivo >= 0) preco = Math.round(efetivo);
    } catch {
      // Cai no preço do plano, como o relatório de receita.
    }
    mapa.set(Number(sub.id), preco);
  }
  return mapa;
}

/** A série dos últimos `months` meses de Brasília, pronta para a resposta. */
export async function monthly({ months = DEFAULT_MONTHS, now = new Date() } = {}) {
  const [primeiro] = mesesAte(now, months + 1);
  const dados = await carregar(primeiro.startMs - HISTORICO_MS);
  const prices = await precos(dados.subscriptions, dados.plans, dados.cupons);
  return aggregateMonthly({ months, now, prices, ...dados });
}

/** O mês anterior ao de `now`, em Brasília (`YYYY-MM`). */
export function previousMonth(now = new Date()) {
  const [anterior] = mesesAte(now, 2);
  return anterior.month;
}

/**
 * As métricas de UM mês fechado (`YYYY-MM`), e o mês antes dele para a
 * variação. Pede a série até o mês seguinte ao pedido, com dois meses — um
 * relatório do mês passado lido hoje.
 */
export async function monthSummary(month, { now = new Date() } = {}) {
  const [ano, mes] = String(month).split('-').map(Number);
  // Um instante no meio do mês seguinte, para a série terminar nele.
  const referencia = new Date(Math.min(now.getTime(), inicioDoMesSp(ano, mes) + 12 * 60 * 60 * 1000));
  const serie = await monthly({ months: 3, now: referencia });
  const indice = serie.months.findIndex((m) => m.month === month);
  return {
    month,
    current: indice >= 0 ? serie.months[indice] : null,
    previous: indice > 0 ? serie.months[indice - 1] : null,
    currency: serie.currency
  };
}

export default { monthly, monthSummary, previousMonth, parseMonths, aggregateMonthly };
