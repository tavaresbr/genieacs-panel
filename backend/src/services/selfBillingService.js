import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import BillingCharge, { OPEN_CHARGE_STATUSES } from '../models/BillingCharge.js';
import Tenant from '../models/Tenant.js';
import SubscriptionService from './subscriptionService.js';
import ChargeIssuingService from './chargeIssuingService.js';
import { providerFor } from './billing/registry.js';
import { asaasBilling } from './billing/asaasBillingProvider.js';
import { AsaasCustomerError, ensureAsaasCustomer } from './billing/asaasCustomerService.js';
import { TranslatableError } from '../i18n/index.js';
import { currentTenantId } from '../config/tenantContext.js';

/**
 * O provedor cuidando da própria conta: ver os planos, trocar de plano e
 * pedir a cobrança agora.
 *
 * Até aqui as três coisas eram do console. O provedor via o plano e o estado
 * (`GET /api/tenant/subscription`), mas para trocar de plano ou para ter uma
 * cobrança antes da janela de emissão precisava abrir um chamado — e quem
 * estava bloqueado por fatura atrasada, sem cobrança emitida (o cadastro no
 * gateway nunca foi feito, a emissão desistiu), não tinha como pagar sozinho.
 *
 * ## As decisões comerciais, e onde cada uma mora
 *
 *   - A troca vale NA HORA. Não há proporcional: a próxima cobrança sai pelo
 *     preço novo, e o período já pago continua valendo até o fim como está.
 *     Proporcional é uma conta que o provedor não consegue conferir de cabeça,
 *     e o que não se confere de cabeça vira chamado.
 *   - A cobrança do período que ainda está em aberto é do preço velho. Ela é
 *     CANCELADA no gateway e reemitida com o preço novo — duas faturas do
 *     mesmo mês na mão de quem paga é o erro que este serviço mais precisa não
 *     cometer. Se o cancelamento falha, o plano NÃO muda: melhor um "tente de
 *     novo" do que uma fatura velha viva ao lado de um plano novo.
 *   - Quem pode: `owner` e `admin`, pela capacidade `settings.write` que já
 *     existe — trocar de plano é configuração da conta, e quem configura a
 *     conta é quem já decide o cadastro fiscal que vai na fatura.
 *
 * ## O que o corpo NUNCA traz
 *
 * O gateway e o id do cliente dele. O "pagar agora" liga o provedor ao Asaas
 * quando ainda não está ligado, e liga com o cadastro fiscal DA LINHA e o id
 * que o GATEWAY devolveu — ver `asaasCustomerService`. Um provedor não diz de
 * quem é o dinheiro que entra.
 */

/** Os estados em que a assinatura ainda é do provedor para mexer. */
const ESTADOS_VIVOS = new Set(['trial', 'active', 'past_due']);

/**
 * Uma recusa com o código que a tela lê, o status HTTP e, às vezes, números.
 *
 * `TranslatableError` porque a mensagem é de quem pediu, no idioma dele, e só
 * o controlador tem o `req.t`. `extra` são os campos que vão no TOPO do corpo
 * do erro — o mesmo desenho do 402 de limite de plano e do 409 de pagamento a
 * menos: o cliente de API encaminha campo nomeado, não um `data` inteiro.
 */
export class SelfBillingError extends TranslatableError {
  constructor(key, { code, status, vars = null, extra = null, detail = null } = {}) {
    super(key, vars, { code, status });
    this.name = 'SelfBillingError';
    this.extra = extra;
    this.detail = detail;
  }
}

const MENSAGEM_DO_EXCESSO = Object.freeze({
  operators: 'subscription.overLimitOperators',
  subscribers: 'subscription.overLimitSubscribers',
  devices: 'subscription.overLimitDevices'
});

/**
 * Se o plano custa alguma coisa. Plano de graça nunca é destino de uma troca
 * feita por dentro — ver `listPlans`.
 */
const ehPago = (plano) => Number(plano?.price_cents ?? 0) > 0;

/** Quanto dura a garra da troca de plano sobre a cobrança do período. */
const GARRA_DA_TROCA_MS = 2 * 60 * 1000;

const ocupado = () => new SelfBillingError('billing.busy', { code: 'busy', status: 409 });

