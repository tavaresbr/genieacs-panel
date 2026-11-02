import crypto from 'node:crypto';
import { getDb, insertReturningId, isUniqueViolation } from '../config/database.js';
import { affiliateConfig } from './platformProfileService.js';
import { createTransfer, getTransfer } from './billing/asaasClient.js';

/**
 * O lote mensal de comissões dos afiliados (0124) e o Pix que o paga.
 *
 * ## A ordem, e o que cada passo trava
 *
 * 1. **Montagem** (`buildBatches`): o agendador, nos dias 1 a 3 do mês (hora
 *    de Brasília), ou o botão do console. Um lote por afiliado e período
 *    (índice único `affiliate_id, period`): a segunda passada não monta outro.
 *    Entram as comissões `accrued` até o fim do período, com os abatimentos
 *    (`clawback`) — e só se a soma passa do mínimo configurado. Abaixo dele,
 *    nada é criado e o saldo fica para o mês seguinte.
 * 2. **Aprovação** (`approve`): quem opera a plataforma revisa e aprova. Sem
 *    ela, `send` recusa — NADA sai do gateway sem a aprovação gravada.
 * 3. **Envio** (`send`): a trava é a transição condicional `approved|failed →
 *    sending`; o clique duplo encontra `sending` e não manda outro Pix. A
 *    chave idempotente do lote vai no cabeçalho e no `externalReference`.
 * 4. **Acompanhamento**: o webhook `TRANSFER_*` (`applyTransferWebhook`) ou a
 *    consulta (`refresh`, também no agendador) levam `sent` a `paid` ou a
 *    `failed`.
 *
 * ## A falha que não se sabe
 *
 * O gateway que recusa o pedido (4xx) não criou nada: o lote fica `failed` e
 * pode ser reenviado. A resposta que se perdeu (queda de rede, 5xx, corpo
 * ilegível) pode ter criado o Pix: o lote fica `failed` com `uncertain`, e o
 * reenvio exige que quem opera confirme (`confirmNotSent`) que conferiu no
 * gateway e nada saiu. Um Pix não se desfaz.
 *
 * "Marcar como pago" é a saída manual: para o lote aprovado, falho ou enviado
 * que foi pago por fora (ou cujo webhook se perdeu).
 */

export const PAYOUT_STATUSES = Object.freeze(['draft', 'approved', 'sending', 'sent', 'paid', 'failed', 'canceled']);
/** Os erros do gateway que garantem que nada foi criado do outro lado. */
const ERROS_CERTOS = new Set(['refused', 'unauthorized', 'not_configured', 'blocked_host', 'invalid_base_url', 'bad_request']);
/** `sending` parado há mais que isto é um envio que morreu no meio. */
const SENDING_STALE_MS = 5 * 60 * 1000;
/** De quanto em quanto tempo, no máximo, o agendador passa. */
const PASS_INTERVAL_MS = 60 * 60 * 1000;
/** O fuso de Brasília, fixo: o Brasil não tem horário de verão desde 2019. */
const SP_OFFSET_MS = -3 * 60 * 60 * 1000;

export class PayoutError extends Error {
  constructor(message, { code = 'invalid', status = 409, extra = null } = {}) {
    super(message);
    this.name = 'PayoutError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/** O período (`YYYY-MM`) do mês ANTERIOR a `now`, no fuso de Brasília. */
export function previousPeriod(now = new Date()) {
  const sp = new Date(now.getTime() + SP_OFFSET_MS);
  const ano = sp.getUTCFullYear();
  const mes = sp.getUTCMonth(); // 0-11: o mês anterior, em 1-12, é este
  return mes === 0 ? `${ano - 1}-12` : `${ano}-${String(mes).padStart(2, '0')}`;
}

/** O dia do mês em Brasília. */
export function spDayOfMonth(now = new Date()) {
  return new Date(now.getTime() + SP_OFFSET_MS).getUTCDate();
}

/** O instante em que o período termina: meia-noite de Brasília do dia 1 do mês seguinte. */
export function periodEnd(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period ?? ''));
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) return null;
  return new Date(Date.UTC(ano, mes, 1) - SP_OFFSET_MS);
}

