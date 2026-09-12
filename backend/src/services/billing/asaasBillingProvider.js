import { BillingProvider } from './billingProvider.js';
import SubscriptionService from '../subscriptionService.js';

/**
 * O Asaas, que era o nome escrito no comentário da interface desde que ela
 * nasceu.
 *
 * A metade fácil — `recordPayment` — é uma delegação, e é fácil de propósito:
 * a interface foi escrita exatamente para que o webhook não duplicasse "o que
 * um pagamento significa". A regra comercial (`suspended` e `canceled` NÃO
 * reativam por pagamento), a idempotência em duas camadas e a transação que põe
 * o evento antes da data já existem em `SubscriptionService.recordPayment`, já
 * são testadas nos dois ramos, e já foram pagas por um bug real.
 *
 * A metade que precisa de cuidado é `interpretar`, abaixo.
 */

/**
 * Os eventos que significam "entrou dinheiro", e a armadilha que eles carregam.
 *
 * O Asaas manda os dois para um pagamento de cartão: `PAYMENT_CONFIRMED` quando
 * a operadora aprova e `PAYMENT_RECEIVED` quando o dinheiro cai na conta, D+30
 * depois. Pix vai direto para `RECEIVED`; boleto passa por `CONFIRMED` antes.
 *
 * Creditamos nos dois, e o que impede o cartão de creditar duas vezes é a
 * **chave de idempotência ser o id do PAGAMENTO e não o do evento**: os dois
 * eventos falam do mesmo `payment.id`, então o segundo cai na primeira camada
 * de `recordPayment` e responde `duplicate`. Se a chave fosse o id do evento —
 * que é o que a documentação do gateway sugere para deduplicar entregas — o
 * cartão ganharia dois períodos por pagamento, e ninguém perceberia por meses,
 * porque o extrato mostraria dois eventos que de fato aconteceram.
 *
 * E é por isso que creditar no `CONFIRMED` é seguro: o ISP não espera trinta
 * dias de liquidação de cartão para o painel voltar a escrever.
 */
const EVENTOS_QUE_CREDITAM = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);

/** Reais como o gateway manda (número JSON) para centavos inteiros. */
function paraCentavos(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) return null;
  // Arredondar sobre o produto, e não truncar: `19.99 * 100` vale
  // 1998.9999999999998 em binário de ponto flutuante, e um `Math.floor` ali
  // cobraria um centavo a menos de todo mundo, para sempre.
  return Math.round(numero * 100);
}

export class AsaasBillingProvider extends BillingProvider {
  get name() {
    return 'asaas';
  }

  /**
   * O que uma entrega do Asaas quer dizer — e o único lugar deste repositório
   * que depende da forma do JSON de um sistema de fora.
   *
   * Isolado numa função pura, sem banco e sem rede, por dois motivos. O
   * primeiro é o teste: a forma do payload é a única coisa aqui que não dá para
   * verificar contra o gateway de verdade sem uma conta nele, então ela precisa
   * ser barata de corrigir e impossível de corrigir pela metade. O segundo é a
   * direção da falha: **um campo que muda de nome faz isto devolver `null`, e
   * `null` é "não faço nada"** — a rota responde 200 e ninguém é creditado. O
   * avesso, creditar por engano, exigiria que um campo novo aparecesse com o
   * nome certo e o sentido errado.
   *
   * Conferido contra a documentação do gateway em setembro de 2026: o cabeçalho
   * de autenticação é `asaas-access-token`, o corpo tem `event` e `payment`, e
   * `externalReference` é o campo reservado a quem recebe para reconciliar com
   * o próprio cadastro. Antes da primeira cobrança de verdade, isto se confere
   * uma vez com uma entrega real — e é por isso que a rota registra o corpo
   * recusado no log do processo.
   *
   * @returns {{externalId: string, amountCents: number, customerRef: string|null,
   *            reference: string|null, event: string}|null}
   */
  static interpretar(corpo) {
    const evento = String(corpo?.event ?? '');
    if (!EVENTOS_QUE_CREDITAM.has(evento)) return null;

    const pagamento = corpo?.payment;
    if (!pagamento || typeof pagamento !== 'object') return null;

    const externalId = String(pagamento.id ?? '').trim();
    if (!externalId) return null;

    const amountCents = paraCentavos(pagamento.value);
    if (amountCents === null) return null;

    return {
      event: evento,
      externalId,
      amountCents,
      // O id do cliente no gateway — o caminho de volta quando a cobrança foi
      // emitida lá dentro, à mão, sem passar por nós.
      customerRef: pagamento.customer ? String(pagamento.customer) : null,
      // A nossa própria referência, quando fomos nós que criamos a cobrança.
      // Preferida sobre a de cima: ela é escrita por este painel e não depende
      // de o cadastro do cliente no gateway estar ligado ao provedor certo.
      reference: pagamento.externalReference ? String(pagamento.externalReference) : null
    };
  }

  async recordPayment({ amountCents, currency, externalId = null, actorUserId = null, now }) {
    return SubscriptionService.recordPayment({
      amountCents,
      currency,
      provider: this.name,
      externalId,
      // Nulo, e não um usuário: quem registrou foi o gateway. O console grava
      // quem apertou o botão; aqui não houve botão nenhum.
      actorUserId,
      ...(now ? { now } : {})
    });
  }
}

export const asaasBilling = new AsaasBillingProvider();

export default AsaasBillingProvider;
