import TenantBillingEvent from '../models/TenantBillingEvent.js';
import TenantSubscription from '../models/TenantSubscription.js';
import { SUBSCRIPTION_STATUSES } from '../config/subscription.js';

/**
 * Como a assinatura de um provedor é cobrada — e por que o nome é este.
 *
 * **Não se chama `billingService`**, e a razão é que «billing» já significa
 * outra coisa neste repositório: `waBillingService` é o ISP cobrando os
 * assinantes DELE pelo WhatsApp, com fatura do SGP, PIX e boleto. Isto aqui é o
 * contrário da relação — somos nós cobrando o ISP. Dois arquivos chamados
 * «billing» lado a lado, significando as duas pontas opostas do dinheiro, é o
 * tipo de ambiguidade que alguém resolve na madrugada, errado.
 *
 * ## A interface, e por que ela existe antes do gateway
 *
 * Um `BillingProvider` responde a uma pergunta só: **um fato de cobrança
 * aconteceu; o que ele faz com a assinatura?** Hoje há uma implementação, a
 * manual — nós marcamos pago. Quando entrar um gateway (Asaas é a recomendação:
 * PIX, boleto e cartão, o padrão do mercado de ISP brasileiro), ele implementa
 * a mesma superfície e o webhook desemboca em `applyPayment`, sem que nada
 * acima saiba a diferença.
 *
 * Isso poderia ser generalização especulativa — foi o que recusei em
 * `genieacs/connector.js`, onde a tabela prevista não teria leitor. Aqui não é,
 * e a diferença é uma coluna: **`external_id`**. Todo gateway reentrega
 * webhook, e reentrega é a regra, não a exceção. Acrescentar idempotência
 * depois que o dinheiro já está passando significa reconciliar cobranças
 * duplicadas à mão, com o cliente do outro lado da linha. É a única parte
 * disto que precisa existir antes de ser usada.
 */

/** Trinta dias. O período padrão quando quem marca não diz outro. */
const PERIODO_PADRAO_MS = 30 * 24 * 3600_000;

/**
 * A superfície que todo provedor de cobrança implementa.
 *
 * Documentada como objeto e não como classe abstrata porque JavaScript não tem
 * abstrata de verdade: uma classe base que só lança serviria para descobrir a
 * falta em produção, e um comentário aqui serve para não escrevê-la.
 *
 * - `code`: quem escreveu o fato, e vai para `source` na linha do extrato.
 * - `applyPayment({ tenantId, ... })`: registra um pagamento e move a
 *   assinatura para `active`, empurrando o fim do período.
 */

class ManualBillingProvider {
  static code = 'manual';

  /**
   * Marca pago: registra o fato e põe a assinatura em dia.
   *
   * A ORDEM é o que importa aqui, e é o oposto da do `AuditLog`. Lá a trilha é
   * escrita depois, e falhar em escrevê-la não desfaz a ação. Aqui o fato vem
   * PRIMEIRO e a assinatura só se move se ele foi registrado: uma assinatura
   * ativa sem o pagamento que a ativou é um cliente que ninguém sabe por que
   * está em dia — e, na reconciliação do mês, dinheiro que não existe.
   *
   * @returns {{ applied: boolean, event: object|null, duplicate?: boolean }}
   */
  static async applyPayment({
    tenantId, amountCents = null, currency = 'BRL',
    periodStart = null, periodEnd = null, externalId = null,
    occurredAt = null, detail = null
  }) {
    const assinatura = await TenantSubscription.findByTenantId(tenantId);
    if (!assinatura) return { applied: false, event: null };

    const inicio = periodStart ?? new Date();
    // O período novo começa onde o anterior terminou, se ele ainda não venceu.
    // Pagar adiantado tem de SOMAR trinta dias ao que já estava pago, e não
    // reiniciar a contagem de hoje — reiniciar cobra o cliente pelo tempo que
    // ele já tinha comprado.
    const base = assinatura.current_period_end && new Date(assinatura.current_period_end) > inicio
      ? new Date(assinatura.current_period_end)
      : inicio;
    const fim = periodEnd ?? new Date(base.getTime() + PERIODO_PADRAO_MS);

    const evento = await TenantBillingEvent.record({
      tenantId,
      kind: TenantBillingEvent.KINDS.PAYMENT,
      source: this.code,
      externalId,
      amountCents,
      currency,
      periodStart: inicio,
      periodEnd: fim,
      occurredAt,
      detail
    });
    // Reentrega: o fato já estava no livro. Não mexer na assinatura é o ponto —
    // aplicar de novo empurraria o período mais trinta dias por webhook
    // repetido, que é exatamente a falha que `external_id` existe para impedir.
    if (evento === null) {
      return {
        applied: false,
        duplicate: true,
        event: await TenantBillingEvent.findByExternalId(this.code, externalId)
      };
    }

    await TenantSubscription.setStatus(tenantId, 'active', {
      reason: 'Pagamento registrado',
      currentPeriodEnd: fim
    });
    return { applied: true, event: evento };
  }
}

class SubscriptionBillingService {
  static providers = Object.freeze({ [ManualBillingProvider.code]: ManualBillingProvider });

  /** O provedor de cobrança de um código. Só o manual existe hoje. */
  static providerFor(code = ManualBillingProvider.code) {
    return this.providers[String(code ?? '').trim().toLowerCase()] ?? null;
  }

  /**
   * Registra que o estado comercial andou.
   *
   * Chamado pelo plano de controle junto com a mudança de status. É o que faz o
   * extrato contar a história inteira — pagou, atrasou, suspendemos, pagou — em
   * vez de só os pagamentos, que sozinhos não explicam nada.
   *
   * Nunca lança: como a trilha, o fato que ela ia registrar já aconteceu.
   */
  static async recordStatusChange({ tenantId, from, to, reason = null, source = 'manual' }) {
    if (!SUBSCRIPTION_STATUSES.includes(to)) return null;
    try {
      return await TenantBillingEvent.record({
        tenantId,
        kind: TenantBillingEvent.KINDS.STATUS_CHANGE,
        source,
        statusFrom: from ?? null,
        statusTo: to,
        detail: reason ? { reason } : null
      });
    } catch (error) {
      console.warn(`Could not record the billing status change: ${error.message}`);
      return null;
    }
  }
}

export { ManualBillingProvider };
export default SubscriptionBillingService;
