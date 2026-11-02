import ExcelJS from 'exceljs';
import { getDb } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';
import BillingCharge, { isoDateOf } from '../models/BillingCharge.js';
import { BILLING_EVENT_TYPES } from '../models/BillingEvent.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import Tenant from '../models/Tenant.js';
import SubscriptionService from './subscriptionService.js';
import { readProfile } from './platformProfileService.js';
import { RevenueRangeError, instanteMs, parseRange } from './revenueReportService.js';
import { toCsvWith } from '../utils/csv.js';

/**
 * A exportação para a contabilidade: o que a plataforma cobrou, recebeu,
 * devolveu e deu de crédito num período, linha por linha, no formato que o
 * escritório de contabilidade abre — CSV brasileiro ou XLSX.
 *
 * Só leitura e acima dos provedores, como o relatório de receita
 * (`revenueReportService`): as consultas são `runUnscoped`, com o marcador.
 *
 * ## As abas
 *
 *   - **Cobranças**: cada cobrança com VENCIMENTO no período (sem vencimento,
 *     a data de criação) — é a competência que o contador lança. A conta do
 *     valor vem aberta: bruto (o preço cheio do plano + o excedente), o
 *     desconto do cupom, o crédito usado, o excedente, o ajuste manual do
 *     console e o líquido (`amount_cents`, o que foi ao gateway). Sempre vale
 *     `bruto − cupom − crédito + ajuste = líquido`. O desconto do cupom é o
 *     preço de HOJE do plano menos o preço gravado na linha (`pricing_detail.base`)
 *     — o preço de tabela da época não é gravado, a mesma aproximação do
 *     relatório de receita. As canceladas aparecem (com o status), mas ficam
 *     fora dos totais.
 *   - **Pagamentos** e **Estornos**: os eventos do extrato (`billing_events`)
 *     registrados no período — exatamente o que o relatório de receita soma
 *     como recebido e estornado. É isso que faz o Resumo bater com ele. O
 *     aceite da diferença (evento de valor zero) não vira linha.
 *   - **Créditos**: as concessões (indicação e ajuste manual) e os
 *     cancelamentos de crédito no período, e os consumos — o crédito que uma
 *     cobrança paga gastou — e as devoluções de consumo por estorno.
 *   - **NFS-e**: as notas emitidas no período (sem data de emissão, as criadas
 *     nele), com número, status e o link do PDF.
 *   - **Resumo**: os totais de cada aba, e os dados da empresa que emite.
 *
 * ## O período é de Brasília
 *
 * `from`/`to` são dias do calendário de Brasília: de 00:00 de `from` a 00:00
 * do dia seguinte a `to`, no fuso `America/Sao_Paulo`. Um pagamento às 23h
 * do dia 31 (02h UTC do dia 1º) é do mês que acabou. As datas das linhas saem
 * também em Brasília, e os valores em reais.
 *
 * ## CSV ou XLSX
 *
 * O XLSX traz as seis abas num arquivo só. O CSV é uma aba por arquivo — o
 * parâmetro `sheet` diz qual (padrão: Cobranças) —, porque o CSV não tem abas
 * e juntar seis tabelas de colunas diferentes num arquivo só não abre direito
 * em planilha nenhuma. No envio por e-mail em CSV, vão os seis arquivos como
 * anexos.
 */

export const ACCOUNTING_FORMATS = Object.freeze(['csv', 'xlsx']);
export const ACCOUNTING_SHEETS = Object.freeze(['cobrancas', 'pagamentos', 'estornos', 'creditos', 'nfse', 'resumo']);
export const DEFAULT_SHEET = 'cobrancas';

const FUSO = 'America/Sao_Paulo';
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_MES = /^(\d{4})-(\d{2})$/;

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ── O calendário de Brasília ─────────────────────────────────────────────

const formatoSp = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

/** As partes de um instante no relógio de Brasília. */
function partesSp(ms) {
  const p = Object.fromEntries(formatoSp.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    ano: Number(p.year), mes: Number(p.month), dia: Number(p.day),
    hora: Number(p.hour), minuto: Number(p.minute), segundo: Number(p.second)
  };
}

/** O deslocamento de Brasília em `ms` (-3 h hoje; -2 h no antigo horário de verão). */
function deslocamento(ms) {
  const p = partesSp(ms);
  return Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - Math.floor(ms / 1000) * 1000;
}

/** A meia-noite de Brasília que abre o dia `AAAA-MM-DD`, em ms UTC. */
export function inicioDoDiaSp(dia) {
  const [ano, mes, d] = String(dia).split('-').map(Number);
  const palpite = Date.UTC(ano, mes - 1, d);
  let inicio = palpite - deslocamento(palpite);
  // Na virada de um horário de verão o deslocamento do palpite não é o da
  // meia-noite; uma segunda volta acerta.
  const outro = deslocamento(inicio);
  if (palpite - outro !== inicio) inicio = palpite - outro;
  return inicio;
}

