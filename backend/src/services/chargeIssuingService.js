import BillingCharge, { OPEN_CHARGE_STATUSES, EXEMPT_CANCEL_MARKER } from '../models/BillingCharge.js';
import Tenant from '../models/Tenant.js';
import { currentTenantId } from '../config/tenantContext.js';
import { isUniqueViolation } from '../config/database.js';
import Subscription from '../models/Subscription.js';
import Plan from '../models/Plan.js';
import { providerFor } from './billing/registry.js';
import { PRODUCT_NAME } from '../config/brand.js';
import SubscriptionService from './subscriptionService.js';

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
/**
 * A recusa de `followDeadline`, com o status HTTP que o console responde:
 * 409 `busy` (a linha é de outra passada agora) ou 502 `gateway_failed`.
 */
export { EXEMPT_CANCEL_MARKER };

export class ChargeFollowError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.name = 'ChargeFollowError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

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
   * Por quanto tempo quem vai emitir fica dono da linha (`issuing_until`).
   *
   * Folga larga sobre o prazo da chamada ao gateway (vinte segundos, em
   * `asaasClient`): a garra só precisa durar mais que a chamada, e vencer
   * sozinha quando o processo morre no meio dela — dois minutos depois,
   * alguém retoma a linha em vez de ela ficar presa para sempre.
   */
  static CLAIM_MS = 2 * 60 * 1000;

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
   *
   * ## No gateway primeiro, e só depois aqui
   *
   * Esta faxina cancelava só a LINHA. A cobrança emitida continuava viva na
   * Asaas — com link, lembrete e, depois do vencimento, aviso de atraso —, e a
   * emissão logo abaixo abria a do período novo: duas faturas vivas na mão do
   * provedor, e ele sendo cobrado pela que o painel já dava por encerrada. O
   * caso comum é o prazo mexido à mão (a cortesia do console, a data
   * corrigida), que `followDeadline` agora resolve na hora; esta é a segunda
   * tranca, para o que chegar aqui por qualquer outro caminho — o pagamento
   * avulso que empurrou `renews_at`, um banco mexido à mão.
   *
   * Com a garra, como toda escrita que fala com o gateway por uma linha. E a
   * recusa do gateway deixa a linha EM ABERTO: o motivo mais provável é a
   * cobrança já ter sido paga lá (a Asaas não apaga cobrança recebida), e
   * aí fechá-la aqui como cancelada esconderia um pagamento que o webhook
   * perdeu. O motivo fica em `last_error` e a próxima tentativa espera
   * `RETRY_AFTER_MS` (`next_attempt_at`, que numa linha de período vencido não
   * significa mais nada para a emissão): o agendador passa a cada minuto, e um
   * DELETE recusado por minuto por cobrança seria martelar o gateway.
   */
  static async cancelStale(periodoAtual, { now = new Date() } = {}) {
    const velhas = await BillingCharge.openBefore(periodoAtual);
    let canceladas = 0;
    for (const cobranca of velhas) {
      const provider = cobranca.gateway_charge_id ? providerFor(cobranca.provider) : null;
      const noGateway = typeof provider?.cancelCharge === 'function';
      if (noGateway && cobranca.next_attempt_at) {
        const espera = new Date(cobranca.next_attempt_at);
        if (!Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) continue;
      }
      // eslint-disable-next-line no-await-in-loop -- uma ou duas por provedor, e cada uma fala com o gateway
      const minha = await BillingCharge.claim(cobranca.id, {
        until: new Date(now.getTime() + this.CLAIM_MS), now, unissued: false, openOnly: true
      });
      if (!minha) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        if (noGateway) await provider.cancelCharge(cobranca.gateway_charge_id);
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(cobranca.id, { status: 'canceled', issuing_until: null, next_attempt_at: null });
        canceladas += 1;
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(cobranca.id, {
          last_error: String(error.message ?? '').slice(0, 500),
          next_attempt_at: new Date(now.getTime() + this.RETRY_AFTER_MS),
          issuing_until: null
        });
        console.warn(
          `Stale charge ${cobranca.id} (period ${cobranca.period_end}) could not be canceled at the gateway `
          + `and stays open — it may have been paid there: ${error.message}`
        );
      }
    }
    return canceladas;
  }

  /**
   * Cancela TODAS as cobranças em aberto do provedor em escopo — o que o
   * "isento de cobrança" faz ao ser ligado (`SubscriptionService.setBillingExempt`),
   * e a varredura que o agendador repete enquanto a isenção vale
   * (`issueCurrent` → `billing_exempt`).
   *
   * O mesmo gesto do "cancelar" da tela de Assinaturas, linha a linha: a
   * garra (`claim` com `openOnly`), o gateway primeiro e a linha depois. A
   * diferença é o que a recusa faz: lá ela para tudo e responde 502; aqui a
   * linha que o gateway não cancelou FICA em aberto — com o motivo em
   * `last_error`, a próxima tentativa em `next_attempt_at` e em voz alta no
   * log —, e a isenção vale mesmo assim. Fechar aqui uma cobrança viva no
   * gateway seria esconder um link de pagamento que ainda funciona; e deixar
   * de isentar porque o gateway está fora seria o console sem como cumprir o
   * que decidiu. A varredura do agendador tenta de novo depois da espera.
   *
   * A cancelada por aqui leva `EXEMPT_CANCEL_MARKER` em `last_error`: é por
   * essa marca que o desligar acha a cobrança do período atual e a reabre
   * (`reopenExemptCanceled`) — sem ela a linha ficaria `canceled`, a emissão
   * responderia `already_settled` para sempre e o provedor venceria sem fatura.
   *
   * `honorBackoff` é o da varredura: ela passa a cada minuto, e um DELETE
   * recusado por minuto por cobrança seria martelar o gateway (a mesma espera
   * de `cancelStale`). O clique do console tenta na hora.
   *
   * @returns {Promise<{ canceled: number, failed: number[] }>} quantas saíram,
   *   e os ids das que ficaram (recusa do gateway, em espera, ou tomadas por
   *   outra passada).
   */
  static async cancelOpenCharges({ now = new Date(), honorBackoff = false } = {}) {
    const abertas = await BillingCharge.openAll();
    let canceladas = 0;
    const ficaram = [];
    for (const cobranca of abertas) {
      const provider = cobranca.gateway_charge_id ? providerFor(cobranca.provider) : null;
      const noGateway = typeof provider?.cancelCharge === 'function';
      if (honorBackoff && noGateway && cobranca.next_attempt_at) {
        const espera = new Date(cobranca.next_attempt_at);
        if (!Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) {
          ficaram.push(cobranca.id);
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop -- uma ou duas por provedor, e cada uma fala com o gateway
      const minha = await BillingCharge.claim(cobranca.id, {
        until: new Date(now.getTime() + this.CLAIM_MS), now, unissued: false, openOnly: true
      });
      if (!minha) {
        console.warn(`Open charge ${cobranca.id} was busy and stays open while exempting provider ${cobranca.tenant_id}`);
        ficaram.push(cobranca.id);
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        if (noGateway) await provider.cancelCharge(cobranca.gateway_charge_id);
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(cobranca.id, {
          status: 'canceled', issuing_until: null, next_attempt_at: null, last_error: EXEMPT_CANCEL_MARKER
        });
        canceladas += 1;
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(cobranca.id, {
          last_error: String(error.message ?? '').slice(0, 500),
          next_attempt_at: new Date(now.getTime() + this.RETRY_AFTER_MS),
          issuing_until: null
        });
        console.warn(
          `Open charge ${cobranca.id} (period ${cobranca.period_end}) could not be canceled at the gateway `
          + `while exempting provider ${cobranca.tenant_id}; it stays open: ${error.message}`
        );
        ficaram.push(cobranca.id);
      }
    }
    return { canceled: canceladas, failed: ficaram };
  }

  /**
   * Desligar a isenção devolve à emissão a cobrança do período que ELA
   * cancelou — a do prazo que continua no futuro.
   *
   * Sem isto, a linha do período atual ficaria `canceled` e a emissão do
   * agendador responderia `already_settled` a cada passada (só o clique
   * reabre cancelada): o provedor chegaria ao prazo sem fatura nenhuma e
   * venceria. Só a cancelada PELA ISENÇÃO (`EXEMPT_CANCEL_MARKER`): a que o
   * console cancelou a dedo continua cancelada, como sempre.
   *
   * Pela mesma porta da reemissão (`resetForReissue`, com a garra): o id
   * velho do gateway vai para `superseded_charges` e a linha volta `pending`,
   * sem id, para a próxima passada emitir. O valor mudado à mão pelo console
   * (0078) volta junto: o desconto foi dado ao período, e a isenção não o
   * desfaz.
   *
   * @returns {Promise<boolean>} se reabriu.
   */
  static async reopenExemptCanceled(periodEnd, { now = new Date() } = {}) {
    const linha = await BillingCharge.forPeriod(periodEnd);
    if (!linha || linha.status !== 'canceled' || linha.last_error !== EXEMPT_CANCEL_MARKER) return false;
    const minha = await BillingCharge.claim(linha.id, {
      until: new Date(now.getTime() + this.CLAIM_MS), now, unissued: false, statuses: ['canceled']
    });
    if (!minha) return false;
    const reaberta = await BillingCharge.resetForReissue(linha.id, {
      amountCents: Number(linha.amount_cents),
      currency: linha.currency
    });
    if (!reaberta) {
      await BillingCharge.release(linha.id);
      return false;
    }
    if (linha.amount_overridden_at) {
      await BillingCharge.update(linha.id, { amount_overridden_at: linha.amount_overridden_at });
    }
    return true;
  }

  /**
   * A cobrança em aberto acompanha o prazo que se moveu sem pagamento.
   *
   * Chamada por quem mexe no prazo à mão (`SubscriptionService.setDeadlines`
   * e `setStatus` com data), no escopo do provedor, ANTES de gravar o prazo
   * novo. A chave de uma cobrança é o prazo que ela compra; mudado o prazo, a
   * cobrança emitida para a chave velha ficaria órfã — a faxina a fecharia, a
   * emissão abriria outra para a chave nova, e o provedor teria duas faturas.
   * Aqui ela vira a cobrança do prazo novo:
   *
   *   - no gateway, o vencimento muda para o do prazo novo (`dueDateFor`, o
   *     mesmo cálculo da emissão — com a folga de quem já está vencido);
   *   - na linha, `period_end` passa a ser a chave nova, e o vencimento é o
   *     que o gateway aceitou. Uma `overdue` volta a `pending`: com o
   *     vencimento novo, não está mais atrasada.
   *
   * Se o prazo novo JÁ tem cobrança (voltou-se a um prazo que teve uma), duas
   * linhas não cabem numa chave: a velha é cancelada no gateway e aqui.
   *
   * A recusa do gateway LANÇA (`ChargeFollowError`, 502) e nada é gravado —
   * nem a linha nem, porque quem chama grava depois, o prazo. Mover o prazo
   * deixando a fatura velha viva é exatamente o dano que isto existe para
   * evitar. A linha tomada por outra passada lança 409 `busy`.
   *
   * Uma linha sem id no gateway só troca de chave: é a emissão que a leva lá,
   * pela porta de sempre, com o vencimento do prazo novo.
   *
   * @returns {Promise<{ moved: boolean, canceled?: boolean, reason?: string, chargeId?: number }>}
   */
  static async followDeadline({ from, to, now = new Date() }) {
    const de = from ? new Date(from) : null;
    const para = to ? new Date(to) : null;
    if (!de || !para || Number.isNaN(de.getTime()) || Number.isNaN(para.getTime())) {
      return { moved: false, reason: 'no_deadline' };
    }
    const chaveVelha = this.periodKey(de);
    const chaveNova = this.periodKey(para);
    if (chaveVelha === chaveNova) return { moved: false, reason: 'same_period' };
    const cobranca = await BillingCharge.forPeriod(chaveVelha);
    if (!cobranca || !OPEN_CHARGE_STATUSES.includes(cobranca.status)) {
      return { moved: false, reason: 'no_open_charge' };
    }

    const minha = await BillingCharge.claim(cobranca.id, {
      until: new Date(now.getTime() + this.CLAIM_MS), now, unissued: false, openOnly: true
    });
    if (!minha) {
      throw new ChargeFollowError(409, 'busy', 'The open charge is being changed by another process; try again shortly');
    }
    const noGateway = async (fn) => {
      try {
        return await fn();
      } catch (error) {
        throw new ChargeFollowError(502, 'gateway_failed', `The payment gateway refused: ${error.message}`, error.message);
      }
    };
    try {
      const provider = cobranca.gateway_charge_id ? providerFor(cobranca.provider) : null;
      const vencimento = this.dueDateFor(para, now);
      if (await BillingCharge.forPeriod(chaveNova)) {
        if (typeof provider?.cancelCharge === 'function') {
          await noGateway(() => provider.cancelCharge(cobranca.gateway_charge_id));
        }
        await BillingCharge.update(cobranca.id, { status: 'canceled', issuing_until: null });
        return { moved: false, canceled: true, chargeId: cobranca.id };
      }
      let respondido = null;
      if (typeof provider?.updateCharge === 'function') {
        respondido = await noGateway(() => provider.updateCharge(cobranca.gateway_charge_id, { dueDate: vencimento }));
      }
      await BillingCharge.update(cobranca.id, {
        period_end: chaveNova,
        due_date: respondido?.dueDate || vencimento,
        ...(cobranca.status === 'overdue' ? { status: 'pending' } : {}),
        issuing_until: null
      });
      return { moved: true, chargeId: cobranca.id };
    } finally {
      await BillingCharge.release(cobranca.id);
    }
  }

  /**
   * Emite a cobrança do provedor em escopo, se houver uma a emitir.
   *
   * Devolve `{ issued, reason }` e nunca lança: como o aviso, é um job, e
   * `{ issued: false, reason }` é o caso normal — a esmagadora maioria das
   * passadas não tem nada a fazer. Quando há uma linha do período no fim da
   * conversa — emitida agora ou já emitida antes —, ela vem em `charge`, que é
   * o que o "pagar agora" devolve à tela.
   *
   * ## `manual: true` — alguém clicou "pagar agora"
   *
   * O agendador pergunta "já é hora?"; o provedor que clica está dizendo que é.
   * Três guardas existem por causa da máquina, e com uma pessoa do outro lado
   * cedem:
   *
   *   - a antecedência (`not_due_yet`): quem quer pagar hoje a fatura que vence
   *     daqui a vinte dias não precisa esperar a janela de cinco;
   *   - o teto de tentativas (`gave_up`) e a espera entre elas (`backing_off`):
   *     os dois existem para o agendador não martelar o gateway a cada minuto,
   *     e um clique não é um laço. As tentativas voltam a zero — a pessoa está
   *     olhando, e o que der errado ela lê na hora;
   *   - a cobrança do período que foi CANCELADA (a troca para um plano de graça
   *     e de volta, o console) volta a ser emitida, com o preço de agora: quem
   *     pede para pagar um período que tem cobrança cancelada está pedindo a
   *     cobrança, e "já está resolvido" seria mentira.
   *
   * E a assinatura sem prazo nenhum (`renews_at` e `trial_ends_at` nulos — a
   * que o console pôs num plano sem nunca registrar pagamento) ganha um: o da
   * cobrança em aberto, se houver, senão hoje. Para o agendador ela não tem o
   * que cobrar; para quem clicou, tem, e o pagamento é o que a põe num ciclo.
   * A cobrança em aberto vem antes de "hoje" para que o clique de amanhã ache
   * a de hoje em vez de abrir outra com a chave de amanhã.
   *
   * O que NÃO cede: plataforma, provedor sem gateway que emita, gateway sem
   * chave, assinatura parada por gente, plano de graça, e a cobrança já
   * emitida (`already_issued`, agora COM a linha) — pagar agora a que já está
   * na mão do provedor é pagar ESSA, e não emitir outra.
   */
  static async issueCurrent({
    now = new Date(), tenant: doLaco = null, manual = false, countDevices = null, pendingBlockedBy = undefined
  } = {}) {
    const tenant = doLaco ?? await Tenant.findById(currentTenantId());
    if (!tenant) return { issued: false, reason: 'tenant_gone' };

    // A plataforma não se cobra. A linha dela em `tenants` existe para ser dona
    // do que o schema exige que tenha dono — a caixa de WhatsApp com que ela
    // atende os provedores —, e não para ser cliente.
    //
    // Explícito e não por acidente: as guardas abaixo já a poupariam hoje (não
    // está ligada a gateway nenhum e está no plano de graça), mas as duas são
    // configuração, e configuração muda. Uma correlação com o gateway colada na
    // linha errada pelo console faria o painel emitir cobrança contra nós
    // mesmos, e o `kind` é o único fato aqui que não depende de ninguém lembrar.
    if (tenant.kind === 'platform') return { issued: false, reason: 'platform_tenant' };

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
    if (typeof provider.isConfigured === 'function' && !(await provider.isConfigured())) {
      return { issued: false, reason: 'gateway_not_configured' };
    }

    // Sem o cache, e pela mesma razão que `recordPayment` não o usa: ele vale
    // quinze segundos, e uma leitura de quinze segundos atrás não pode decidir
    // POR QUANTO se cobra alguém. Um plano que mudou de preço agora cobraria o
    // preço velho, e o cliente receberia uma cobrança que ninguém sabe explicar.
    const subscription = await Subscription.forTenant(currentTenantId());
    if (!subscription) return { issued: false, reason: 'no_subscription' };
    // Isento de cobrança (ver `SubscriptionService.setBillingExempt`): o
    // console decidiu que este provedor fica ativo sem fatura, até desligar.
    // Antes de tudo que cobra — a faxina, a reprecificação, a reemissão — e
    // valendo também para o clique (`manual`): o "pagar agora", o "Reemitir"
    // e o "Gerar cobrança" do console passam por aqui e param aqui.
    //
    // A passada do agendador (não o clique) varre também o que ficou em aberto
    // — a cobrança que o gateway recusou cancelar ao ligar, ou a que uma
    // emissão em curso gravou enquanto a isenção era ligada —, respeitando a
    // espera de cada uma. Assim nenhuma fatura viva sobra na mão de um isento.
    if (subscription.billing_exempt_at) {
      let varridas = 0;
      if (!manual) {
        try {
          varridas = (await this.cancelOpenCharges({ now, honorBackoff: true })).canceled;
        } catch (error) {
          console.warn(`Could not sweep the open charges of exempt provider ${tenant.id}: ${error.message}`);
        }
      }
      return { issued: false, reason: 'billing_exempt', ...(varridas ? { canceledCharges: varridas } : {}) };
    }
    const plan = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;

    // `suspended` e `canceled` são decisões de gente. Emitir cobrança a quem
    // alguém desligou a dedo é o painel contrariando quem o opera.
    const estado = subscription.status;
    if (estado !== 'trial' && estado !== 'active' && estado !== 'past_due') {
      return { issued: false, reason: 'not_billable' };
    }

    let preco = Number(plan?.price_cents ?? 0);
    // Plano de graça não gera cobrança de R$ 0,00 — o gateway a recusaria, e
    // com razão. É o caso do `unlimited`, que todo provedor herdado tem.
    if (!(preco > 0)) return { issued: false, reason: 'free_plan' };

    // O prazo vivo: o do período pago, ou o do teste para quem ainda não pagou
    // nenhuma vez — e é justamente o fim do teste que precisa de cobrança, ou o
    // primeiro pagamento nunca acontece.
    let prazo = subscription.renews_at ?? subscription.trial_ends_at;
    // A chave do período, quando ela vem pronta de uma linha e não de um
    // instante: `period_end` já é a data no fuso da cobrança, e passá-la por
    // `new Date` e `periodKey` de novo a leria como meia-noite UTC — o dia
    // ANTERIOR em São Paulo, e uma segunda cobrança com a chave errada.
    let periodoPronto = null;
    if (!prazo && manual) {
      const aberta = await BillingCharge.currentOpen();
      if (aberta) {
        periodoPronto = String(aberta.period_end).slice(0, 10);
        prazo = new Date(`${periodoPronto}T12:00:00-03:00`);
      } else {
        prazo = now;
      }
    }
    if (!prazo) return { issued: false, reason: 'no_deadline' };
    const vencimento = new Date(prazo);
    if (Number.isNaN(vencimento.getTime())) return { issued: false, reason: 'no_deadline' };

    const periodo = periodoPronto ?? this.periodKey(vencimento);

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
    await this.cancelStale(periodo, { now });

    const antecedencia = now.getTime() + this.LEAD_DAYS * 86_400_000;
    if (!manual && vencimento.getTime() > antecedencia) return { issued: false, reason: 'not_due_yet' };

    // O plano que ESTE prazo cobra. Quase sempre o atual; a exceção é a
    // descida agendada (0074) para exatamente este prazo: a cobrança que sai
    // cinco dias antes da renovação paga o período que começa nela, e esse
    // período já é do plano novo. Cobrar o preço velho ali seria o provedor
    // pagando o plano caro por um mês em que vai estar no barato.
    //
    // A comparação é pela chave do período, no fuso da cobrança, e não pelo
    // instante: é a chave que identifica a cobrança, e dois instantes do mesmo
    // dia em São Paulo são o mesmo prazo. O plano agendado é sempre pago (a
    // descida só aceita plano pago), então a guarda do de graça lá em cima,
    // feita com o atual, continua valendo.
    //
    // MAS só se o uso couber no plano agendado — a mesma conta que a aplicação
    // faz (`SubscriptionService.overLimitOf`), contando só o que ele limita, e
    // com a contagem de ONTs que falta valendo como "cabe", como em todo lugar.
    // Sem esta guarda o buraco fechado pela descida agendada reabria por baixo:
    // quem pede a descida e não se ajusta continua no plano caro (a aplicação
    // recusa), mas a cobrança sairia pelo preço do barato — e o pagamento dela
    // conferiria. Não caber é continuar no plano atual, e pagar por ele.
    //
    // Depois da guarda de antecedência, e não antes: o agendador passa a cada
    // minuto, e contar uso (às vezes no ACS) semanas antes da janela de
    // emissão seria carga sem resposta a dar.
    let planoDoPeriodo = plan;
    let descidaBloqueada = null;
    if (subscription.pending_plan_id && subscription.pending_plan_at) {
      const agendada = new Date(subscription.pending_plan_at);
      if (!Number.isNaN(agendada.getTime()) && this.periodKey(agendada) === periodo) {
        const agendado = await Plan.findById(subscription.pending_plan_id);
        if (agendado && Number(agendado.price_cents ?? 0) > 0) {
          // Três fontes para o veredito, nesta ordem. A descida travada (paga
          // pelo preço dela, 0075) não tem veredito: vale o preço dela. Quem
          // reemite logo depois de decidir — a troca de plano, a reprecificação
          // abaixo — passa o veredito que JÁ usou (`pendingBlockedBy`), para a
          // reemissão não recontar: uma contagem de ONTs que oscila entre as
          // duas leituras cancelaria e reemitiria a fatura sem fim. Sem nada
          // disso, conta-se agora.
          if (SubscriptionService.isPendingLocked(subscription)) {
            descidaBloqueada = null;
          } else if (pendingBlockedBy !== undefined) {
            descidaBloqueada = pendingBlockedBy;
          } else {
            descidaBloqueada = await SubscriptionService.overLimitOf(agendado, { countDevices });
          }
          if (!descidaBloqueada) {
            planoDoPeriodo = agendado;
            preco = Number(agendado.price_cents);
          }
        }
      }
    }

    const moeda = planoDoPeriodo.currency || 'BRL';
    const garraAte = new Date(now.getTime() + this.CLAIM_MS);
    let existente = await BillingCharge.forPeriod(periodo);
    if (existente) {
      // Reaberta pelo clique, com o preço de agora — ver o comentário do método.
      // Só a cancelada: paga e devolvida continuam fechadas para todo mundo.
      // Com a garra, como toda escrita que reemite: a troca de plano pode estar
      // mexendo nesta mesma linha agora.
      if (manual && existente.status === 'canceled') {
        const minha = await BillingCharge.claim(existente.id, { until: garraAte, now, unissued: false });
        if (!minha) return { issued: false, reason: 'raced', charge: existente };
        const reaberta = await BillingCharge.resetForReissue(existente.id, { amountCents: preco, currency: moeda });
        if (!reaberta) await BillingCharge.release(existente.id);
        existente = await BillingCharge.findById(existente.id);
      }
      // `refunded` também: o período teve cobrança, ela foi paga e devolvida, e
      // emitir outra por cima é decisão de gente, não do agendador.
      if (existente.status === 'paid' || existente.status === 'canceled' || existente.status === 'refunded') {
        return { issued: false, reason: 'already_settled', charge: existente };
      }
      // A cobrança da renovação que saiu pelo preço da descida quando o uso
      // ainda cabia, e agora não cabe mais: a descida não vai se aplicar, o
      // período seguinte é do plano atual, e a fatura na mão do provedor pede
      // o preço do outro. Volta ao preço do atual pela mesma porta da troca de
      // plano — cancelada no gateway e reemitida —, e só enquanto está em
      // aberto: a paga é dinheiro que entrou e fica como está.
      //
      // Só nessa direção. A contrária (bloqueada quando saiu, cabe agora)
      // fica com o preço cheio até a renovação: um uso oscilando em volta do
      // teto viraria uma fatura nova por oscilação na caixa de quem paga.
      // Nunca a de valor mudado à mão pelo console (0078): o desconto dado a
      // ela é decisão de gente, e reprecificá-la pelo plano o desfaria.
      if (existente.gateway_charge_id && descidaBloqueada && !existente.amount_overridden_at
        && Number(existente.amount_cents) !== preco) {
        return this.repriceBlockedDowngrade({
          subscription, plan, tenant, charge: existente, blockedBy: descidaBloqueada, now
        });
      }
      if (existente.gateway_charge_id) return { issued: false, reason: 'already_issued', charge: existente };
      if (!manual) {
        if (Number(existente.attempts ?? 0) >= this.MAX_ATTEMPTS) {
          return { issued: false, reason: 'gave_up', charge: existente };
        }
        const espera = existente.next_attempt_at ? new Date(existente.next_attempt_at) : null;
        if (espera && !Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) {
          return { issued: false, reason: 'backing_off', charge: existente };
        }
      }

      // A garra, e só depois dela qualquer escrita e a chamada ao gateway.
      //
      // Até aqui tudo foi LEITURA, e duas passadas — o agendador e um clique,
      // dois cliques, a reemissão da troca de plano — podem ter lido a mesma
      // linha sem `gateway_charge_id` no mesmo instante. Sem a garra, as duas
      // criariam uma cobrança de verdade cada uma. Quem perde relê a linha: se
      // o outro já emitiu, é `already_issued` com ela; se ainda está emitindo,
      // é `raced`, também com ela — e quem clicou recebe a cobrança do outro
      // assim que ela sair (ver `SelfBillingService.payNow`).
      const minha = await BillingCharge.claim(existente.id, { until: garraAte, now });
      if (!minha) {
        const agora = await BillingCharge.findById(existente.id);
        if (agora?.gateway_charge_id) return { issued: false, reason: 'already_issued', charge: agora };
        return { issued: false, reason: 'raced', charge: agora };
      }

      const patch = {};
      // O clique não herda a paciência do agendador: zera o que foi contado
      // por ele, e a tentativa desta pessoa é a primeira.
      if (manual && (Number(existente.attempts ?? 0) > 0 || existente.next_attempt_at)) {
        patch.attempts = 0;
        patch.next_attempt_at = null;
      }
      // A linha que vai ser emitida de novo diz o preço de AGORA, que é o que
      // vai ao gateway logo abaixo. Uma linha aberta com um preço e emitida com
      // outro faria a conferência do pagamento (`valorPedido`, que lê a linha)
      // chamar de "pago a menos" quem pagou exatamente o que viu.
      // O valor mudado à mão pelo console (0078) fica — e é ele que vai ao
      // gateway logo abaixo, e não o preço do plano.
      if (existente.amount_overridden_at) {
        preco = Number(existente.amount_cents);
      } else if (Number(existente.amount_cents) !== preco || String(existente.currency || '').toUpperCase() !== moeda.toUpperCase()) {
        patch.amount_cents = preco;
        patch.currency = String(moeda).toUpperCase().slice(0, 3);
      }
      if (Object.keys(patch).length) await BillingCharge.update(existente.id, patch);
    }

    const vencimentoDoGateway = this.dueDateFor(vencimento, now);

    let chargeId = existente?.id ?? null;
    if (!chargeId) {
      try {
        chargeId = await BillingCharge.open({
          subscriptionId: subscription.id ?? null,
          periodEnd: periodo,
          amountCents: preco,
          currency: moeda,
          provider: provider.name,
          dueDate: vencimentoDoGateway,
          claimUntil: garraAte
        });
      } catch (error) {
        // Duas passadas se cruzaram e a outra ganhou. O índice único é quem
        // decidiu, e perder aqui é o resultado certo — não é erro. A linha de
        // quem ganhou vai junto, para quem clicou.
        if (isUniqueViolation(error)) {
          return { issued: false, reason: 'raced', charge: await BillingCharge.forPeriod(periodo) };
        }
        throw error;
      }
    }

    // A isenção pode ter sido ligada entre a leitura lá de cima e aqui — a
    // garra e a linha já são desta passada, e o cancelamento do console não
    // toma linha com garra. Relida agora, logo antes de falar com o gateway:
    // se ligou, a linha sai cancelada com a marca da isenção (sem id no
    // gateway, não há o que cancelar lá) e nada é emitido. O que escapar desta
    // janela — a isenção ligada DURANTE o `createCharge` — a varredura do
    // agendador cancela na próxima passada.
    const releitura = await Subscription.forTenant(currentTenantId());
    if (releitura?.billing_exempt_at) {
      await BillingCharge.update(chargeId, {
        status: 'canceled', issuing_until: null, next_attempt_at: null, last_error: EXEMPT_CANCEL_MARKER
      });
      return { issued: false, reason: 'billing_exempt' };
    }

    let criada;
    try {
      criada = await provider.createCharge({
        customerRef: tenant.billing_customer_ref,
        amountCents: preco,
        currency: moeda,
        dueDate: vencimentoDoGateway,
        description: `${tenant.name || PRODUCT_NAME} — ${planoDoPeriodo.name || planoDoPeriodo.code}`,
        // O formato que o webhook espera de volta, com o período junto: é por
        // ele que a entrega acha o provedor sem depender do cadastro do cliente
        // no gateway estar ligado a quem se pensa.
        reference: `tenant:${tenant.id}:${periodo}`
      });
    } catch (error) {
      await BillingCharge.markFailed(chargeId, error.message, { retryAfterMs: this.RETRY_AFTER_MS });
      return { issued: false, reason: 'gateway_failed', error: error.message };
    }

    // A tradução entre os dois vocabulários, num ponto só: o cliente fala a
    // língua do gateway (`chargeId` é o id DELE) e a tabela fala a do painel
    // (`gateway_charge_id` é o id de lá, visto daqui).
    const gravada = await BillingCharge.markIssued(chargeId, {
      gatewayChargeId: criada.chargeId,
      invoiceUrl: criada.invoiceUrl,
      dueDate: criada.dueDate
    });
    if (!gravada) {
      // A garra venceu no meio de uma chamada lenta, outra passada a tomou e
      // gravou primeiro. As duas cobranças existem no gateway; a da linha é a
      // do outro, e a desta passada é a que sobra — cancelada lá agora, e dita
      // em voz alta se nem isso der, porque é uma fatura a mais na mão de um
      // cliente pagante.
      try {
        if (typeof provider.cancelCharge === 'function') await provider.cancelCharge(criada.chargeId);
        console.warn(`Charge row ${chargeId} was issued by another pass; duplicate gateway charge ${criada.chargeId} was canceled`);
      } catch (error) {
        console.error(
          `Charge row ${chargeId} was issued by another pass and duplicate gateway charge ${criada.chargeId} `
          + `could NOT be canceled — cancel it by hand: ${error.message}`
        );
      }
      return { issued: false, reason: 'raced', charge: await BillingCharge.findById(chargeId) };
    }
    return {
      issued: true,
      periodEnd: periodo,
      amountCents: preco,
      chargeId: criada.chargeId,
      charge: await BillingCharge.findById(chargeId)
    };
  }

  /**
   * A cobrança da renovação de volta ao preço do plano atual, quando a
   * descida agendada que a baixou ficou bloqueada pelo uso (ver o comentário
   * no ponto em que `issueCurrent` chama isto).
   *
   * Pela porta da troca de plano (`SelfBillingService.repriceOpenCharge`), e
   * não por uma cópia dela aqui: é a mesma dança com o gateway — a garra, o
   * cancelamento que para tudo quando falha, o `resetForReissue` condicional
   * — e a reemissão volta por `issueCurrent`, que agora sai com o preço do
   * atual porque o bloqueio continua. Nunca lança, como o resto deste job.
   */
  static async repriceBlockedDowngrade({ subscription, plan, tenant, charge, blockedBy, now = new Date() }) {
    // A espera depois de uma falha, na própria linha: o agendador passa a
    // cada minuto, e um gateway que recusa o cancelamento seria martelado com
    // um DELETE por minuto. `next_attempt_at` numa linha JÁ emitida não
    // significa mais nada para a emissão (ela só o lê em linha sem id no
    // gateway), então é livre para isto — e `resetForReissue` o apaga quando
    // a reprecificação enfim dá certo.
    const espera = charge.next_attempt_at ? new Date(charge.next_attempt_at) : null;
    if (espera && !Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) {
      return { issued: false, reason: 'backing_off', charge };
    }
    // Importado aqui, e não no topo: `selfBillingService` importa este
    // arquivo, e o caminho de volta só é preciso neste caso raro.
    const { default: SelfBillingService } = await import('./selfBillingService.js');
    try {
      const resultado = await SelfBillingService.repriceOpenCharge({ subscription, plan, tenant, blockedBy });
      console.warn(
        `Renewal charge ${charge.id} of provider ${tenant.id} was repriced back to plan ${plan.id}: `
        + 'the scheduled downgrade is blocked by usage'
      );
      return resultado.reissue ?? {
        issued: false,
        reason: resultado.charge === 'reissued' ? 'repriced' : 'already_issued',
        charge: await BillingCharge.findById(charge.id)
      };
    } catch (error) {
      // Ocupada é outra passada mexendo nela agora: nada a esperar.
      if (error.code === 'busy') return { issued: false, reason: 'raced', error: error.message, charge };
      // `detail` é o motivo do gateway; `message`, numa recusa traduzível, é
      // só a chave da frase — e quem lê `last_error` quer o motivo.
      const motivo = String(error.detail ?? error.message ?? '');
      await BillingCharge.update(charge.id, {
        last_error: motivo.slice(0, 500),
        next_attempt_at: new Date(now.getTime() + this.RETRY_AFTER_MS)
      });
      console.warn(`Could not reprice renewal charge ${charge.id} of provider ${tenant.id}: ${motivo}`);
      return { issued: false, reason: 'reprice_failed', error: motivo, charge };
    }
  }
}

export default ChargeIssuingService;