function presentPlan(plan, currentId) {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    priceCents: Number(plan.price_cents ?? 0),
    currency: plan.currency || 'BRL',
    periodDays: Number(plan.period_days ?? 30),
    limits: SubscriptionService.limitsOf(plan),
    current: currentId !== null && Number(plan.id) === Number(currentId)
  };
}

/**
 * A cobrança em aberto do período corrente, ou nada.
 *
 * O período é o mesmo que a emissão calcula — o prazo vivo, no fuso da
 * cobrança —, e é por ele que se procura, e não pela "mais recente em
 * aberto": uma cobrança de um período que já passou é da faxina da emissão
 * (`cancelStale`), e reemiti-la com o preço novo seria cobrar de novo um mês
 * que o provedor já acertou por fora. Sem prazo nenhum, a mais recente em
 * aberto é a única candidata, e é a mesma que o "pagar agora" acharia.
 */
async function cobrancaEmAberto(subscription) {
  const prazo = subscription.renews_at ?? subscription.trial_ends_at;
  if (!prazo) return BillingCharge.currentOpen();
  const quando = new Date(prazo);
  if (Number.isNaN(quando.getTime())) return null;
  const linha = await BillingCharge.forPeriod(ChargeIssuingService.periodKey(quando));
  return linha && OPEN_CHARGE_STATUSES.includes(linha.status) ? linha : null;
}

class SelfBillingService {
  /**
   * Os planos que o provedor pode escolher, com o preço — e o dele, sempre.
   *
   * Os ativos, que são o catálogo à venda, mais o plano atual MESMO inativo:
   * a tela precisa mostrar "você está aqui" a quem ficou num plano que saiu de
   * linha, e sumir com ele da lista faria parecer que o provedor não tem plano.
   * Voltar a ele depois de sair, porém, não se pode — é o que `inativo` quer
   * dizer, e `changePlan` recusa.
   *
   * Os de graça ficam de fora, pela mesma regra de `changePlan`: não são
   * escolha do provedor. O `unlimited` que a migração 0035 semeia (preço
   * zero, sem limite nenhum, ativo) é o plano dos provedores herdados, e
   * oferecê-lo aqui seria um botão "pare de pagar" ao lado do preço. Quem já
   * está num deles o vê marcado como o seu, e só.
   */
  static async listPlans() {
    const subscription = await Subscription.forTenant(currentTenantId());
    const atual = subscription?.plan_id ?? null;
    const planos = (await Plan.list({ activeOnly: true }))
      .filter((plano) => ehPago(plano) || Number(plano.id) === Number(atual));
    if (atual && !planos.some((plano) => Number(plano.id) === Number(atual))) {
      const dele = await Plan.findById(atual);
      if (dele) {
        planos.push(dele);
        planos.sort((a, b) => Number(a.id) - Number(b.id));
      }
    }
    return planos.map((plano) => presentPlan(plano, atual));
  }

  /**
   * Troca o plano do provedor em escopo, a pedido dele.
   *
   * A ordem é a das recusas baratas primeiro e da única coisa irreversível por
   * último: plano, estado, uso — tudo leitura —, e só então o gateway, porque
   * uma cobrança cancelada lá não volta. A troca em si é a de sempre
   * (`SubscriptionService.changePlan`), que grava o extrato e esquece o cache.
   *
   * @returns {Promise<{ changed: boolean, from: number|null, to: number,
   *   plan: object, charge: 'none'|'reissued', reissue?: object }>}
   */
  static async changePlan({ planId, actorUserId = null, countDevices = null }) {
    const tenantId = currentTenantId();
    const id = Number(planId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new SelfBillingError('subscription.planNotFound', { code: 'plan_not_found', status: 404 });
    }

    // A caixa da plataforma não tem plano que se troque: ela não é cliente.
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || tenant.kind === 'platform') {
      throw new SelfBillingError('subscription.notChangeable', { code: 'not_changeable', status: 409 });
    }

    // Lida agora, sem o cache: o estado que autoriza a troca não pode ser o de
    // quinze segundos atrás, quando o console pode ter acabado de suspender.
    const subscription = await Subscription.forTenant(tenantId);
    // `suspended` e `canceled` são decisões de gente, e a saída delas é
    // gente também — o console. Trocar de plano por dentro não pode ser o
    // jeito de um provedor suspenso se reativar num plano mais barato.
    if (!subscription || !ESTADOS_VIVOS.has(subscription.status)) {
      throw new SelfBillingError('subscription.notChangeable', { code: 'not_changeable', status: 409 });
    }