function novaChave(payoutId) {
  return `aff-${payoutId}-${crypto.randomBytes(8).toString('hex')}`;
}

const lotes = () => getDb()('affiliate_payouts');

class AffiliatePayoutService {
  static lastPassAt = 0;

  static async findById(id, trx = null) {
    const numero = Number(id);
    if (!Number.isInteger(numero) || numero <= 0) return null;
    return (await (trx || getDb())('affiliate_payouts').where({ id: numero }).first()) || null;
  }

  static async listForAffiliate(affiliateId) {
    return lotes().where({ affiliate_id: affiliateId }).orderBy('period', 'desc').orderBy('id', 'desc');
  }

  /** Os lotes do console, com o nome do afiliado. */
  static async list({ period = null, status = null } = {}) {
    let consulta = getDb()('affiliate_payouts')
      .leftJoin('affiliates', 'affiliates.id', 'affiliate_payouts.affiliate_id')
      .select('affiliate_payouts.*', 'affiliates.name as affiliate_name', 'affiliates.email as affiliate_email')
      .orderBy('affiliate_payouts.period', 'desc')
      .orderBy('affiliate_payouts.id', 'desc')
      .limit(500);
    if (period) consulta = consulta.where('affiliate_payouts.period', period);
    if (status) consulta = consulta.where('affiliate_payouts.status', status);
    return consulta;
  }

  static present(linha) {
    if (!linha) return null;
    return {
      id: Number(linha.id),
      affiliateId: Number(linha.affiliate_id),
      affiliateName: linha.affiliate_name ?? null,
      affiliateEmail: linha.affiliate_email ?? null,
      period: linha.period,
      amountCents: Number(linha.amount_cents),
      commissionCount: Number(linha.commission_count),
      status: linha.status,
      attempts: Number(linha.attempts ?? 0),
      transferId: linha.transfer_id ?? null,
      transferStatus: linha.transfer_status ?? null,
      pixKey: linha.pix_key ?? null,
      pixKeyType: linha.pix_key_type ?? null,
      approvedBy: linha.approved_by ? Number(linha.approved_by) : null,
      approvedAt: linha.approved_at ?? null,
      sentAt: linha.sent_at ?? null,
      paidAt: linha.paid_at ?? null,
      paidManually: Boolean(linha.paid_manually),
      paidNote: linha.paid_note ?? null,
      canceledAt: linha.canceled_at ?? null,
      errorCode: linha.error_code ?? null,
      error: linha.error ?? null,
      createdAt: linha.created_at ?? null
    };
  }

  // ── 1. Montagem ─────────────────────────────────────────────────────

