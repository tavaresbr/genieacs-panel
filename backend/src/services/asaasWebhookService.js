import crypto from 'node:crypto';
import { getDb } from '../config/database.js';
import { runInTenant } from '../config/tenantContext.js';
import AsaasProviderService from './asaasProviderService.js';
import AsaasCustomer from '../models/AsaasCustomer.js';
import AsaasCharge, { OPEN_STATUSES } from '../models/AsaasCharge.js';
import { cobrancaDe } from './billing/asaasClient.js';

/**
 * A entrega do webhook da conta Asaas do PROVEDOR: o cliente pagou, e o painel
 * deixa de mostrar (e de cobrar) a fatura na hora, sem esperar a importação.
 *
 * ## De qual provedor é a entrega: pelo TOKEN
 *
 * A rota é pública e fica acima do resolvedor de provedor — o endereço que o
 * provedor cola no painel do Asaas não nomeia ninguém. O Asaas manda o token no
 * cabeçalho `asaas-access-token`, e o provedor é o RESULTADO da conferência dele,
 * nunca uma entrada. É a forma de `SgpEventController.deliveryCandidates`: percorre
 * os provedores com a entrega ligada e compara em tempo constante, sem parar no
 * primeiro que casa — parar cedo faria o trabalho depender de quem é o dono do
 * token, e esconderia dois provedores com o mesmo.
 *
 * ## Respostas
 *
 * 404 sem ninguém com a entrega ligada; 401 uniforme (token errado, ausente ou
 * repetido entre provedores) — nunca diz qual parte falhou; 2xx para tudo que se
 * escolhe ignorar (reentrega, evento que não é de cobrança, cobrança sem efeito),
 * porque um não-2xx faz o gateway pausar a fila do provedor; não-2xx só para
 * falha genuína deste lado, que é quando reentregar ajuda.
 */

/** Eventos de cobrança que mudam o que o painel mostra. O resto é ignorado com 2xx. */
const EVENTOS_DE_COBRANCA = new Set([
  'PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED',
  'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'PAYMENT_OVERDUE', 'PAYMENT_REFUNDED',
  'PAYMENT_DELETED', 'PAYMENT_RESTORED', 'PAYMENT_ANTICIPATED', 'PAYMENT_CHARGEBACK_REQUESTED'
]);

/** Estes eventos DESFAZEM um pagamento: são os únicos que podem reabrir uma cobrança. */
const EVENTOS_QUE_REABREM = new Set(['PAYMENT_RESTORED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE']);

/** Compara dois tokens sem vazar tamanho nem prefixo pelo tempo (digest dos dois lados). */
function tokensIguais(a, b) {
  const da = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const db = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(da, db);
}

class AsaasWebhookService {
  /** Os provedores ativos com a entrega ligada e um token. */
  static async deliveryCandidates() {
    const tenants = await getDb()('tenants').where({ status: 'active' }).orderBy('id', 'asc');
    const candidates = [];
    for (const tenant of tenants) {
      // eslint-disable-next-line no-await-in-loop -- poucos provedores, e a leitura é do cache curto
      const config = await runInTenant(tenant.id, () => AsaasProviderService.getConfig());
      if (config.webhookEnabled && config.webhookToken) {
        candidates.push({ tenantId: tenant.id, token: config.webhookToken });
      }
    }
    return candidates;
  }

  /**
   * Confere o token contra TODOS os candidatos.
   *
   * @returns {Promise<{ status: 'no_candidates'|'invalid'|'ambiguous'|'ok', tenantId?: number }>}
   */
  static async authenticate(token) {
    const candidates = await this.deliveryCandidates();
    if (candidates.length === 0) return { status: 'no_candidates' };
    const accepted = candidates.filter((candidate) => tokensIguais(candidate.token, token));
    if (accepted.length > 1) {
      console.error(
        'Refused an Asaas webhook delivery: providers '
        + `${accepted.map((candidate) => candidate.tenantId).join(', ')} share a webhook token, `
        + 'so the delivery cannot be attributed. Rotate one of them.'
      );
      return { status: 'ambiguous' };
    }
    if (accepted.length === 0) return { status: 'invalid' };
    return { status: 'ok', tenantId: accepted[0].tenantId };
  }

  /**
   * Aplica o evento NO escopo do provedor que assinou a entrega.
   *
   * @returns {Promise<{ handled: boolean, reason?: string }>}
   */
  static async apply(tenantId, body) {
    const event = String(body?.event ?? '');
    const payment = body?.payment;
    if (!EVENTOS_DE_COBRANCA.has(event) || !payment?.id) {
      return { handled: false, reason: 'ignored_event' };
    }
    return runInTenant(tenantId, async () => {
      const charge = cobrancaDe(payment);
      const existing = await AsaasCharge.getByAsaasId(charge.id);

      if (event === 'PAYMENT_DELETED') {
        if (!existing) return { handled: false, reason: 'unknown_charge' };
        await AsaasCharge.markDeleted(charge.id);
        return { handled: true };
      }

      // Uma entrega atrasada (um UPDATED "pendente" depois do RECEBIDO) não pode
      // reabrir o que já foi pago: só o evento que DESFAZ o pagamento reabre.
      const reabre = EVENTOS_QUE_REABREM.has(event);
      const jaFechada = existing && !OPEN_STATUSES.includes(existing.status) && !existing.deleted;
      if (jaFechada && OPEN_STATUSES.includes(charge.status) && !reabre) {
        return { handled: false, reason: 'stale_event' };
      }

      // O CPF/CNPJ vem do cliente que a importação já trouxe; cliente ainda
      // desconhecido fica sem documento até a próxima importação completa.
      const customer = charge.customerId ? await AsaasCustomer.getByAsaasId(charge.customerId) : null;
      await AsaasCharge.upsertFromAsaas(charge, {
        document: customer?.document ?? existing?.document ?? null,
        seenAt: new Date()
      });
      return { handled: true };
    });
  }
}

export default AsaasWebhookService;
