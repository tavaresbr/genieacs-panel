import { tdb } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';
import BillingCharge, { CHARGE_STATUSES, OPEN_CHARGE_STATUSES } from '../models/BillingCharge.js';
import { BILLING_EVENT_TYPES } from '../models/BillingEvent.js';
import Coupon from '../models/Coupon.js';
import * as asaasClient from './billing/asaasClient.js';

/**
 * As faturas do provedor, vistas DE DENTRO: o histórico com o dia e o meio de
 * cada pagamento, a "segunda via" de uma cobrança em aberto e o que o recibo
 * precisa saber de uma paga.
 *
 * Tudo por `tdb`, dentro do escopo que a sessão abriu: quem chama é a rota do
 * provedor, e uma cobrança de outro provedor simplesmente não existe aqui —
 * 404, e nunca 403, pelo motivo da varredura (`tenant-id-sweep.test.js`).
 *
 * Nada aqui ESCREVE em cobrança nenhuma. A segunda via só lê o gateway: a
 * página, o QR do Pix e a linha digitável que valem agora. Uma leitura que
 * falha é um 502 e mais nada — a linha da cobrança fica como estava.
 */

export class TenantChargeError extends Error {
  constructor(message, { status = 400, code = 'invalid_request', detail = null } = {}) {
    super(message);
    this.name = 'TenantChargeError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Os filtros de estado que a lista aceita: os da coluna, e `open` (os três em aberto). */
export const STATUS_FILTERS = Object.freeze(['open', ...CHARGE_STATUSES]);

/** Os meios que o recibo e a lista nomeiam. O resto vira `null` — "não informado". */
const MEIOS = new Set(['PIX', 'BOLETO', 'CREDIT_CARD', 'DEBIT_CARD', 'TRANSFER', 'DEPOSIT', 'MANUAL']);

/** O teto de uma página de ano: uma por mês, mais as avulsas, cabe com folga. */
const TETO_POR_ANO = 200;

/**
 * Quantas linhas se leem para separar por ano. O ano é decidido aqui, e não
 * num `WHERE`: no SQLite o `created_at` do default é texto e o gravado pelo
 * código é número, e uma comparação no banco mistura os dois em silêncio. Um
 * provedor tem uma dúzia de cobranças por ano; mil são décadas.
 */
const LEITURA_POR_ANO = 1000;

/** O ano de um instante no horário de Brasília, que é o da cobrança. */
function anoDe(valor) {
  const data = comoData(valor);
  if (!data) return null;
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric' }).format(data));
}

/** O id que uma baixa pelo console grava quando a cobrança não chegou ao gateway. */
const referenciaManual = (linha) => `charge:${linha.id}`;

/** Um instante do banco (Date, ISO, ou milissegundos do SQLite) como Date — ou nulo. */
function comoData(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  const texto = String(valor);
  // O `CURRENT_TIMESTAMP` do SQLite vem como texto sem fuso, e é UTC.
  const semFuso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(texto) ? `${texto.replace(' ', 'T')}Z` : texto;
  const data = /^\d+$/.test(texto) ? new Date(Number(texto)) : new Date(semFuso);
  return Number.isNaN(data.getTime()) ? null : data;
}

function lerDetalhe(bruto) {
  if (!bruto) return {};
  try {
    const lido = typeof bruto === 'string' ? JSON.parse(bruto) : bruto;
    return lido && typeof lido === 'object' ? lido : {};
  } catch {
    return {};
  }
}

/**
 * Os ids que podem ter quitado esta linha no extrato: o do gateway, os que a
 * troca de plano substituiu (o boleto velho ainda paga o período) e o da baixa
 * manual sem gateway.
 */
function referenciasDe(linha) {
  const ids = [referenciaManual(linha)];
  if (linha.gateway_charge_id) ids.push(String(linha.gateway_charge_id));
  for (const item of BillingCharge.supersededOf(linha)) ids.push(String(item.id));
  return ids.map((id) => id.slice(0, 128));
}

/**
 * O meio do pagamento, de onde houver: o que o webhook gravou (pagamentos
 * novos), a baixa manual do console, ou a cobrança de cartão salvo. Nulo
 * quando ninguém disse — pagamentos de antes desta versão.
 */
function meioDe(evento, detalhe, linha) {
  const gravado = String(detalhe.paymentMethod ?? '').toUpperCase();
  if (MEIOS.has(gravado)) return gravado;
  if (evento?.provider === 'manual') return 'MANUAL';
  if (String(linha.billing_type ?? '').toUpperCase() === 'CREDIT_CARD') return 'CREDIT_CARD';
  return null;
}

/**
 * O que o extrato sabe do pagamento de cada linha: quando, como, o desconto
 * por antecipação e o cupom. Uma consulta só para a página inteira.
 *
 * @returns {Promise<Map<number, object>>} por id da cobrança.
 */
export async function paymentFactsFor(linhas) {
  const fatos = new Map();
  const pagas = (linhas || []).filter((linha) => ['paid', 'refunded'].includes(linha.status));
  const porReferencia = new Map();
  for (const linha of pagas) {
    for (const ref of referenciasDe(linha)) porReferencia.set(ref, linha);
  }
  if (porReferencia.size) {
    const eventos = await tdb('billing_events')
      .where({ type: BILLING_EVENT_TYPES.PAYMENT_RECORDED })
      .whereIn('external_id', [...porReferencia.keys()])
      .orderBy('id', 'asc');
    for (const evento of eventos) {
      const linha = porReferencia.get(String(evento.external_id));
      // O primeiro pagamento de cada linha é o que a quitou; o resto (o aceite
      // da diferença, `:accepted`) nem chega aqui, que não é referência dela.
      if (!linha || fatos.has(Number(linha.id))) continue;
      const detalhe = lerDetalhe(evento.detail);
      const dia = /^\d{4}-\d{2}-\d{2}$/.test(String(detalhe.paidOn ?? ''))
        ? detalhe.paidOn
        : detalhe.earlyPaymentDiscount?.paidOn ?? null;
      const registrado = comoData(evento.created_at);
      fatos.set(Number(linha.id), {
        paidAt: dia || (registrado ? registrado.toISOString() : null),
        paidCents: Number(evento.amount_cents) || 0,
        paymentMethod: meioDe(evento, detalhe, linha),
        earlyDiscountCents: Number(detalhe.earlyPaymentDiscount?.discountCents) > 0
          ? Number(detalhe.earlyPaymentDiscount.discountCents) : 0,
        couponCode: detalhe.coupon?.code ? String(detalhe.coupon.code).slice(0, 64) : null
      });
    }
  }
  // O cupom pela linha, quando o pagamento não o nomeou (ou não houve pagamento).
  const semCupom = (linhas || []).filter((linha) => linha.coupon_id && !fatos.get(Number(linha.id))?.couponCode);
  const cupons = new Map();
  for (const id of new Set(semCupom.map((linha) => Number(linha.coupon_id)))) {
    // `coupons` é tabela da plataforma, sem `tenant_id`: o código é o que o
    // provedor digitou, e é dele ver qual usou.
    const cupom = await Coupon.findById(id).catch(() => null);
    if (cupom?.code) cupons.set(id, String(cupom.code).slice(0, 64));
  }
  for (const linha of semCupom) {
    const codigo = cupons.get(Number(linha.coupon_id));
    if (!codigo) continue;
    const atual = fatos.get(Number(linha.id)) ?? {
      paidAt: null, paidCents: null, paymentMethod: null, earlyDiscountCents: 0, couponCode: null
    };
    fatos.set(Number(linha.id), { ...atual, couponCode: codigo });
  }
  return fatos;
}

/** A linha como a tela de faturas a mostra: o `present` de sempre, mais o pagamento. */
export function presentWithFacts(linha, nota, fatos) {
  const base = BillingCharge.present(linha, nota);
  const fato = fatos.get(Number(linha.id)) ?? null;
  return {
    ...base,
    paidAt: fato?.paidAt ?? null,
    paymentMethod: fato?.paymentMethod ?? null,
    earlyDiscountCents: fato?.earlyDiscountCents ?? 0,
    couponCode: fato?.couponCode ?? null,
    // O recibo só da que está paga: a estornada não tem o que comprovar.
    receiptAvailable: linha.status === 'paid',
    // A segunda via só da que ainda se paga E chegou ao gateway.
    paymentInfoAvailable: ['pending', 'overdue'].includes(linha.status) && Boolean(linha.gateway_charge_id)
      && linha.provider === 'asaas'
  };
}

/** Lê e confere `?year=` e `?status=`. Ausentes, nulos; inválidos, 400. */
export function parseFilters(query = {}) {
  let year = null;
  if (query.year !== undefined && query.year !== '') {
    year = Number(query.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new TenantChargeError('invalid year', { code: 'invalid_filter' });
    }
  }
  let status = null;
  if (query.status !== undefined && query.status !== '') {
    status = String(query.status);
    if (!STATUS_FILTERS.includes(status)) throw new TenantChargeError('invalid status', { code: 'invalid_filter' });
  }
  return { year, status };
}

/**
 * As cobranças deste provedor com os filtros: sem ano, as 24 mais recentes (o
 * que a tela sempre mostrou, e o que o muro do 402 lê); com ano, todas as
 * emitidas naquele ano, até o teto.
 */
export async function listCharges({ year = null, status = null } = {}) {
  let query = tdb('billing_charges');
  if (status === 'open') query = query.whereIn('status', OPEN_CHARGE_STATUSES);
  else if (status) query = query.where({ status });
  if (!year) return query.orderBy('id', 'desc').limit(24);
  const linhas = await query.orderBy('id', 'desc').limit(LEITURA_POR_ANO);
  return linhas.filter((linha) => anoDe(linha.created_at) === year).slice(0, TETO_POR_ANO);
}

/** Os anos em que há cobrança deste provedor, do mais recente ao mais antigo. */
export async function chargeYears() {
  const linhas = await tdb('billing_charges').select('created_at').orderBy('id', 'desc').limit(LEITURA_POR_ANO);
  const anos = new Set(linhas.map((linha) => anoDe(linha.created_at)).filter((ano) => Number.isInteger(ano)));
  return [...anos].sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// A segunda via
// ---------------------------------------------------------------------------

/**
 * O cache curto da segunda via, por provedor e cobrança. Curto porque o QR do
 * Pix expira e a cobrança pode ser paga a qualquer momento; existe só para
 * que três cliques no botão não virem nove chamadas ao gateway.
 */
const CACHE_MS = 60_000;
const CACHE_MAX = 500;
const cache = new Map();

/** Para os testes: o gateway de mentira muda entre um caso e outro. */
export function clearPaymentInfoCache() {
  cache.clear();
}

/** Só `https:` vira link na tela do provedor. */
function urlSegura(valor) {
  try {
    const url = new URL(String(valor ?? ''));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** O PNG do QR, em base64 puro — qualquer outra coisa não vai para um `src`. */
function imagemSegura(valor) {
  const texto = String(valor ?? '').replace(/\s+/g, '');
  return texto && texto.length <= 200_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(texto) ? texto : null;
}

/** O gateway diz que a cobrança já está paga — a linha daqui só não soube ainda. */
const PAGA_NO_GATEWAY = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

/**
 * A segunda via de uma cobrança em aberto deste provedor: a página atual, a
 * linha digitável do boleto e o QR do Pix, lidos do gateway agora.
 *
 * As duas leituras extras (boleto e Pix) falham sozinhas: a cobrança só de Pix
 * não tem linha digitável, e a recusa dessa leitura não pode esconder o QR. Só
 * a leitura da cobrança em si derruba a resposta — sem ela não há o que dizer.
 */
export async function paymentInfo(chargeId, { client = asaasClient, now = Date.now() } = {}) {
  const linha = await BillingCharge.findById(chargeId);
  if (!linha) throw new TenantChargeError('charge not found', { status: 404, code: 'charge_not_found' });
  if (!['pending', 'overdue'].includes(linha.status)) {
    throw new TenantChargeError('the charge is not open', { status: 409, code: 'not_open', detail: { status: linha.status } });
  }
  if (!linha.gateway_charge_id || linha.provider !== 'asaas') {
    throw new TenantChargeError('the charge has no gateway payment', { status: 409, code: 'no_gateway_charge' });
  }

  const chave = `${currentTenantId()}:${linha.id}:${linha.gateway_charge_id}`;
  const guardado = cache.get(chave);
  if (guardado && guardado.expiresAt > now) return guardado.value;

  let cobranca;
  try {
    cobranca = await client.getCharge(linha.gateway_charge_id);
  } catch (error) {
    throw new TenantChargeError(`gateway read failed: ${error.message}`, {
      status: 502, code: 'gateway_failed', detail: { gatewayCode: error.code ?? null }
    });
  }
  const situacao = String(cobranca?.status ?? '').toUpperCase();
  if (PAGA_NO_GATEWAY.has(situacao)) {
    // Não grava nada: quem quita a linha é o webhook, que credita junto.
    throw new TenantChargeError('the gateway already has this charge as paid', { status: 409, code: 'already_paid' });
  }

  const meio = String(cobranca?.billingType ?? linha.billing_type ?? 'UNDEFINED').toUpperCase();
  const lerBoleto = meio === 'BOLETO' || meio === 'UNDEFINED';
  const lerPix = meio === 'PIX' || meio === 'UNDEFINED' || meio === 'BOLETO';
  const [boleto, pix] = await Promise.all([
    lerBoleto ? client.getIdentificationField(linha.gateway_charge_id).catch(() => null) : null,
    lerPix ? client.getPixQrCode(linha.gateway_charge_id).catch(() => null) : null
  ]);

  const value = {
    chargeId: Number(linha.id),
    status: linha.status,
    amountCents: Number(linha.amount_cents),
    currency: linha.currency,
    dueDate: cobranca?.dueDate ?? (linha.due_date ? String(linha.due_date).slice(0, 10) : null),
    billingType: meio,
    invoiceUrl: urlSegura(cobranca?.invoiceUrl) ?? urlSegura(linha.invoice_url),
    boleto: boleto?.identificationField ? {
      identificationField: String(boleto.identificationField).slice(0, 128),
      barCode: boleto.barCode ? String(boleto.barCode).slice(0, 128) : null,
      bankSlipUrl: urlSegura(cobranca?.bankSlipUrl)
    } : null,
    pix: pix?.payload ? {
      payload: String(pix.payload).slice(0, 1024),
      encodedImage: imagemSegura(pix.encodedImage),
      expirationDate: pix.expirationDate ? String(pix.expirationDate).slice(0, 32) : null
    } : null,
    fetchedAt: new Date(now).toISOString()
  };

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(chave, { value, expiresAt: now + CACHE_MS });
  return value;
}

export default {
  STATUS_FILTERS, paymentFactsFor, presentWithFacts, parseFilters, listCharges, chargeYears, paymentInfo,
  clearPaymentInfoCache, TenantChargeError
};
