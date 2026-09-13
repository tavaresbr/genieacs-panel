import BillingCharge from '../models/BillingCharge.js';
import Tenant from '../models/Tenant.js';
import { currentTenantId } from '../config/tenantContext.js';
import { isUniqueViolation } from '../config/database.js';
import Subscription from '../models/Subscription.js';
import Plan from '../models/Plan.js';
import { providerFor } from './billing/registry.js';

/**
 * A régua de emissão: quem cobra o provedor, e quando.
 *
 * O webhook já sabia receber a notícia de um pagamento; o que não existia era
 * pedir o pagamento. A cobrança se criava à mão no painel do gateway, uma por
 * cliente por mês, e é a tarefa que deixa de caber quando são cinquenta.
 *
 * ## Por que a emissão sai ANTES do vencimento, e não no dia
 *
 * Um boleto leva até três dias úteis para compensar, e o financeiro de um ISP
 * não paga no mesmo dia em que recebe. Emitir no vencimento é emitir atrasado:
 * o provedor é bloqueado enquanto o dinheiro está a caminho. `LEAD_DAYS` é essa
 * folga, e é um parâmetro comercial próprio — deliberadamente NÃO é
 * `warnWindowDays`, que responde outra pergunta (quanto antes uma PESSOA
 * precisa ser avisada) e muda por outros motivos.
 *
 * ## A memória, e por que ela é uma linha e não uma marca
 *
 * `expiry_warned_for` não serve aqui, por três razões, e a primeira sozinha
 * bastaria: ela já tem dono. Dois jobs escrevendo a mesma coluna se apagam — o
 * aviso marca o prazo, a emissão lê "já feito" e nunca emite. Além disso ela é
 * booleana por prazo, e a emissão precisa lembrar QUAL cobrança criou, para o
 * webhook reconciliar; e a janela dela é a do aviso.
 *
 * A memória é a linha em `billing_charges`, com `(tenant_id, period_end)`
 * único. Ela herda de `expiry_warned_for` a propriedade que a torna certa — um
 * pagamento empurra `renews_at`, o período seguinte tem outra chave, e o ciclo
 * recomeça sem ninguém limpar nada — e acrescenta o que faltava: o id no
 * gateway, o link, o estado e o motivo da falha.
 *
 * ## A linha nasce antes da chamada
 *
 * Gravar depois da resposta seria deixar a janela aberta: duas passadas que se
 * cruzassem criariam duas cobranças de verdade na mão de um cliente pagante. A
 * inserção é o bilhete que ganha a corrida, e o índice único é quem a decide.
 *
 * O que sobra é a falha do meio — o gateway criou a cobrança e a resposta se
 * perdeu. Aí a linha fica `pending` sem `gateway_charge_id`, que é um estado
 * reconhecível, e a retentativa manda a MESMA `externalReference`
 * (`tenant:<id>:<período>`), para que a reconciliação do outro lado tenha por
 * onde perceber. Uma cobrança duplicada no gateway é um problema visível e
 * corrigível; uma cobrança que nunca saiu, não.
 */
class ChargeIssuingService {
  /** Quantos dias antes do vencimento a cobrança sai. */
  static LEAD_DAYS = 5;

  /**
   * Quantas vezes se insiste numa emissão que falhou.
   *
   * Um teto, e não insistência infinita: se o gateway recusa o CNPJ do
   * provedor, a centésima tentativa recusa igual — e o que resolve é alguém
   * olhar. O `last_error` da linha é o que essa pessoa vai ler.
   */
  static MAX_ATTEMPTS = 5;

  /**
   * Quanto tempo se dá a quem já está vencido, quando a cobrança sai atrasada.
   *
   * Não é indulgência: é o mínimo para um boleto poder ser pago. Emitir com
   * vencimento de hoje para quem já está bloqueado é emitir algo que nasce
   * vencido de novo.
   */
  static OVERDUE_GRACE_DAYS = 3;

  /**
   * Quanto se espera antes de insistir numa emissão que falhou.
   *
   * O agendador passa a cada minuto. Sem esta espera, uma resposta perdida no
   * meio viraria cinco cobranças de verdade em cinco minutos na mão de um
   * cliente pagante — que é o dano que este serviço inteiro existe para não
   * causar. Uma hora é curta para o operador que está olhando e longa o
   * bastante para um gateway se recuperar.
   */
  static RETRY_AFTER_MS = 60 * 60 * 1000;