  /**
   * Monta os lotes de um período. Idempotente: o afiliado que já tem lote no
   * período fica de fora; a corrida entre duas passadas morre no índice
   * único, e as comissões só mudam de dono por atualização condicional — se
   * alguma delas já não estava livre, a transação do lote inteiro desfaz.
   *
   * @returns {Promise<{ period: string, created: number[], carried: number[], skipped: number[] }>}
   */
  static async buildBatches({ period = null, now = new Date() } = {}) {
    const periodo = period ?? previousPeriod(now);
    const fim = periodEnd(periodo);
    if (!fim) throw new PayoutError('period must be YYYY-MM', { code: 'invalid_period', status: 400 });
    if (fim.getTime() > now.getTime()) {
      throw new PayoutError('The period has not ended yet', { code: 'period_open', status: 400 });
    }
    const { payoutMinCents } = await affiliateConfig();
    const resultado = { period: periodo, created: [], carried: [], skipped: [] };
    const afiliados = await getDb()('affiliates').where({ status: 'active' }).select('id');
    for (const { id: affiliateId } of afiliados) {
      // eslint-disable-next-line no-await-in-loop -- um afiliado por vez, cada um na sua transação
      const existe = await lotes().where({ affiliate_id: affiliateId, period: periodo }).first('id');
      if (existe) { resultado.skipped.push(Number(affiliateId)); continue; }
      // eslint-disable-next-line no-await-in-loop
      const livres = await getDb()('affiliate_commissions')
        .where({ affiliate_id: affiliateId, status: 'accrued' })
        .whereNull('payout_id')
        .where('accrued_at', '<', fim)
        .select('id', 'amount_cents');
      const soma = livres.reduce((total, l) => total + Number(l.amount_cents), 0);
      if (!livres.length || soma <= 0 || soma < payoutMinCents) {
        if (livres.length) resultado.carried.push(Number(affiliateId));
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const id = await getDb().transaction(async (trx) => {
          const loteId = await insertReturningId('affiliate_payouts', {
            affiliate_id: affiliateId,
            period: periodo,
            amount_cents: soma,
            commission_count: livres.length,
            status: 'draft',
            attempts: 0,
            paid_manually: false,
            created_at: now,
            updated_at: now
          }, trx);
          const ids = livres.map((l) => l.id);
          const presas = await trx('affiliate_commissions')
            .whereIn('id', ids).where({ status: 'accrued' }).whereNull('payout_id')
            .update({ status: 'in_payout', payout_id: loteId });
          if (presas !== ids.length) throw new PayoutError('commissions changed while building', { code: 'busy' });
          return loteId;
        });
        resultado.created.push(Number(id));
      } catch (error) {
        if (isUniqueViolation(error) || error?.code === 'busy') {
          resultado.skipped.push(Number(affiliateId));
          continue;
        }
        throw error;
      }
    }
    return resultado;
  }

  // ── 2. Aprovação ────────────────────────────────────────────────────

  static async approve(id, { actorUserId = null, now = new Date() } = {}) {
    const lote = await AffiliatePayoutService.findById(id);
    if (!lote) throw new PayoutError('Payout not found', { code: 'not_found', status: 404 });
    if (lote.status !== 'draft') throw new PayoutError('Only a draft payout can be approved', { code: 'not_draft' });
    if (Number(lote.amount_cents) <= 0) throw new PayoutError('A payout of zero or less cannot be approved', { code: 'empty' });
    const mudou = await lotes().where({ id: lote.id, status: 'draft' }).update({
      status: 'approved',
      approved_by: actorUserId,
      approved_at: now,
      idempotency_key: lote.idempotency_key ?? novaChave(lote.id),
      updated_at: now
    });
    if (!mudou) throw new PayoutError('The payout changed meanwhile', { code: 'busy' });
    return AffiliatePayoutService.findById(lote.id);
  }

  // ── 3. Envio ────────────────────────────────────────────────────────

  /** O `sending` que morreu no meio (processo caído): vira falha incerta. */
  static async expireStaleSending(lote, now) {
    if (lote.status !== 'sending') return lote;
    const desde = new Date(lote.updated_at instanceof Date ? lote.updated_at : (typeof lote.updated_at === 'number' ? lote.updated_at : String(lote.updated_at)));
    if (Number.isNaN(desde.getTime()) || now.getTime() - desde.getTime() < SENDING_STALE_MS) return lote;
    await lotes().where({ id: lote.id, status: 'sending' }).update({
      status: 'failed', error_code: 'uncertain', error: 'The send was interrupted; check the gateway before retrying', updated_at: now
    });
    return AffiliatePayoutService.findById(lote.id);
  }