/** `AAAA-MM-DD` de um instante, no calendário de Brasília. */
export function diaSp(ms) {
  const p = partesSp(ms);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

/** O dia seguinte de `AAAA-MM-DD`. */
const diaSeguinte = (dia) => new Date(Date.parse(`${dia}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** O último dia do mês `AAAA-MM`. */
const ultimoDiaDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);

/** O mês de Brasília anterior ao de `now`, como `AAAA-MM`. */
export function mesAnteriorSp(now = new Date()) {
  const p = partesSp(now.getTime());
  return new Date(Date.UTC(p.ano, p.mes - 2, 1)).toISOString().slice(0, 7);
}

/**
 * O período pedido, validado, com os limites em Brasília.
 *
 * `month=AAAA-MM` é o mês inteiro; senão `from`/`to` (`AAAA-MM-DD`), com as
 * regras do relatório de receita (data que existe, `from` antes de `to`, no
 * máximo 36 meses). Sem nada, o mês anterior ao de agora, em Brasília — o
 * mês que o contador fecha.
 *
 * @returns {{ from: string, to: string, startMs: number, endMs: number, months: string[] }}
 *   `endMs` exclusivo: a meia-noite de Brasília do dia seguinte a `to`.
 */
export function parseAccountingRange(query = {}, now = new Date()) {
  const texto = (v) => (v === undefined || v === null ? '' : String(v).trim());
  let from = texto(query.from);
  let to = texto(query.to);
  const mes = texto(query.month);
  if (mes) {
    const partes = ISO_MES.exec(mes);
    if (!partes || Number(partes[2]) < 1 || Number(partes[2]) > 12) {
      throw new RevenueRangeError('`month` must be a valid YYYY-MM month', 'invalid_date');
    }
    from = `${mes}-01`;
    to = ultimoDiaDoMes(Number(partes[1]), Number(partes[2]));
  } else if (!from && !to) {
    const anterior = mesAnteriorSp(now);
    const [ano, m] = anterior.split('-').map(Number);
    from = `${anterior}-01`;
    to = ultimoDiaDoMes(ano, m);
  }
  // As regras de validação (e os códigos de erro) são as da receita; só os
  // limites mudam de fuso.
  const base = parseRange({ from, to }, now);
  return {
    from: base.from,
    to: base.to,
    months: base.months,
    startMs: inicioDoDiaSp(base.from),
    endMs: inicioDoDiaSp(diaSeguinte(base.to))
  };
}

// ── Leitura e conta ──────────────────────────────────────────────────────

/** O `detail` de um evento, lido — ou um objeto vazio. */
function detalheDe(evento) {
  const bruto = evento?.detail;
  if (!bruto) return {};
  if (typeof bruto === 'object') return bruto;
  try {
    const lido = JSON.parse(bruto);
    return lido && typeof lido === 'object' ? lido : {};
  } catch {
    return {};
  }
}

const inteiro = (valor) => {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/** CNPJ (14 dígitos) ou CPF (11) com a máscara; o resto como veio. */
export function formatTaxId(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length === 14) return digitos.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (digitos.length === 11) return digitos.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return String(valor ?? '').trim();
}

const STATUS_LABELS = Object.freeze({
  pending: 'Em aberto',
  overdue: 'Vencida',
  failed: 'Falhou',
  paid: 'Paga',
  refunded: 'Estornada',
  canceled: 'Cancelada'
});

const KIND_LABELS = Object.freeze({ renewal: 'Renovação', proration: 'Pró-rata' });

const METHOD_LABELS = Object.freeze({
  PIX: 'Pix',
  BOLETO: 'Boleto',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  TRANSFER: 'Transferência',
  DEPOSIT: 'Depósito',
  MANUAL: 'Baixa manual'
});

const INVOICE_STATUS_LABELS = Object.freeze({
  pending: 'Pendente',
  scheduled: 'Agendada',
  authorized: 'Emitida',
  error: 'Erro',
  canceling: 'Cancelando',
  canceled: 'Cancelada'
});

/** A forma de cobrança pedida ao gateway. */
function formaDeCobranca(charge) {
  const tipo = String(charge.billing_type ?? '').toUpperCase();
  if (tipo === 'CREDIT_CARD') return 'Cartão de crédito';
  if (charge.gateway_charge_id || tipo === 'UNDEFINED') return 'Pix ou boleto';
  return '';
}

/** A forma de um pagamento do extrato, de onde houver. */
function formaDoPagamento(evento, detalhe) {
  const gravado = String(detalhe.paymentMethod ?? '').toUpperCase();
  if (METHOD_LABELS[gravado]) return METHOD_LABELS[gravado];
  if (evento.provider === 'manual') return METHOD_LABELS.MANUAL;
  return '';
}

/** As referências com que o extrato pode ter creditado esta cobrança. */
function referenciasDe(charge) {
  const refs = [`charge:${charge.id}`];
  if (charge.gateway_charge_id) refs.push(String(charge.gateway_charge_id));
  for (const antiga of BillingCharge.supersededOf(charge)) refs.push(String(antiga.id));
  return refs;
}

/**
 * A conta do valor de uma cobrança, aberta — ver o cabeçalho.
 * `bruto − cupom − crédito + ajuste = líquido`, sempre.
 */
export function chargeBreakdown(charge, { plan = null } = {}) {
  const net = inteiro(charge.amount_cents);
  const credit = BillingCharge.creditReservedOf(charge);
  const overage = BillingCharge.overageCentsOf(charge);
  const detalhe = BillingCharge.pricingDetailOf(charge);
  const baseGravada = detalhe && Number.isFinite(Number(detalhe.base)) && detalhe.base !== null ? inteiro(detalhe.base) : null;
  const base = baseGravada ?? (net + credit - overage);
  let coupon = 0;
  if (charge.coupon_id && plan && (charge.kind ?? 'renewal') === 'renewal') {
    const cheio = SubscriptionService.cyclePriceCents({ billing_cycle: charge.billing_cycle ?? 'monthly' }, plan);
    coupon = Math.max(0, cheio - base);
  }
  const gross = base + coupon + overage;
  const adjustment = net + credit - base - overage;
  return { grossCents: gross, couponDiscountCents: coupon, creditCents: credit, overageCents: overage, adjustmentCents: adjustment, netCents: net };
}

/** As colunas de cada aba: o cabeçalho, o campo da linha e o tipo do valor. */
export const ACCOUNTING_COLUMNS = Object.freeze({
  cobrancas: [
    { header: 'Cobrança', field: 'id', type: 'int' },
    { header: 'Provedor (razão social)', field: 'provider', type: 'text', width: 32 },
    { header: 'CNPJ/CPF', field: 'taxId', type: 'text', width: 20 },
    { header: 'Tipo', field: 'kind', type: 'text' },
    { header: 'Plano', field: 'plan', type: 'text', width: 18 },
    { header: 'Ciclo', field: 'cycle', type: 'text' },
    { header: 'Valor bruto', field: 'grossCents', type: 'money' },
    { header: 'Cupom', field: 'coupon', type: 'text' },
    { header: 'Desconto do cupom', field: 'couponDiscountCents', type: 'money' },
    { header: 'Crédito usado', field: 'creditCents', type: 'money' },
    { header: 'Excedente', field: 'overageCents', type: 'money' },
    { header: 'Ajuste manual', field: 'adjustmentCents', type: 'money' },
    { header: 'Valor líquido', field: 'netCents', type: 'money' },
    { header: 'Vencimento', field: 'dueDate', type: 'date' },
    { header: 'Status', field: 'status', type: 'text' },
    { header: 'Forma de cobrança', field: 'billingType', type: 'text', width: 18 },
    { header: 'Pago em', field: 'paidAtMs', type: 'datetime' },
    { header: 'Forma de pagamento', field: 'paymentMethod', type: 'text', width: 18 },
    { header: 'ID no gateway', field: 'gatewayChargeId', type: 'text', width: 22 },
    { header: 'NFS-e', field: 'invoiceNumber', type: 'text' }
  ],
  pagamentos: [
    { header: 'Registrado em', field: 'atMs', type: 'datetime' },
    { header: 'Data do pagamento', field: 'paidOn', type: 'date' },
    { header: 'Provedor (razão social)', field: 'provider', type: 'text', width: 32 },
    { header: 'CNPJ/CPF', field: 'taxId', type: 'text', width: 20 },
    { header: 'Valor', field: 'amountCents', type: 'money' },
    { header: 'Forma de pagamento', field: 'method', type: 'text', width: 18 },
    { header: 'Cobrança', field: 'chargeId', type: 'int' },
    { header: 'Referência', field: 'reference', type: 'text', width: 24 },
    { header: 'Observação', field: 'note', type: 'text', width: 24 }
  ],
  estornos: [
    { header: 'Estornado em', field: 'atMs', type: 'datetime' },
    { header: 'Provedor (razão social)', field: 'provider', type: 'text', width: 32 },
    { header: 'CNPJ/CPF', field: 'taxId', type: 'text', width: 20 },
    { header: 'Valor', field: 'amountCents', type: 'money' },
    { header: 'Cobrança', field: 'chargeId', type: 'int' },
    { header: 'Pagamento estornado', field: 'reference', type: 'text', width: 24 }
  ],
  creditos: [
    { header: 'Data', field: 'atMs', type: 'datetime' },
    { header: 'Provedor (razão social)', field: 'provider', type: 'text', width: 32 },
    { header: 'CNPJ/CPF', field: 'taxId', type: 'text', width: 20 },
    { header: 'Movimento', field: 'type', type: 'text', width: 24 },
    { header: 'Valor', field: 'amountCents', type: 'money' },
    { header: 'Cobrança', field: 'chargeId', type: 'int' },
    { header: 'Crédito', field: 'creditId', type: 'int' },
    { header: 'Referência', field: 'reference', type: 'text', width: 24 }
  ],
  nfse: [
    { header: 'Número', field: 'number', type: 'text' },
    { header: 'Status', field: 'status', type: 'text' },
    { header: 'Emitida em', field: 'issuedAtMs', type: 'datetime' },
    { header: 'Provedor (razão social)', field: 'provider', type: 'text', width: 32 },
    { header: 'CNPJ/CPF', field: 'taxId', type: 'text', width: 20 },
    { header: 'Cobrança', field: 'chargeId', type: 'int' },
    { header: 'Valor da cobrança', field: 'amountCents', type: 'money' },
    { header: 'PDF', field: 'pdfUrl', type: 'text', width: 40 },
    { header: 'XML', field: 'xmlUrl', type: 'text', width: 40 }
  ],
  resumo: [
    { header: 'Item', field: 'label', type: 'text', width: 40 },
    { header: 'Valor', field: 'value', type: 'auto', width: 40 }
  ]
});

const SHEET_TITLES = Object.freeze({
  cobrancas: 'Cobranças', pagamentos: 'Pagamentos', estornos: 'Estornos', creditos: 'Créditos', nfse: 'NFS-e', resumo: 'Resumo'
});

/**
 * A exportação, sem banco: as linhas cruas viram as seis abas e os totais.
 * Pura de propósito — é aqui que moram as decisões, e é aqui que os testes as
 * fixam.
 */
export function buildAccountingExport({
  range, now = new Date(), tenants, plans, subscriptions = [], charges, events,
  invoices = [], credits = [], allocations = [], coupons = [], company = {}
}) {
  const dentro = (ms) => ms !== null && ms >= range.startMs && ms < range.endMs;
  const provedores = new Map(tenants.map((t) => [Number(t.id), {
    provider: String(t.billing_legal_name || t.name || t.slug || t.id),
    taxId: formatTaxId(t.billing_tax_id)
  }]));
  const planos = new Map(plans.map((p) => [Number(p.id), p]));
  const cupons = new Map(coupons.map((c) => [Number(c.id), c]));
  const assinaturaPorId = new Map(subscriptions.map((s) => [Number(s.id), s]));
  const cobrancas = new Map(charges.map((c) => [Number(c.id), c]));
  const notaPorCobranca = new Map(invoices.map((n) => [Number(n.charge_id), n]));

  // Referência do extrato → cobrança, por provedor.
  const cobrancaPorRef = new Map();
  for (const charge of charges) {
    for (const ref of referenciasDe(charge)) cobrancaPorRef.set(`${Number(charge.tenant_id)}|${ref}`, charge);
  }
  // O primeiro pagamento de cada cobrança: quando e como foi paga.
  const pagamentoDaCobranca = new Map();
  for (const evento of [...events].sort((a, b) => (instanteMs(a.created_at) ?? 0) - (instanteMs(b.created_at) ?? 0))) {
    if (evento.type !== BILLING_EVENT_TYPES.PAYMENT_RECORDED || !evento.external_id) continue;
    if (String(evento.external_id).endsWith(':accepted')) continue;
    const charge = cobrancaPorRef.get(`${Number(evento.tenant_id)}|${evento.external_id}`);
    if (charge && !pagamentoDaCobranca.has(Number(charge.id))) pagamentoDaCobranca.set(Number(charge.id), evento);
  }

  // ── Cobranças: pela competência (vencimento; sem ele, a criação) ──
  const linhasCobranca = [];
  for (const charge of charges) {
    const dono = provedores.get(Number(charge.tenant_id));
    if (!dono) continue;
    const vencimento = isoDateOf(charge.due_date);
    const criada = instanteMs(charge.created_at);
    const competencia = vencimento ?? (criada === null ? null : diaSp(criada));
    if (!competencia || competencia < range.from || competencia > range.to) continue;
    const sub = assinaturaPorId.get(Number(charge.subscription_id)) ?? null;
    const planoId = charge.plan_id ?? sub?.plan_id ?? null;
    const plano = planoId === null || planoId === undefined ? null : planos.get(Number(planoId)) ?? null;
    const conta = chargeBreakdown(charge, { plan: plano });
    const pago = ['paid', 'refunded'].includes(charge.status) ? pagamentoDaCobranca.get(Number(charge.id)) ?? null : null;
    const nota = notaPorCobranca.get(Number(charge.id));
    linhasCobranca.push({
      id: Number(charge.id),
      ...dono,
      kind: KIND_LABELS[charge.kind ?? 'renewal'] ?? String(charge.kind),
      plan: plano?.name ?? '',
      cycle: charge.billing_cycle === 'annual' ? 'Anual' : 'Mensal',
      coupon: charge.coupon_id ? (cupons.get(Number(charge.coupon_id))?.code ?? `#${charge.coupon_id}`) : '',
      ...conta,
      dueDate: vencimento ?? '',
      status: STATUS_LABELS[charge.status] ?? String(charge.status ?? ''),
      statusCode: charge.status,
      billingType: formaDeCobranca(charge),
      paidAtMs: pago ? instanteMs(pago.created_at) : null,
      paymentMethod: pago ? formaDoPagamento(pago, detalheDe(pago)) : '',
      gatewayChargeId: charge.gateway_charge_id ?? '',
      invoiceNumber: nota?.number ?? ''
    });
  }
  linhasCobranca.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || (a.id - b.id));

  // ── Pagamentos e estornos: o extrato do período ──
  const linhasPagamento = [];
  const linhasEstorno = [];
  let receivedCents = 0;
  let refundedCents = 0;
  for (const evento of events) {
    const dono = provedores.get(Number(evento.tenant_id));
    if (!dono) continue;
    const ms = instanteMs(evento.created_at);
    if (!dentro(ms)) continue;
    const valor = inteiro(evento.amount_cents);
    const detalhe = detalheDe(evento);
    if (evento.type === BILLING_EVENT_TYPES.PAYMENT_REFUNDED) {
      refundedCents += valor;
      const ref = detalhe.reference
        ?? (String(evento.external_id ?? '').endsWith(':refund') ? String(evento.external_id).slice(0, -':refund'.length) : '');
      const charge = ref ? cobrancaPorRef.get(`${Number(evento.tenant_id)}|${ref}`) : null;
      linhasEstorno.push({ atMs: ms, ...dono, amountCents: valor, chargeId: charge ? Number(charge.id) : null, reference: ref ?? '' });
      continue;
    }
    if (evento.type !== BILLING_EVENT_TYPES.PAYMENT_RECORDED) continue;
    receivedCents += valor;
    // O aceite da diferença é um evento de zero que só destrava o período.
    if (!valor) continue;
    const ref = evento.external_id ? String(evento.external_id) : '';
    const charge = ref ? cobrancaPorRef.get(`${Number(evento.tenant_id)}|${ref}`) : null;
    const notas = [];
    if (detalhe.proration) notas.push('Pró-rata');
    if (detalhe.underpaid) notas.push('Pago a menos');
    if (!ref) notas.push('Lançamento manual');
    linhasPagamento.push({
      atMs: ms,
      paidOn: /^\d{4}-\d{2}-\d{2}$/.test(String(detalhe.paidOn ?? '')) ? String(detalhe.paidOn) : diaSp(ms),
      ...dono,
      amountCents: valor,
      method: formaDoPagamento(evento, detalhe),
      chargeId: charge ? Number(charge.id) : (detalhe.chargeId ? Number(detalhe.chargeId) : null),
      reference: ref,
      note: notas.join('; ')
    });
  }
  linhasPagamento.sort((a, b) => a.atMs - b.atMs);
  linhasEstorno.sort((a, b) => a.atMs - b.atMs);

  // ── Créditos ──
  const linhasCredito = [];
  let creditsGrantedCents = 0;
  let creditsConsumedCents = 0;
  for (const credito of credits) {
    const dono = provedores.get(Number(credito.tenant_id));
    if (!dono) continue;
    const valor = inteiro(credito.amount_cents);
    const criado = instanteMs(credito.created_at);
    if (dentro(criado)) {
      creditsGrantedCents += valor;
      linhasCredito.push({
        atMs: criado, ...dono,
        type: credito.source === 'referral' ? 'Concessão (indicação)' : 'Ajuste manual',
        amountCents: valor, chargeId: null, creditId: Number(credito.id), reference: credito.reference ?? ''
      });
    }
    const cancelado = instanteMs(credito.canceled_at);
    if (dentro(cancelado)) {
      linhasCredito.push({
        atMs: cancelado, ...dono, type: 'Cancelamento', amountCents: -valor,
        chargeId: null, creditId: Number(credito.id), reference: credito.reference ?? ''
      });
    }
  }
  for (const alocacao of allocations) {
    const dono = provedores.get(Number(alocacao.tenant_id));
    if (!dono) continue;
    const ms = instanteMs(alocacao.updated_at);
    if (!dentro(ms)) continue;
    const valor = inteiro(alocacao.amount_cents);
    const charge = cobrancas.get(Number(alocacao.charge_id));
    let tipo = null;
    let sinal = 0;
    if (alocacao.status === 'consumed') {
      tipo = 'Consumo';
      sinal = -1;
      creditsConsumedCents += valor;
    } else if (alocacao.status === 'released' && charge?.status === 'refunded') {
      // A cobrança paga com crédito foi estornada: o crédito voltou ao saldo.
      tipo = 'Devolução (estorno)';
      sinal = 1;
    }
    if (!tipo) continue;
    linhasCredito.push({
      atMs: ms, ...dono, type: tipo, amountCents: sinal * valor,
      chargeId: Number(alocacao.charge_id), creditId: Number(alocacao.credit_id), reference: ''
    });
  }
  linhasCredito.sort((a, b) => a.atMs - b.atMs);

  // ── NFS-e ──
  const linhasNota = [];
  let invoicesIssued = 0;
  for (const nota of invoices) {
    const dono = provedores.get(Number(nota.tenant_id));
    if (!dono) continue;
    const emitida = instanteMs(nota.issued_at);
    const quando = emitida ?? instanteMs(nota.created_at);
    if (!dentro(quando)) continue;
    if (nota.status === 'authorized') invoicesIssued += 1;
    const charge = cobrancas.get(Number(nota.charge_id));
    linhasNota.push({
      number: nota.number ?? '',
      status: INVOICE_STATUS_LABELS[nota.status] ?? String(nota.status ?? ''),
      issuedAtMs: emitida,
      ...dono,
      chargeId: Number(nota.charge_id),
      amountCents: charge ? inteiro(charge.amount_cents) : null,
      pdfUrl: nota.pdf_url ?? '',
      xmlUrl: nota.xml_url ?? '',
      ordem: quando
    });
  }
  linhasNota.sort((a, b) => a.ordem - b.ordem);

  // ── Resumo ──
  const validas = linhasCobranca.filter((l) => l.statusCode !== 'canceled');
  const soma = (campo) => validas.reduce((total, l) => total + l[campo], 0);
  const totals = {
    chargesCount: validas.length,
    canceledCount: linhasCobranca.length - validas.length,
    grossCents: soma('grossCents'),
    couponDiscountCents: soma('couponDiscountCents'),
    creditCents: soma('creditCents'),
    overageCents: soma('overageCents'),
    adjustmentCents: soma('adjustmentCents'),
    netCents: soma('netCents'),
    paymentsCount: linhasPagamento.length,
    receivedCents,
    refundedCents,
    netReceivedCents: receivedCents - refundedCents,
    creditsGrantedCents,
    creditsConsumedCents,
    invoicesIssued
  };
  const dataBr = (dia) => String(dia).split('-').reverse().join('/');
  const empresa = [company.legalName || company.tradeName || '', company.taxId ? formatTaxId(company.taxId) : '']
    .filter(Boolean).join(' — ');
  const resumo = [
    { label: 'Empresa', value: empresa },
    { label: 'Período', value: `${dataBr(range.from)} a ${dataBr(range.to)} (horário de Brasília)` },
    { label: 'Gerado em', value: { datetime: now.getTime() } },
    { label: 'Cobranças no período (sem as canceladas)', value: totals.chargesCount },
    { label: 'Cobranças canceladas', value: totals.canceledCount },
    { label: 'Valor bruto cobrado', value: { money: totals.grossCents } },
    { label: 'Descontos de cupom', value: { money: totals.couponDiscountCents } },
    { label: 'Créditos usados', value: { money: totals.creditCents } },
    { label: 'Excedente', value: { money: totals.overageCents } },
    { label: 'Ajustes manuais', value: { money: totals.adjustmentCents } },
    { label: 'Valor líquido cobrado', value: { money: totals.netCents } },
    { label: 'Pagamentos recebidos', value: totals.paymentsCount },
    { label: 'Recebido', value: { money: totals.receivedCents } },
    { label: 'Estornado', value: { money: totals.refundedCents } },
    { label: 'Recebido líquido', value: { money: totals.netReceivedCents } },
    { label: 'Créditos concedidos', value: { money: totals.creditsGrantedCents } },
    { label: 'Créditos consumidos', value: { money: totals.creditsConsumedCents } },
    { label: 'NFS-e emitidas', value: totals.invoicesIssued }
  ];

  return {
    from: range.from,
    to: range.to,
    generatedAtMs: now.getTime(),
    totals,
    sheets: {
      cobrancas: linhasCobranca,
      pagamentos: linhasPagamento,
      estornos: linhasEstorno,
      creditos: linhasCredito,
      nfse: linhasNota,
      resumo
    }
  };
}