    // O mesmo plano é um clique a mais, não um erro — e não uma linha no
    // extrato dizendo que algo mudou. Vale até para o plano atual inativo: é
    // "ficar onde está", e isso nunca foi proibido.
    if (Number(subscription.plan_id) === id) {
      const plan = await Plan.findById(id);
      return { changed: false, from: id, to: id, plan, charge: 'none' };
    }

    const plan = await Plan.findById(id);
    // Inativo ou de graça, a mesma resposta: não está no catálogo que este
    // provedor pode escolher (`listPlans`), e para quem pede é como se não
    // existisse. Um 403 para o de graça diria "existe, mas não para você", e
    // é uma frase que não precisa ser dita.
    if (!plan || !plan.active || !ehPago(plan)) {
      throw new SelfBillingError('subscription.planNotFound', { code: 'plan_not_found', status: 404 });
    }

    // O uso tem que caber no plano novo. Não é o mesmo que o 402 dos limites,
    // que recusa CRESCER além do teto: aqui o provedor já está lá, e descer
    // para um plano menor que o uso deixaria a conta estourada no minuto
    // seguinte — nada de novo cabe e ninguém entende por quê. A contagem de
    // ONTs pode faltar (o ACS fora do ar); faltando, ela não decide nada, pela
    // mesma regra de `usage`: dado que não se tem não vira recusa.
    const { usage } = await SubscriptionService.usage({ countDevices });
    const limites = SubscriptionService.limitsOf(plan);
    for (const resource of ['operators', 'subscribers', 'devices']) {
      const limit = limites[resource];
      const used = usage[resource];
      if (limit === null || used === null || used === undefined) continue;
      if (used > limit) {
        throw new SelfBillingError(MENSAGEM_DO_EXCESSO[resource], {
          code: 'over_limit',
          status: 409,
          vars: { used, limit },
          extra: { resource, used, limit }
        });
      }
    }

    // A cobrança em aberto do período, com o preço velho.
    //
    // O plano novo é sempre pago (os de graça foram recusados acima), então o
    // destino da cobrança em aberto é um só: cancelar a velha no gateway e
    // reemitir a linha com o preço novo.
    const preco = Number(plan.price_cents ?? 0);
    const moeda = String(plan.currency || 'BRL').toUpperCase();
    const aberta = await cobrancaEmAberto(subscription);
    let acaoNaCobranca = 'none';
    if (aberta && (Number(aberta.amount_cents) !== preco
      || String(aberta.currency || '').toUpperCase() !== moeda)) {
      // A garra antes de tudo, inclusive antes do gateway: é ela que impede
      // duas trocas simultâneas (dois administradores, dois cliques) de
      // cancelarem e reemitirem a mesma linha cada uma — e o agendador ou um
      // "pagar agora" de emitirem por ela no meio da troca. Quem não a
      // consegue ouve "tente de novo em instantes", que é a verdade: alguém
      // está mexendo nesta cobrança agora.
      const agora = new Date();
      const minha = await BillingCharge.claim(aberta.id, {
        until: new Date(agora.getTime() + GARRA_DA_TROCA_MS), now: agora, unissued: false
      });
      if (!minha) throw ocupado();

      // Relida DEPOIS da garra: a leitura de cima pode ser de antes de outra
      // troca terminar, e decidir por ela cancelaria de novo um id que já não
      // é o da linha. Se a outra troca já deixou a linha no preço novo (ou a
      // cobrança fechou no meio), não há o que fazer aqui.
      const linha = await BillingCharge.findById(aberta.id);
      const jaNoPreco = linha && Number(linha.amount_cents) === preco
        && String(linha.currency || '').toUpperCase() === moeda;
      if (!linha || jaNoPreco || !OPEN_CHARGE_STATUSES.includes(linha.status)) {
        if (linha) await BillingCharge.release(linha.id);
      } else {
        if (linha.gateway_charge_id) {
          // A do gateway sai ANTES de o plano mudar, e a falha dela para tudo:
          // uma fatura velha viva ao lado de um plano novo é o provedor pagando
          // o preço errado pelo link que já tem no e-mail.
          const provider = providerFor(linha.provider);
          let motivo = null;
          if (!provider || typeof provider.cancelCharge !== 'function') {
            motivo = `provider ${linha.provider} cannot cancel charges`;
          } else {
            try {
              await provider.cancelCharge(linha.gateway_charge_id);
            } catch (error) {
              motivo = error.message;
            }
          }
          if (motivo !== null) {
            await BillingCharge.release(linha.id);
            throw new SelfBillingError('subscription.chargeCancelFailed', {
              code: 'gateway_failed', status: 502, vars: { detail: motivo }, detail: motivo
            });
          }
        }
        // Condicional (ver `resetForReissue`): se a linha mudou de id no
        // gateway entre a leitura e aqui, alguém a emitiu no meio, e
        // reescrevê-la apagaria uma cobrança viva. A velha já foi cancelada
        // lá; a nova, de quem emitiu, fica — e o provedor tenta a troca de novo.
        if (!(await BillingCharge.resetForReissue(linha.id, { amountCents: preco, currency: moeda }))) {
          await BillingCharge.release(linha.id);
          throw ocupado();
        }
        acaoNaCobranca = 'reissued';
      }
    }