  /**
   * Manda o Pix do lote aprovado. Devolve o lote depois; a falha do gateway
   * NÃO lança — fica gravada no lote (`failed`), que é o que o console mostra.
   * Lança `PayoutError` só para o que não pode nem tentar.
   */
  static async send(id, { confirmNotSent = false, now = new Date() } = {}) {
    let lote = await AffiliatePayoutService.findById(id);
    if (!lote) throw new PayoutError('Payout not found', { code: 'not_found', status: 404 });
    lote = await AffiliatePayoutService.expireStaleSending(lote, now);
    if (lote.status === 'draft') throw new PayoutError('The payout must be approved before it is sent', { code: 'not_approved' });
    if (lote.status === 'sending') throw new PayoutError('The payout is being sent', { code: 'busy' });
    if (!['approved', 'failed'].includes(lote.status)) {
      throw new PayoutError(`A ${lote.status} payout cannot be sent`, { code: 'not_sendable' });
    }
    if (!lote.approved_at) throw new PayoutError('The payout must be approved before it is sent', { code: 'not_approved' });
    if (lote.status === 'failed' && lote.error_code === 'uncertain' && !confirmNotSent) {
      throw new PayoutError('The last attempt may have reached the gateway; confirm nothing was sent before retrying', { code: 'confirm_not_sent' });
    }
    if (Number(lote.amount_cents) <= 0) throw new PayoutError('A payout of zero or less cannot be sent', { code: 'empty' });
    const afiliado = await getDb()('affiliates').where({ id: lote.affiliate_id }).first();
    if (!afiliado?.pix_key || !afiliado?.pix_key_type) throw new PayoutError('The affiliate has no Pix key', { code: 'no_pix_key' });
    if (afiliado.status === 'suspended') throw new PayoutError('The affiliate is suspended', { code: 'affiliate_suspended' });

    // A transferência anterior que o BANCO recusou existe no gateway com a
    // chave velha: o reenvio é outra transferência, com outra chave.
    const chave = lote.transfer_id && ['FAILED', 'CANCELLED'].includes(String(lote.transfer_status ?? '').toUpperCase())
      ? novaChave(lote.id)
      : (lote.idempotency_key ?? novaChave(lote.id));
    const trava = await lotes().where({ id: lote.id, status: lote.status }).update({
      status: 'sending',
      attempts: Number(lote.attempts ?? 0) + 1,
      idempotency_key: chave,
      pix_key: afiliado.pix_key,
      pix_key_type: afiliado.pix_key_type,
      error_code: null,
      error: null,
      updated_at: now
    });
    if (!trava) throw new PayoutError('The payout is being sent', { code: 'busy' });

    try {
      const transferencia = await createTransfer({
        valueCents: Number(lote.amount_cents),
        pixKey: afiliado.pix_key,
        pixKeyType: afiliado.pix_key_type,
        description: `Comissão de afiliado ${lote.period}`,
        idempotencyKey: chave
      });
      await lotes().where({ id: lote.id, status: 'sending' }).update({
        status: 'sent',
        transfer_id: transferencia.id,
        transfer_status: transferencia.status,
        sent_at: now,
        updated_at: now
      });
      if (transferencia.status) {
        await AffiliatePayoutService.applyTransferStatus(lote.id, transferencia, { now });
      }
    } catch (error) {
      const certo = ERROS_CERTOS.has(error?.code);
      await lotes().where({ id: lote.id, status: 'sending' }).update({
        status: 'failed',
        error_code: certo ? String(error.code).slice(0, 32) : 'uncertain',
        error: String(error?.message ?? 'transfer failed').slice(0, 500),
        updated_at: now
      });
      console.error(`Affiliate payout ${lote.id}: the transfer failed (${error?.code ?? 'error'}): ${error?.message}`);
    }
    return AffiliatePayoutService.findById(lote.id);
  }

  // ── 4. Acompanhamento ───────────────────────────────────────────────