/** As linhas cruas que a exportação lê, numa leitura só de cada tabela. */
async function carregar() {
  const [tenants, subscriptions, plans] = await Promise.all([
    Tenant.list(), Subscription.listWithPlans(), Plan.list()
  ]);
  const db = () => getDb();
  const motivo = 'the console accounting export reads every provider\'s billing';
  // tenant-scope-exempt: exportação contábil do plano de controle, acima dos provedores.
  const charges = await runUnscoped(motivo, () => db()('billing_charges').select(
    'id', 'tenant_id', 'subscription_id', 'kind', 'amount_cents', 'currency', 'status', 'due_date',
    'gateway_charge_id', 'superseded_charges', 'plan_id', 'coupon_id', 'billing_cycle', 'pricing_detail',
    'billing_type', 'credit_reserved_cents', 'amount_overridden_at', 'created_at', 'updated_at'
  ).orderBy('id', 'asc'));
  // tenant-scope-exempt: idem — o extrato dos pagamentos e estornos, como a receita.
  const events = await runUnscoped(motivo, () => db()('billing_events')
    .whereIn('type', [BILLING_EVENT_TYPES.PAYMENT_RECORDED, BILLING_EVENT_TYPES.PAYMENT_REFUNDED])
    .select('tenant_id', 'subscription_id', 'type', 'provider', 'external_id', 'amount_cents', 'detail', 'created_at'));
  // tenant-scope-exempt: idem — as notas fiscais de todos os provedores.
  const invoices = await runUnscoped(motivo, () => db()('billing_invoices')
    .select('id', 'tenant_id', 'charge_id', 'status', 'number', 'pdf_url', 'xml_url', 'issued_at', 'created_at'));
  // tenant-scope-exempt: idem — os créditos concedidos e cancelados.
  const credits = await runUnscoped(motivo, () => db()('tenant_credits')
    .select('id', 'tenant_id', 'amount_cents', 'source', 'reference', 'canceled_at', 'created_at'));
  // tenant-scope-exempt: idem — o crédito gasto (e devolvido) por cobrança.
  const allocations = await runUnscoped(motivo, () => db()('credit_allocations')
    .whereIn('status', ['consumed', 'released'])
    .select('id', 'tenant_id', 'credit_id', 'charge_id', 'amount_cents', 'status', 'updated_at'));
  // Os cupons são do catálogo do deploy (sem provedor): só o código.
  const coupons = await db()('coupons').select('id', 'code');
  const { values } = await readProfile().catch(() => ({ values: {} }));
  return {
    tenants, subscriptions, plans, charges, events, invoices, credits, allocations, coupons,
    company: { legalName: values.legalName ?? null, tradeName: values.tradeName ?? null, taxId: values.taxId ?? null }
  };
}