    await SubscriptionService.changePlan({ planId: plan.id, actorUserId });

    // A reemissão, logo em seguida e pela porta de sempre — agora que o plano
    // é o novo, é o preço dele que a emissão lê. Melhor esforço: se o gateway
    // falhar aqui, a troca já aconteceu e está certa, e a linha fica `failed`
    // com a espera de sempre, que o agendador ou o "pagar agora" retomam. O
    // que não pode é a falha da reemissão desfazer a troca.
    let reissue;
    if (acaoNaCobranca === 'reissued') {
      try {
        reissue = await ChargeIssuingService.issueCurrent({ tenant, manual: true });
      } catch (error) {
        console.error(`Reissue after self-service plan change failed for provider ${tenantId}:`, error.message);
        reissue = { issued: false, reason: 'error', error: error.message };
      }
    }

    return {
      changed: true, from: subscription.plan_id ?? null, to: plan.id, plan, charge: acaoNaCobranca,
      ...(reissue ? { reissue } : {})
    };
  }

  /**
   * "Pagar agora": a cobrança em aberto do período — a que já existe ou uma
   * emitida agora.
   *
   * @returns {Promise<{ charge: object, issued: boolean, customerCreated: boolean }>}
   *   `charge` é a LINHA; quem apresenta é o controlador, por
   *   `BillingCharge.present`, a mesma leitura de `/charges`.
   */
  static async payNow() {
    const tenantId = currentTenantId();
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || tenant.kind === 'platform') {
      throw new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
    }

    // As recusas comerciais antes de qualquer coisa que fale com o gateway —
    // e, sobretudo, antes de criar um cliente lá: abrir um cadastro no Asaas
    // para quem está num plano de graça é deixar um cliente sem cobrança
    // nenhuma na conta da plataforma, para sempre.
    const subscription = await Subscription.forTenant(tenantId);
    if (!subscription || !ESTADOS_VIVOS.has(subscription.status)) {
      throw new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
    }
    const plan = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;
    if (!(Number(plan?.price_cents ?? 0) > 0)) {
      throw new SelfBillingError('charges.freePlan', { code: 'free_plan', status: 409 });
    }

    // Ligado a outro gateway — o `manual` que o console escolheu para quem
    // paga por fora — não é caso de emitir: a plataforma decidiu cobrar esse
    // provedor de outro jeito, e o clique dele não desfaz a decisão.
    if (tenant.billing_gateway && tenant.billing_gateway !== asaasBilling.name) {
      throw new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
    }
    if (!(await asaasBilling.isConfigured())) {
      throw new SelfBillingError('charges.gatewayNotConfigured', { code: 'gateway_not_configured', status: 503 });
    }

    let customerCreated = false;
    let atual = tenant;
    if (!tenant.billing_customer_ref) {
      try {
        const ligado = await ensureAsaasCustomer(tenantId);
        customerCreated = ligado.created;
        atual = ligado.tenant ?? await Tenant.findById(tenantId);
      } catch (error) {
        if (!(error instanceof AsaasCustomerError)) throw error;
        throw SelfBillingService.customerRefusal(error);
      }
    }

    const resultado = await ChargeIssuingService.issueCurrent({ tenant: atual, manual: true });
    const recusa = SelfBillingService.issueRefusal(resultado);
    if (recusa) throw recusa;

    // `raced` é a outra passada (o agendador, outro clique, a reemissão de uma
    // troca de plano) com a linha na mão: a cobrança é a dela, e é ela que se
    // devolve — mas só depois de ela EXISTIR no gateway. Devolver a linha
    // ainda sem link seria um botão "pagar" que não leva a lugar nenhum.
    let charge = resultado.charge ?? null;
    if (resultado.reason === 'raced') {
      charge = await SelfBillingService.waitForInvoice(charge);
      if (!charge) throw ocupado();
    }
    if (!charge) {
      throw new SelfBillingError('charges.payFailed', { code: 'gateway_failed', status: 502 });
    }
    return { charge, issued: Boolean(resultado.issued), customerCreated };
  }

  /** Quanto o "pagar agora" espera pela cobrança que outra passada está emitindo. */
  static RACE_WAIT_MS = 3000;

  static RACE_POLL_MS = 200;

  /**
   * A linha que outra passada está emitindo, relida até ela ter o link — ou
   * nulo, quando o prazo acaba, a linha some ou a emissão do outro falha.
   *
   * Espera curta e com teto, dentro da requisição: a chamada ao gateway leva
   * um ou dois segundos quando dá certo, e é esse o caso que vale esperar. Se
   * não saiu em três, quem clicou ouve "tente de novo em instantes" — o que é
   * melhor que prender a requisição pelo prazo inteiro de uma chamada lenta.
   */
  static async waitForInvoice(linha) {
    if (!linha?.id) return null;
    const limite = Date.now() + SelfBillingService.RACE_WAIT_MS;
    let atual = linha;
    for (;;) {
      if (atual.gateway_charge_id && atual.invoice_url) return atual;
      // Fechada (paga, cancelada) no meio da espera: não há mais o que pagar
      // por ela. `failed` continua esperando — é o estado de uma linha sendo
      // retentada, e a outra passada pode estar emitindo por ela agora.
      if (!OPEN_CHARGE_STATUSES.includes(atual.status)) return null;
      if (Date.now() >= limite) return null;
      // eslint-disable-next-line no-await-in-loop -- é uma espera, uma leitura por volta
      await new Promise((resolve) => { setTimeout(resolve, SelfBillingService.RACE_POLL_MS); });
      // eslint-disable-next-line no-await-in-loop
      atual = await BillingCharge.findById(linha.id);
      if (!atual) return null;
    }
  }

  /** A recusa do cadastro no gateway, nos códigos do "pagar agora". */
  static customerRefusal(error) {
    switch (error.code) {
      case 'missing_tax_id':
        return new SelfBillingError('charges.missingTaxId', { code: 'missing_tax_id', status: 400 });
      case 'invalid_tax_id':
        return new SelfBillingError('charges.invalidTaxId', { code: 'invalid_tax_id', status: 400 });
      case 'missing_name':
        return new SelfBillingError('charges.missingName', { code: 'missing_name', status: 400 });
      case 'not_configured':
        return new SelfBillingError('charges.gatewayNotConfigured', { code: 'gateway_not_configured', status: 503 });
      case 'not_found':
      case 'already_linked':
        return new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
      default:
        return new SelfBillingError('charges.gatewayFailed', {
          code: 'gateway_failed', status: 502, vars: { detail: error.message }, detail: error.message
        });
    }
  }

  /** O que a emissão respondeu, quando não é uma cobrança — ou nulo. */
  static issueRefusal(resultado) {
    if (resultado.issued || resultado.reason === 'already_issued' || resultado.reason === 'raced') return null;
    switch (resultado.reason) {
      case 'free_plan':
        return new SelfBillingError('charges.freePlan', { code: 'free_plan', status: 409 });
      case 'gateway_not_configured':
        return new SelfBillingError('charges.gatewayNotConfigured', { code: 'gateway_not_configured', status: 503 });
      case 'gateway_failed':
        return new SelfBillingError('charges.gatewayFailed', {
          code: 'gateway_failed', status: 502, vars: { detail: resultado.error }, detail: resultado.error
        });
      default:
        // Plataforma, sem gateway que emita, sem assinatura, parada por gente,
        // período já quitado: para quem clicou, tudo é "daqui não se cobra".
        return new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
    }
  }
}

export default SelfBillingService;