  /**
   * O estado de uma transferência, aplicado ao lote: `DONE` paga, `FAILED` e
   * `CANCELLED` voltam a `failed` (reenviável, com chave nova), o resto só
   * atualiza o estado guardado. Condicional sobre `sent`.
   */
  static async applyTransferStatus(loteId, transferencia, { now = new Date() } = {}) {
    const estado = String(transferencia?.status ?? '').toUpperCase();
    if (estado === 'DONE') {
      return AffiliatePayoutService.settle(loteId, { from: ['sent'], now, transferStatus: 'DONE' });
    }
    if (estado === 'FAILED' || estado === 'CANCELLED') {
      const mudou = await lotes().where({ id: loteId, status: 'sent' }).update({
        status: 'failed',
        transfer_status: estado,
        error_code: 'transfer_failed',
        error: String(transferencia?.failReason ?? `transfer ${estado.toLowerCase()}`).slice(0, 500),
        updated_at: now
      });
      return Boolean(mudou);
    }
    if (estado) {
      await lotes().where({ id: loteId, status: 'sent' }).update({ transfer_status: estado.slice(0, 32), updated_at: now });
    }
    return false;
  }

  /** Consulta o gateway pelo lote enviado. Devolve o lote depois. */
  static async refresh(id, { now = new Date() } = {}) {
    const lote = await AffiliatePayoutService.findById(id);
    if (!lote) throw new PayoutError('Payout not found', { code: 'not_found', status: 404 });
    if (lote.status !== 'sent' || !lote.transfer_id) throw new PayoutError('Only a sent payout can be refreshed', { code: 'not_sent' });
    const transferencia = await getTransfer(lote.transfer_id);
    await AffiliatePayoutService.applyTransferStatus(lote.id, transferencia, { now });
    return AffiliatePayoutService.findById(lote.id);
  }

  /**
   * O webhook `TRANSFER_*` do gateway (o mesmo token da entrega de
   * pagamentos). Transferência que não é de lote nenhum é ignorada — a conta
   * também transfere por outros motivos. Nunca lança para fora.
   */
  static async applyTransferWebhook(corpo, { now = new Date() } = {}) {
    const transferencia = corpo?.transfer;
    const id = transferencia?.id ? String(transferencia.id) : null;
    if (!id) return 'transfer_ignored';
    const lote = await lotes().where({ transfer_id: id }).first();
    if (!lote) return 'transfer_unknown';
    const estadoDoEvento = { TRANSFER_DONE: 'DONE', TRANSFER_FAILED: 'FAILED', TRANSFER_CANCELLED: 'CANCELLED' }[String(corpo?.event ?? '')];
    const mudou = await AffiliatePayoutService.applyTransferStatus(lote.id, {
      status: estadoDoEvento ?? transferencia.status,
      failReason: transferencia.failReason ?? null
    }, { now });
    return mudou ? 'transfer_applied' : 'transfer_noted';
  }

  /** O lote pago: ele e as comissões dele, numa transação. */
  static async settle(loteId, {
    from, now = new Date(), transferStatus = null, manual = false, note = null
  }) {
    return getDb().transaction(async (trx) => {
      const mudou = await trx('affiliate_payouts').where({ id: loteId }).whereIn('status', from).update({
        status: 'paid',
        paid_at: now,
        paid_manually: manual,
        ...(note ? { paid_note: String(note).slice(0, 255) } : {}),
        ...(transferStatus ? { transfer_status: transferStatus } : {}),
        error_code: null,
        error: null,
        updated_at: now
      });
      if (!mudou) return false;
      await trx('affiliate_commissions').where({ payout_id: loteId, status: 'in_payout' })
        .update({ status: 'paid', paid_at: now });
      return true;
    });
  }