/** A exportação do período, lida do banco. */
export async function build(range, { now = new Date() } = {}) {
  return buildAccountingExport({ range, now, ...(await carregar()) });
}

// ── Formatos ─────────────────────────────────────────────────────────────

/** Centavos como o Excel em português lê: vírgula decimal, sem milhar. */
const reais = (centavos) => (inteiro(centavos) / 100).toFixed(2).replace('.', ',');

/** `dd/mm/aaaa` de um `AAAA-MM-DD`. */
const dataBr = (dia) => (dia ? String(dia).slice(0, 10).split('-').reverse().join('/') : '');

/** `dd/mm/aaaa hh:mm` de um instante, em Brasília. */
function dataHoraBr(ms) {
  if (ms === null || ms === undefined) return '';
  const p = partesSp(ms);
  const d = (n) => String(n).padStart(2, '0');
  return `${d(p.dia)}/${d(p.mes)}/${p.ano} ${d(p.hora)}:${d(p.minuto)}`;
}

/** Um valor da planilha como texto do CSV. */
function textoDoCsv(tipo, valor) {
  if (valor === null || valor === undefined || valor === '') return '';
  if (tipo === 'money') return reais(valor);
  if (tipo === 'date') return dataBr(valor);
  if (tipo === 'datetime') return dataHoraBr(valor);
  if (tipo === 'auto' && typeof valor === 'object') {
    if ('money' in valor) return reais(valor.money);
    if ('datetime' in valor) return dataHoraBr(valor.datetime);
  }
  return valor;
}