  /**
   * O fuso em que uma data de cobrança é lida.
   *
   * `toISOString()` é UTC, e o gateway lê `dueDate` no horário do Brasil: um
   * `renews_at` às 02:00Z é o dia ANTERIOR em São Paulo. Três coisas
   * divergiriam por um dia — a chave única, o vencimento e o "faltam N dias" —
   * e a que faz estrago é a chave, porque uma chave errada emite duas vezes.
   */
  static BILLING_TIMEZONE = 'America/Sao_Paulo';

  /** A data ISO de um instante, no fuso da cobrança. `en-CA` já formata YYYY-MM-DD. */
  static isoDate(instante) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.BILLING_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(instante));
  }

  /** A chave do período: o prazo que esta cobrança compra. */
  static periodKey(deadline) {
    return this.isoDate(deadline);
  }

  /**
   * O vencimento que vai ao gateway, que NEM SEMPRE é o fim do período.
   *
   * Um provedor em `past_due` tem o prazo no passado, e um gateway recusa
   * cobrança vencida antes de nascer. Sem esta conta ele falharia cinco vezes,
   * desistiria, e — como `renews_at` só se move com pagamento — a chave do
   * período nunca mudaria e ele nunca mais seria cobrado. É exatamente a
   * população que a emissão existe para resolver, e ela seria a única a ficar
   * de fora, em silêncio.
   */
  static dueDateFor(deadline, now) {
    const doPeriodo = this.isoDate(deadline);
    const hoje = this.isoDate(now);
    return doPeriodo >= hoje ? doPeriodo : this.isoDate(now.getTime() + this.OVERDUE_GRACE_DAYS * 86_400_000);
  }

  /**
   * Fecha as cobranças de períodos que já passaram e não foram pagas por aqui.
   *
   * `canceled` e não `failed`: nada falhou — o período simplesmente acabou, e o
   * provedor está em dia por outro caminho. A diferença importa para quem for
   * ler o histórico depois, e é a razão de os dois estados existirem.
   */
  static async cancelStale(periodoAtual) {
    const velhas = await BillingCharge.openBefore(periodoAtual);
    for (const cobranca of velhas) {
      await BillingCharge.update(cobranca.id, { status: 'canceled' });
    }
    return velhas.length;
  }

  /**
   * Emite a cobrança do provedor em escopo, se houver uma a emitir.
   *
   * Devolve `{ issued, reason }` e nunca lança: como o aviso, é um job, e
   * `{ issued: false, reason }` é o caso normal — a esmagadora maioria das
   * passadas não tem nada a fazer.
   */
  static async issueCurrent({ now = new Date(), tenant: doLaco = null } = {}) {
    const tenant = doLaco ?? await Tenant.findById(currentTenantId());
    if (!tenant) return { issued: false, reason: 'tenant_gone' };

    // Sem gateway ligado não há a quem pedir. É também o que faz este job ser
    // inócuo num install self-hosted, sem precisar perguntar pela edição: lá
    // ninguém liga provedor a gateway nenhum.
    const provider = providerFor(tenant.billing_gateway);
    if (!provider || !tenant.billing_customer_ref) return { issued: false, reason: 'not_linked' };
    // Um provedor ligado a um gateway que não emite — `manual` — é cobrado à
    // mão de propósito, e não é caso de erro.
    if (!provider.canIssue) return { issued: false, reason: 'provider_cannot_issue' };
    // Sem a chave da API não há emissão possível, e é preciso descobrir isso
    // ANTES de gravar a linha: sem esta parada, um deploy que esqueceu a
    // variável queimaria as cinco tentativas de toda cobrança e chegaria em
    // `gave_up` — uma variável esquecida destruindo a cobrança em vez de
    // simplesmente adiá-la até alguém configurá-la.
    if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
      return { issued: false, reason: 'gateway_not_configured' };
    }

    // Sem o cache, e pela mesma razão que `recordPayment` não o usa: ele vale
    // quinze segundos, e uma leitura de quinze segundos atrás não pode decidir
    // POR QUANTO se cobra alguém. Um plano que mudou de preço agora cobraria o
    // preço velho, e o cliente receberia uma cobrança que ninguém sabe explicar.
    const subscription = await Subscription.forTenant(currentTenantId());
    if (!subscription) return { issued: false, reason: 'no_subscription' };
    const plan = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;

    // `suspended` e `canceled` são decisões de gente. Emitir cobrança a quem
    // alguém desligou a dedo é o painel contrariando quem o opera.
    const estado = subscription.status;
    if (estado !== 'trial' && estado !== 'active' && estado !== 'past_due') {
      return { issued: false, reason: 'not_billable' };
    }

    const preco = Number(plan?.price_cents ?? 0);
    // Plano de graça não gera cobrança de R$ 0,00 — o gateway a recusaria, e
    // com razão. É o caso do `unlimited`, que todo provedor herdado tem.
    if (!(preco > 0)) return { issued: false, reason: 'free_plan' };

    // O prazo vivo: o do período pago, ou o do teste para quem ainda não pagou
    // nenhuma vez — e é justamente o fim do teste que precisa de cobrança, ou o
    // primeiro pagamento nunca acontece.
    const prazo = subscription.renews_at ?? subscription.trial_ends_at;
    if (!prazo) return { issued: false, reason: 'no_deadline' };
    const vencimento = new Date(prazo);
    if (Number.isNaN(vencimento.getTime())) return { issued: false, reason: 'no_deadline' };

    const periodo = this.periodKey(vencimento);

    // A faxina vem ANTES da guarda de "ainda não venceu", e essa ordem foi o
    // teste que a encontrou: um provedor que acabou de pagar está, por
    // definição, longe do próximo vencimento — então pôr a limpeza depois da
    // guarda significa que ela nunca roda para quem mais precisa dela.
    //
    // O que se limpa é a cobrança de um período que passou sem ser paga por
    // aqui: o provedor acertou por fora — o botão do console, uma transferência
    // marcada à mão — e `renews_at` andou sem quitar cobrança nenhuma. A linha
    // antiga ficaria `pending` para sempre, e "o que está em aberto" passaria a
    // responder errado a cada ciclo.
    await this.cancelStale(periodo);

    const antecedencia = now.getTime() + this.LEAD_DAYS * 86_400_000;
    if (vencimento.getTime() > antecedencia) return { issued: false, reason: 'not_due_yet' };

    const existente = await BillingCharge.forPeriod(periodo);
    if (existente) {
      if (existente.status === 'paid' || existente.status === 'canceled') {
        return { issued: false, reason: 'already_settled' };
      }
      if (existente.gateway_charge_id) return { issued: false, reason: 'already_issued' };
      if (Number(existente.attempts ?? 0) >= this.MAX_ATTEMPTS) {
        return { issued: false, reason: 'gave_up' };
      }
      const espera = existente.next_attempt_at ? new Date(existente.next_attempt_at) : null;
      if (espera && !Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) {
        return { issued: false, reason: 'backing_off' };
      }
    }

    const vencimentoDoGateway = this.dueDateFor(vencimento, now);
    const moeda = plan.currency || 'BRL';

    let chargeId = existente?.id ?? null;
    if (!chargeId) {
      try {
        chargeId = await BillingCharge.open({
          subscriptionId: subscription.id ?? null,
          periodEnd: periodo,
          amountCents: preco,
          currency: moeda,
          provider: provider.name,
          dueDate: vencimentoDoGateway
        });
      } catch (error) {
        // Duas passadas se cruzaram e a outra ganhou. O índice único é quem
        // decidiu, e perder aqui é o resultado certo — não é erro.
        if (isUniqueViolation(error)) return { issued: false, reason: 'raced' };
        throw error;
      }
    }

    try {
      const criada = await provider.createCharge({
        customerRef: tenant.billing_customer_ref,
        amountCents: preco,
        currency: moeda,
        dueDate: vencimentoDoGateway,
        description: `${tenant.name || 'SkyGenPanel'} — ${plan.name || plan.code}`,
        // O formato que o webhook espera de volta, com o período junto: é por
        // ele que a entrega acha o provedor sem depender do cadastro do cliente
        // no gateway estar ligado a quem se pensa.
        reference: `tenant:${tenant.id}:${periodo}`
      });
      // A tradução entre os dois vocabulários, num ponto só: o cliente fala a
      // língua do gateway (`chargeId` é o id DELE) e a tabela fala a do painel
      // (`gateway_charge_id` é o id de lá, visto daqui).
      await BillingCharge.markIssued(chargeId, {
        gatewayChargeId: criada.chargeId,
        invoiceUrl: criada.invoiceUrl,
        dueDate: criada.dueDate
      });
      return { issued: true, periodEnd: periodo, amountCents: preco, chargeId: criada.chargeId };
    } catch (error) {
      await BillingCharge.markFailed(chargeId, error.message, { retryAfterMs: this.RETRY_AFTER_MS });
      return { issued: false, reason: 'gateway_failed', error: error.message };
    }
  }
}

export default ChargeIssuingService;