  /** "Marcar como pago": o lote aprovado, falho ou enviado que foi pago por fora. */
  static async markPaid(id, { note = null, now = new Date() } = {}) {
    let lote = await AffiliatePayoutService.findById(id);
    if (!lote) throw new PayoutError('Payout not found', { code: 'not_found', status: 404 });
    lote = await AffiliatePayoutService.expireStaleSending(lote, now);
    if (lote.status === 'draft') throw new PayoutError('The payout must be approved first', { code: 'not_approved' });
    if (!['approved', 'failed', 'sent'].includes(lote.status)) {
      throw new PayoutError(`A ${lote.status} payout cannot be marked as paid`, { code: 'not_payable' });
    }
    const feito = await AffiliatePayoutService.settle(lote.id, {
      from: ['approved', 'failed', 'sent'], now, manual: true, note
    });
    if (!feito) throw new PayoutError('The payout changed meanwhile', { code: 'busy' });
    return AffiliatePayoutService.findById(lote.id);
  }

  /**
   * Cancela o lote que não saiu: as comissões voltam a `accrued` e entram no
   * próximo. O enviado não se cancela daqui (o Pix está no banco); o falho
   * incerto só com a confirmação de que nada saiu.
   */
  static async cancel(id, { confirmNotSent = false, now = new Date() } = {}) {
    let lote = await AffiliatePayoutService.findById(id);
    if (!lote) throw new PayoutError('Payout not found', { code: 'not_found', status: 404 });
    lote = await AffiliatePayoutService.expireStaleSending(lote, now);
    if (!['draft', 'approved', 'failed'].includes(lote.status)) {
      throw new PayoutError(`A ${lote.status} payout cannot be canceled`, { code: 'not_cancelable' });
    }
    if (lote.status === 'failed' && lote.error_code === 'uncertain' && !confirmNotSent) {
      throw new PayoutError('The last attempt may have reached the gateway; confirm nothing was sent before canceling', { code: 'confirm_not_sent' });
    }
    const feito = await getDb().transaction(async (trx) => {
      const mudou = await trx('affiliate_payouts').where({ id: lote.id, status: lote.status })
        .update({ status: 'canceled', canceled_at: now, updated_at: now });
      if (!mudou) return false;
      await trx('affiliate_commissions').where({ payout_id: lote.id, status: 'in_payout' })
        .update({ status: 'accrued', payout_id: null });
      return true;
    });
    if (!feito) throw new PayoutError('The payout changed meanwhile', { code: 'busy' });
    return AffiliatePayoutService.findById(lote.id);
  }

  /**
   * A passada do agendador, acima dos provedores, no máximo uma por hora:
   * nos dias 1 a 3 (Brasília) monta os lotes do mês anterior — só monta,
   * nunca aprova nem envia —, e todo dia consulta os lotes enviados que o
   * webhook ainda não fechou. Nunca lança.
   */
  static async schedulerPass({ now = new Date(), force = false } = {}) {
    const resultado = { built: null, refreshed: 0 };
    if (!force && Date.now() - AffiliatePayoutService.lastPassAt < PASS_INTERVAL_MS) return resultado;
    AffiliatePayoutService.lastPassAt = Date.now();
    try {
      if (spDayOfMonth(now) <= 3) {
        resultado.built = await AffiliatePayoutService.buildBatches({ now });
      }
    } catch (error) {
      console.warn(`Could not build the affiliate payouts: ${error.message}`);
    }
    try {
      const enviados = await lotes().where({ status: 'sent' }).whereNotNull('transfer_id')
        .where('updated_at', '<', new Date(now.getTime() - 30 * 60 * 1000)).limit(20);
      for (const lote of enviados) {
        try {
          // eslint-disable-next-line no-await-in-loop -- poucos, e o gateway agradece
          await AffiliatePayoutService.refresh(lote.id, { now });
          resultado.refreshed += 1;
        } catch (error) {
          console.warn(`Could not refresh affiliate payout ${lote.id}: ${error.message}`);
        }
      }
    } catch (error) {
      console.warn(`Could not refresh the affiliate payouts: ${error.message}`);
    }
    return resultado;
  }
}

export default AffiliatePayoutService;