/**
 * Uma aba como CSV brasileiro: BOM, `;`, CRLF, vírgula decimal, datas
 * `dd/mm/aaaa` — e a célula que pareceria fórmula sai com apóstrofo
 * (`csvCell`).
 */
export function toAccountingCsv(exportacao, sheet = DEFAULT_SHEET) {
  const colunas = ACCOUNTING_COLUMNS[sheet];
  if (!colunas) throw new Error(`Unknown accounting sheet ${sheet}`);
  const linhas = exportacao.sheets[sheet].map((linha) => Object.fromEntries(
    colunas.map((c) => [c.field, textoDoCsv(c.type, linha[c.field])])
  ));
  return toCsvWith(colunas, linhas);
}

/**
 * Um instante como a data que o Excel mostra: o relógio de Brasília escrito
 * como se fosse UTC — o XLSX não tem fuso, e a célula tem de mostrar a hora
 * de Brasília em qualquer computador.
 */
function dataDoExcel(ms) {
  const p = partesSp(ms);
  return new Date(Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo));
}

const FORMATO_DINHEIRO = '#,##0.00';
const FORMATO_DATA = 'dd/mm/yyyy';
const FORMATO_DATA_HORA = 'dd/mm/yyyy hh:mm';

/** Um valor da planilha como célula do XLSX: número, data ou texto. */
function celulaDoXlsx(tipo, valor) {
  if (valor === null || valor === undefined || valor === '') return { value: null };
  if (tipo === 'money') return { value: inteiro(valor) / 100, numFmt: FORMATO_DINHEIRO };
  if (tipo === 'int') return { value: inteiro(valor) };
  if (tipo === 'date') {
    const [a, m, d] = String(valor).slice(0, 10).split('-').map(Number);
    return { value: new Date(Date.UTC(a, m - 1, d)), numFmt: FORMATO_DATA };
  }
  if (tipo === 'datetime') return { value: dataDoExcel(valor), numFmt: FORMATO_DATA_HORA };
  if (tipo === 'auto' && typeof valor === 'object') {
    if ('money' in valor) return celulaDoXlsx('money', valor.money);
    if ('datetime' in valor) return celulaDoXlsx('datetime', valor.datetime);
  }
  // Texto é sempre texto no XLSX (só `{ formula }` vira fórmula), então não
  // precisa do apóstrofo do CSV.
  return { value: typeof valor === 'number' ? valor : String(valor) };
}

