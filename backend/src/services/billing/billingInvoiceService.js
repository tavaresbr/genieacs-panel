import { isUniqueViolation } from '../../config/database.js';
import { runInTenant } from '../../config/tenantContext.js';
import BillingCharge from '../../models/BillingCharge.js';
import BillingInvoice, { REISSUABLE_INVOICE_STATUSES } from '../../models/BillingInvoice.js';
import {
  AsaasError, authorizeInvoice, cancelInvoice, createInvoice, getInvoice, listInvoicesForPayment
} from './asaasClient.js';
import { effectiveApiKey, effectiveNfseConfig } from './asaasSettingsService.js';

/**
 * A NFS-e das cobranças pagas, pela Asaas.
 *
 * ## Três tempos, e só um fala com a Asaas
 *
 * 1. **A fila** (`enqueueForCharge`): o pagamento confirmado — pelo webhook ou
 *    pela baixa do console — grava uma linha `pending` e mais nada. Nunca se
 *    chama a Asaas dali: o webhook precisa responder rápido e não pode falhar
 *    porque a emissão de nota está fora do ar, e o dinheiro já está creditado
 *    quando esta linha nasce.
 * 2. **O agendador** (`processDue`): pede a nota (`POST /invoices`), guarda o
 *    id ANTES de autorizar e autoriza; com tentativas e espera crescente na
 *    falha. E consulta as agendadas até a prefeitura responder.
 * 3. **O webhook** (`applyWebhook`): `INVOICE_*` atualiza a linha que a Asaas
 *    nomeia, e só ela — nota que o painel não conhece é ignorada.
 *
 * ## Nota não se apaga
 *
 * Uma cobrança duplicada se cancela e ninguém viu; uma nota fiscal duplicada é
 * um documento na prefeitura, com cancelamento sujeito a prazo e a recusa. Por
 * isso a garra (`BillingInvoice.claim`), o id gravado antes da autorização, e
 * a conferência no gateway antes de recriar o que pode ter sido criado numa
 * resposta perdida (`listInvoicesForPayment`).
 */

/** Quanto tempo a passada segura a linha enquanto fala com a Asaas. */
const CLAIM_MS = 5 * 60 * 1000;

/** De quanto em quanto tempo se pergunta pela nota agendada. */
export const POLL_INTERVAL_MS = 10 * 60 * 1000;

/** Tentativas de pedir a nota antes de desistir e deixá-la para o console. */
export const MAX_ATTEMPTS = 8;

/** Quantas notas uma passada leva adiante, por provedor. */
const BATCH = 5;

/** A espera depois da tentativa `n` (1, 2, …): 5 min dobrando, até 12 h. */
export function backoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(5 * 60 * 1000 * 2 ** (n - 1), 12 * 60 * 60 * 1000);
}

/** O estado da Asaas no vocabulário da tabela — ou nulo, quando não muda nada. */
export function statusFromGateway(status) {
  switch (String(status ?? '').toUpperCase()) {
    case 'SCHEDULED':
    case 'SYNCHRONIZED':
    case 'AUTHORIZATION_PENDING':
      return 'scheduled';
    case 'AUTHORIZED':
    // A prefeitura recusou o CANCELAMENTO: a nota continua valendo.
    case 'CANCELLATION_DENIED':
      return 'authorized';
    case 'ERROR':
      return 'error';
    case 'CANCELED':
    case 'CANCELLED':
      return 'canceled';
    default:
      return null;
  }
}

/** O estado que o EVENTO afirma, para quando o corpo não traz `status`. */
const STATUS_DO_EVENTO = Object.freeze({
  INVOICE_AUTHORIZED: 'authorized',
  INVOICE_ERROR: 'error',
  INVOICE_CANCELED: 'canceled',
  INVOICE_CANCELLATION_DENIED: 'authorized'
});

/**
 * De que estado a linha pode ir para cada um. O webhook reentrega e não
 * garante ordem: um `INVOICE_UPDATED` atrasado com `SCHEDULED` não pode
 * desfazer uma nota já autorizada, nem reabrir uma cancelada.
 */