/** As seis abas num XLSX só, como `Buffer`. */
export async function toAccountingXlsx(exportacao) {
  const livro = new ExcelJS.Workbook();
  livro.creator = 'Exportação contábil';
  livro.created = new Date(exportacao.generatedAtMs);
  for (const sheet of ACCOUNTING_SHEETS) {
    const colunas = ACCOUNTING_COLUMNS[sheet];
    const aba = livro.addWorksheet(SHEET_TITLES[sheet], { views: [{ state: 'frozen', ySplit: 1 }] });
    aba.columns = colunas.map((c) => ({ header: c.header, key: c.field, width: c.width ?? Math.max(12, c.header.length + 2) }));
    aba.getRow(1).font = { bold: true };
    for (const linha of exportacao.sheets[sheet]) {
      const row = aba.addRow([]);
      colunas.forEach((c, indice) => {
        const { value, numFmt } = celulaDoXlsx(c.type, linha[c.field]);
        const cell = row.getCell(indice + 1);
        cell.value = value;
        if (numFmt) cell.numFmt = numFmt;
      });
    }
  }
  return Buffer.from(await livro.xlsx.writeBuffer());
}

/** O nome do arquivo de um formato (e aba, no CSV). */
export function accountingFilename(exportacao, format, sheet = DEFAULT_SHEET) {
  const periodo = `${exportacao.from}-a-${exportacao.to}`;
  return format === 'xlsx' ? `contabilidade-${periodo}.xlsx` : `contabilidade-${sheet}-${periodo}.csv`;
}

/**
 * Os anexos do e-mail ao contador: o XLSX, ou os seis CSVs (um por aba).
 * @returns {Promise<Array<{ filename: string, content: Buffer, contentType: string }>>}
 */
export async function accountingAttachments(exportacao, format) {
  if (format === 'xlsx') {
    return [{
      filename: accountingFilename(exportacao, 'xlsx'),
      content: await toAccountingXlsx(exportacao),
      contentType: XLSX_CONTENT_TYPE
    }];
  }
  return ACCOUNTING_SHEETS.map((sheet) => ({
    filename: accountingFilename(exportacao, 'csv', sheet),
    content: Buffer.from(toAccountingCsv(exportacao, sheet), 'utf8'),
    contentType: 'text/csv; charset=utf-8'
  }));
}

export default {
  build, parseAccountingRange, buildAccountingExport, toAccountingCsv, toAccountingXlsx, accountingAttachments,
  accountingFilename, ACCOUNTING_FORMATS, ACCOUNTING_SHEETS
};