const TRANSICOES = Object.freeze({
  scheduled: new Set(['pending', 'scheduled', 'error']),
  // Não de `canceled`: um `INVOICE_AUTHORIZED` atrasado não desfaz o
  // cancelamento do estorno. A volta de cancelada para autorizada é só a da
  // recusa do cancelamento, tratada à parte em `applyWebhook`.
  authorized: new Set(['pending', 'scheduled', 'error', 'authorized']),
  error: new Set(['pending', 'scheduled']),
  canceled: new Set(['pending', 'scheduled', 'authorized', 'error'])
});

/** `YYYY-MM-DD` de hoje, no relógio do processo — a data de competência da nota. */
function hojeIso(now = new Date()) {
  const mes = String(now.getMonth() + 1).padStart(2, '0');
  const dia = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mes}-${dia}`;
}

/** O que gravar na linha a partir de uma resposta da Asaas. */
function patchDaNota(nota, statusAtual, now = new Date()) {
  const status = statusFromGateway(nota.status);
  const patch = {};
  if (status && TRANSICOES[status]?.has(statusAtual)) patch.status = status;
  const final = patch.status ?? statusAtual;
  if (nota.number) patch.number = nota.number;
  if (nota.pdfUrl) patch.pdf_url = nota.pdfUrl;
  if (nota.xmlUrl) patch.xml_url = nota.xmlUrl;
  if (final === 'authorized') {
    patch.error = null;
    if (patch.status === 'authorized' && statusAtual !== 'authorized') patch.issued_at = now;
  } else if (final === 'error') {
    patch.error = nota.statusDescription || 'The city hall refused the invoice';
  }
  return patch;
}

/** O corpo do `POST /invoices`, da configuração e da cobrança. */
export function invoicePayload(config, charge, now = new Date()) {
  return {
    payment: String(charge.gateway_charge_id),
    serviceDescription: config.serviceDescription,
    // A Asaas pede o campo; sem observação configurada, o período da cobrança
    // é o que melhor explica a nota a quem a lê.
    observations: config.observations || `Período até ${String(charge.period_end).slice(0, 10)}`,
    valueCents: Number(charge.amount_cents),
    deductions: 0,
    effectiveDate: hojeIso(now),
    ...(config.municipalServiceId ? { municipalServiceId: config.municipalServiceId } : {}),
    ...(config.municipalServiceCode ? { municipalServiceCode: config.municipalServiceCode } : {}),
    ...(config.municipalServiceName ? { municipalServiceName: config.municipalServiceName } : {}),
    externalReference: `charge:${charge.id}`,
    taxes: {
      retainIss: Boolean(config.retainIss),
      iss: Number(config.issPercent) || 0,
      cofins: 0,
      csll: 0,
      inss: 0,
      ir: 0,
      pis: 0
    }
  };
}

function motivo(error) {
  return String(error?.message ?? error ?? 'unknown error').slice(0, 500);
}

class BillingInvoiceService {
  /**
   * Põe a nota de uma cobrança paga na fila — no escopo do provedor dela.
   *
   * Idempotente pela cobrança: a segunda chamada (o webhook reentregue, a
   * baixa depois do webhook) encontra a linha e não faz nada. Nunca lança:
   * quem chama acabou de creditar dinheiro, e a nota é consequência, não
   * condição.
   *
   * @returns {Promise<{ enqueued: boolean, reason?: string }>}
   */
  static async enqueueForCharge(charge) {
    try {
      if (!charge?.id) return { enqueued: false, reason: 'no_charge' };
      // Só o que passou pelo gateway: a nota da Asaas é de um PAGAMENTO dela,
      // e a baixa de uma cobrança que nunca saiu de cá não tem o que apontar.
      if (!charge.gateway_charge_id) return { enqueued: false, reason: 'no_gateway_payment' };
      const config = await effectiveNfseConfig();
      if (!config.nfseEnabled) return { enqueued: false, reason: 'disabled' };
      if (await BillingInvoice.forCharge(charge.id)) return { enqueued: false, reason: 'exists' };
      try {
        await BillingInvoice.enqueue(charge.id);
      } catch (error) {
        if (isUniqueViolation(error)) return { enqueued: false, reason: 'exists' };
        throw error;
      }
      return { enqueued: true };
    } catch (error) {
      console.error(`Could not queue the invoice of charge ${charge?.id}: ${error.message}`);
      return { enqueued: false, reason: 'error' };
    }
  }

  /**
   * O pedido do console: emitir a nota de uma cobrança paga, ou emitir de novo
   * a que deu erro ou foi cancelada. Lança `InvoiceRequestError` com o código
   * da recusa; quem chama está no escopo do provedor.
   */
  static async requestForCharge(charge) {
    if (!charge) throw new InvoiceRequestError(404, 'Charge not found', 'not_found');
    if (charge.status !== 'paid') {
      throw new InvoiceRequestError(409, `The charge is ${charge.status}, not paid`, 'not_paid', { status: charge.status });
    }
    if (!charge.gateway_charge_id) {
      throw new InvoiceRequestError(
        409, 'The charge was not paid through the gateway; there is no payment to invoice', 'no_gateway_payment'
      );
    }
    const config = await effectiveNfseConfig();
    if (!config.nfseEnabled) {
      throw new InvoiceRequestError(409, 'Invoice issuing is turned off in Integrations', 'nfse_disabled');
    }

    const atual = await BillingInvoice.forCharge(charge.id);
    if (!atual) {
      try {
        await BillingInvoice.enqueue(charge.id);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      return { invoice: await BillingInvoice.forCharge(charge.id), statusBefore: null };
    }
    if (!REISSUABLE_INVOICE_STATUSES.includes(atual.status)) {
      throw new InvoiceRequestError(409, `The charge already has a ${atual.status} invoice`, 'invoice_exists', {
        invoiceStatus: atual.status
      });
    }
    // A MESMA linha volta ao começo (ver `BillingInvoice.reopen`).
    const changed = await BillingInvoice.reopen(atual.id, atual.status);
    if (!changed) {
      throw new InvoiceRequestError(409, 'The invoice changed meanwhile; try again', 'busy');
    }
    return { invoice: await BillingInvoice.findById(atual.id), statusBefore: atual.status };
  }

  /**
   * A passada do agendador, no escopo de UM provedor.
   *
   * Sem chave da API, nada: não há com quem falar, e contar isso como
   * tentativa esgotaria as tentativas de uma nota que nunca foi tentada. Com a
   * emissão desligada, as pendentes esperam (quem desligou não quer nota
   * nova), mas as agendadas continuam sendo consultadas — já existem na Asaas.
   */
  static async processDue({ now = new Date(), limit = BATCH } = {}) {
    const resumo = { issued: 0, failed: 0, polled: 0 };
    if (!(await effectiveApiKey())) return resumo;
    const config = await effectiveNfseConfig();

    if (config.nfseEnabled) {
      for (const linha of await BillingInvoice.due({ statuses: ['pending'], now, limit })) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await BillingInvoiceService.issueOne(linha, config, now);
        if (ok === true) resumo.issued += 1;
        else if (ok === false) resumo.failed += 1;
      }
    }
    for (const linha of await BillingInvoice.due({ statuses: ['scheduled'], now, limit })) {
      // eslint-disable-next-line no-await-in-loop
      if (await BillingInvoiceService.pollOne(linha, now)) resumo.polled += 1;
    }
    return resumo;
  }

  /** Pede (e autoriza) uma nota pendente. `true` saiu, `false` falhou, `null` não era para agora. */
  static async issueOne(linha, config, now = new Date()) {
    const garra = await BillingInvoice.claim(linha, { until: new Date(now.getTime() + CLAIM_MS), now });
    if (!garra) return null;

    const cobranca = await BillingCharge.findById(linha.charge_id);
    // A cobrança foi estornada (ou mexida à mão) entre a fila e aqui: nota de
    // dinheiro que voltou não se emite.
    if (!cobranca || cobranca.status !== 'paid') {
      await BillingInvoice.update(linha.id, {
        status: 'canceled', error: `The charge is ${cobranca?.status ?? 'gone'}; no invoice issued`, next_attempt_at: null
      });
      return null;
    }
    if (!cobranca.gateway_charge_id) {
      await BillingInvoice.update(linha.id, {
        status: 'error', error: 'The charge has no gateway payment to invoice', next_attempt_at: null
      });
      return false;
    }

    let externalId = linha.external_id || null;
    try {
      if (!externalId && Number(linha.attempts) > 0) {
        // Uma tentativa anterior pode ter criado a nota e perdido a resposta.
        // Recriar seria a segunda nota do mesmo pagamento; adota-se a viva.
        const existentes = await listInvoicesForPayment(cobranca.gateway_charge_id);
        const viva = existentes.find((nota) => !['CANCELED', 'CANCELLED', 'ERROR'].includes(nota.status));
        if (viva) externalId = viva.id;
      }
      if (!externalId) {
        const criada = await createInvoice(invoicePayload(config, cobranca, now));
        externalId = criada.id;
      }
      // O id fica gravado ANTES da autorização: se ela falhar, a próxima
      // tentativa autoriza esta nota em vez de pedir outra.
      if (externalId !== linha.external_id) {
        await BillingInvoice.update(linha.id, { external_id: externalId });
      }
      const autorizada = await authorizeInvoice(externalId);
      const patch = patchDaNota(autorizada, 'pending', now);
      if (!patch.status) patch.status = 'scheduled';
      await BillingInvoice.update(linha.id, {
        ...patch,
        attempts: Number(linha.attempts) + 1,
        // Agendada, a próxima pergunta é a consulta — não antes do intervalo.
        next_attempt_at: patch.status === 'scheduled' ? new Date(now.getTime() + POLL_INTERVAL_MS) : null,
        ...(patch.status === 'scheduled' ? { error: null } : {})
      });
      return true;
    } catch (error) {
      const tentativas = Number(linha.attempts) + 1;
      const esgotou = tentativas >= MAX_ATTEMPTS;
      console.warn(
        `Invoice ${linha.id} (charge ${linha.charge_id}) failed at the gateway, attempt ${tentativas}: ${motivo(error)}`
      );
      await BillingInvoice.update(linha.id, {
        ...(externalId ? { external_id: externalId } : {}),
        status: esgotou ? 'error' : 'pending',
        error: motivo(error),
        attempts: tentativas,
        next_attempt_at: esgotou ? null : new Date(now.getTime() + backoffMs(tentativas))
      });
      return false;
    }
  }

  /** Pergunta à Asaas pela nota agendada. */
  static async pollOne(linha, now = new Date()) {
    if (!linha.external_id) return false;
    const garra = await BillingInvoice.claim(linha, { until: new Date(now.getTime() + POLL_INTERVAL_MS), now });
    if (!garra) return false;
    try {
      const nota = await getInvoice(linha.external_id);
      const patch = patchDaNota(nota, linha.status, now);
      const final = patch.status ?? linha.status;
      await BillingInvoice.update(linha.id, {
        ...patch,
        next_attempt_at: final === 'scheduled' ? new Date(now.getTime() + POLL_INTERVAL_MS) : null
      });
      return true;
    } catch (error) {
      // A garra já empurrou a próxima consulta para depois do intervalo.
      console.warn(`Could not read invoice ${linha.external_id} at the gateway: ${motivo(error)}`);
      return false;
    }
  }

  /**
   * Cancela a nota de uma cobrança estornada — no escopo do provedor.
   *
   * Nunca lança, e nunca bloqueia o estorno: o dinheiro já voltou, e uma nota
   * que a prefeitura não deixou cancelar é problema de outra natureza (fica o
   * erro na linha e o log). A pendente que nunca chegou à Asaas só é marcada
   * cancelada aqui — e a passada do agendador também a recusaria, pela
   * cobrança que já não está paga.
   *
   * @returns {Promise<{ canceled: boolean, reason?: string }>}
   */
  static async cancelForCharge(chargeId) {
    let linha = null;
    try {
      linha = await BillingInvoice.forCharge(chargeId);
      if (!linha) return { canceled: false, reason: 'no_invoice' };
      if (linha.status === 'canceled') return { canceled: false, reason: 'already_canceled' };
      if (!linha.external_id) {
        await BillingInvoice.update(linha.id, {
          status: 'canceled', error: 'Canceled before issuing: the charge was refunded', next_attempt_at: null
        });
        return { canceled: true, reason: 'not_issued' };
      }
      if (linha.status === 'error') return { canceled: false, reason: 'not_issued' };
      const nota = await cancelInvoice(linha.external_id);
      const status = statusFromGateway(nota.status);
      // A Asaas pode responder "processando o cancelamento": a linha já fica
      // cancelada, e o `INVOICE_CANCELLATION_DENIED` a devolve se a
      // prefeitura recusar.
      await BillingInvoice.update(linha.id, {
        status: status === 'authorized' ? 'authorized' : 'canceled',
        error: null,
        next_attempt_at: null
      });
      return { canceled: true };
    } catch (error) {
      console.error(
        `Could not cancel the invoice of refunded charge ${chargeId}: ${motivo(error)} — cancel it at the gateway`
      );
      if (linha?.id) {
        await BillingInvoice.update(linha.id, { error: `Cancellation failed: ${motivo(error)}`.slice(0, 500) })
          .catch(() => {});
      }
      return { canceled: false, reason: error instanceof AsaasError ? 'gateway_failed' : 'error' };
    }
  }

  /**
   * Uma entrega `INVOICE_*` do webhook. Fora de escopo na entrada; abre o do
   * provedor dono da nota. Nunca lança — a resposta ao gateway é sempre 200.
   *
   * @returns {Promise<string>} o código para o corpo da resposta.
   */
  static async applyWebhook(body) {
    const evento = String(body?.event ?? '');
    const nota = body?.invoice;
    const externalId = nota?.id ? String(nota.id).slice(0, 64) : null;
    if (!externalId) return 'ignored';
    try {
      const tenantId = await BillingInvoice.tenantOfExternalId(externalId);
      if (!tenantId) return 'unknown_invoice';
      return await runInTenant(tenantId, async () => {
        const linha = await BillingInvoice.byExternalId(externalId);
        if (!linha) return 'unknown_invoice';
        // O pagamento da nota tem de ser o da cobrança desta linha: um id que
        // casasse com a cobrança de outro provedor seria escrever na nota
        // errada.
        if (nota.payment) {
          const cobranca = await BillingCharge.findById(linha.charge_id);
          if (cobranca?.gateway_charge_id && String(cobranca.gateway_charge_id) !== String(nota.payment)) {
            console.warn(`Invoice webhook: ${externalId} names payment ${nota.payment}, not the charge's; ignored`);
            return 'payment_mismatch';
          }
        }
        const lida = {
          status: nota.status || null,
          number: nota.number ? String(nota.number).slice(0, 64) : null,
          pdfUrl: nota.pdfUrl ? String(nota.pdfUrl).slice(0, 512) : null,
          xmlUrl: nota.xmlUrl ? String(nota.xmlUrl).slice(0, 512) : null,
          statusDescription: nota.statusDescription ? String(nota.statusDescription).slice(0, 500) : null
        };
        if (!statusFromGateway(lida.status) && STATUS_DO_EVENTO[evento]) {
          lida.status = STATUS_DO_EVENTO[evento].toUpperCase();
        }
        const negado = evento === 'INVOICE_CANCELLATION_DENIED';
        // A recusa do cancelamento é a única volta de `canceled`: a nota que o
        // estorno pediu para cancelar continua valendo, e a tela tem de dizer.
        const patch = patchDaNota(lida, negado && linha.status === 'canceled' ? 'authorized' : linha.status);
        if (negado) {
          if (linha.status === 'canceled') patch.status = 'authorized';
          patch.error = lida.statusDescription || 'The city hall denied the cancellation';
        }
        if (!Object.keys(patch).length) return 'unchanged';
        const final = patch.status ?? linha.status;
        if (final !== 'scheduled' && final !== 'pending') patch.next_attempt_at = null;
        await BillingInvoice.update(linha.id, patch);
        return 'invoice_updated';
      });
    } catch (error) {
      console.error(`Invoice webhook: could not apply ${evento} for ${externalId}: ${error.message}`);
      return 'update_failed';
    }
  }
}

export class InvoiceRequestError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export default BillingInvoiceService;
