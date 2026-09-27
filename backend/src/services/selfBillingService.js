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
 *   - SUBIR vale NA HORA; DESCER, com um período pago correndo, vale na
 *     RENOVAÇÃO (ver `changePlan`). Não há proporcional: a próxima cobrança
 *     sai pelo preço do plano que o período seguinte vai ter, e o período já
 *     pago continua valendo até o fim como está. Proporcional é uma conta que
 *     o provedor não consegue conferir de cabeça, e o que não se confere de
 *     cabeça vira chamado.
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

/**
 * Põe a cobrança em aberto do prazo vivo no preço de `plano`: cancela no
 * gateway a que saiu com o preço velho e deixa a linha pronta para reemitir.
 *
 * Devolve `'reissued'` quando mexeu e `'none'` quando não havia o que mexer
 * (sem cobrança, ou já no preço). Lança `SelfBillingError` quando não
 * consegue — e aí NADA mudou no plano, porque quem chama só troca o plano
 * depois desta função voltar: uma fatura velha viva ao lado de um plano novo
 * é o provedor pagando o preço errado pelo link que já tem no e-mail.
 *
 * É a mesma porta para as três situações que mudam o preço de um prazo — a
 * subida, a descida agendada e a desistência dela —, porque as três fazem a
 * mesma coisa com a mesma linha, e três cópias desta dança com o gateway
 * seriam três lugares para uma delas esquecer a garra.
 */
async function reprecificarCobranca(subscription, plano) {
  const nada = { acao: 'none', linhaId: null };
  const preco = Number(plano?.price_cents ?? 0);
  const moeda = String(plano?.currency || 'BRL').toUpperCase();
  // Um plano sem preço não tem cobrança a reemitir: a do prazo fica como está,
  // e a faxina da emissão cuida dela. Não acontece pela tela (plano de graça
  // não é destino de troca), mas o plano atual de quem desiste de uma descida
  // pode ser um que o console deixou sem preço.
  if (!(preco > 0)) return nada;
  const aberta = await cobrancaEmAberto(subscription);
  if (!aberta || (Number(aberta.amount_cents) === preco
    && String(aberta.currency || '').toUpperCase() === moeda)) {
    return nada;
  }

  // A garra antes de tudo, inclusive antes do gateway: é ela que impede
  // duas trocas simultâneas (dois administradores, dois cliques) de
  // cancelarem e reemitirem a mesma linha cada uma — e o agendador ou um
  // "pagar agora" de emitirem por ela no meio da troca. Quem não a
  // consegue ouve "tente de novo em instantes", que é a verdade: alguém
  // está mexendo nesta cobrança agora.
  const agora = new Date();
  const garraAte = new Date(agora.getTime() + GARRA_DA_TROCA_MS);
  const minha = await BillingCharge.claim(aberta.id, { until: garraAte, now: agora, unissued: false });
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
    return nada;
  }

  if (linha.gateway_charge_id) {
    // A do gateway sai ANTES de o plano mudar, e a falha dela para tudo.
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
  //
  // A garra CONTINUA com quem chamou (`holdUntil`): o plano novo (ou a
  // descida agendada) ainda vai ser gravado, e uma linha sem id e sem dono
  // entre as duas escritas seria emitida pelo agendador ou por um "pagar
  // agora" com o preço que o estado velho ainda diz. Quem chama a solta em
  // `reemitir` — ou em `soltar`, se a gravação falhar.
  if (!(await BillingCharge.resetForReissue(linha.id, { amountCents: preco, currency: moeda, holdUntil: garraAte }))) {
    await BillingCharge.release(linha.id);
    throw ocupado();
  }
  return { acao: 'reissued', linhaId: linha.id };
}

/**
 * Se a descida agendada já foi paga pelo preço dela — e portanto não se
 * desfaz (0074).
 *
 * A marca na assinatura é a resposta (`pending_plan_locked_at`, gravada por
 * `recordPayment`). A cobrança do período da descida PAGA por menos que o
 * preço do plano atual é a segunda leitura, para o caso em que o pagamento
 * entrou por um caminho que não passou por lá — e, achada, vira marca.
 */
async function descidaTravada(subscription, atual) {
  if (!subscription?.pending_plan_id) return false;
  if (SubscriptionService.isPendingLocked(subscription)) return true;
  const quando = subscription.pending_plan_at ? new Date(subscription.pending_plan_at) : null;
  if (!quando || Number.isNaN(quando.getTime())) return false;
  const linha = await BillingCharge.forPeriod(ChargeIssuingService.periodKey(quando));
  const pagaBarato = linha?.status === 'paid'
    && Number(linha.amount_cents) < Number(atual?.price_cents ?? 0);
  if (pagaBarato) {
    await Subscription.upsertForTenant(subscription.tenant_id, { pending_plan_locked_at: new Date() });
    SubscriptionService.invalidate(subscription.tenant_id);
  }
  return pagaBarato;
}

/** Solta a garra que `reprecificarCobranca` deixou segura, se deixou. */
async function soltar(cobranca) {
  if (cobranca?.linhaId) await BillingCharge.release(cobranca.linhaId);
}

/**
 * Grava o estado novo (`escrever`) com a cobrança reprecificada ainda segura,
 * e a solta se a gravação falhar — sem isso a linha ficaria sem dono e sem
 * id por dois minutos, até a garra vencer.
 */
async function gravarSegurando(cobranca, escrever) {
  try {
    return await escrever();
  } catch (error) {
    await soltar(cobranca);
    throw error;
  }
}

/**
 * A reemissão, logo depois de o plano (ou o agendamento) estar gravado, pela
 * porta de sempre — é o estado novo que a emissão lê para decidir o preço.
 *
 * Melhor esforço: se o gateway falhar aqui, a troca já aconteceu e está
 * certa, e a linha fica `failed` com a espera de sempre, que o agendador ou o
 * "pagar agora" retomam. O que não pode é a falha da reemissão desfazer a
 * troca.
 */
async function reemitir(cobranca, tenant, { countDevices = null, pendingBlockedBy = undefined } = {}) {
  if (cobranca?.acao !== 'reissued') return undefined;
  try {
    // A garra sai logo antes da emissão, que a toma de novo: o estado novo já
    // está gravado, então quem pegar a linha no meio emite pelo preço certo.
    await soltar(cobranca);
    // Com o veredito que quem chamou JÁ usou para escolher o preço
    // (`pendingBlockedBy`), ou a contagem de ONTs dele: reemitir sem nenhum
    // dos dois seria chamar de "cabe" um bloqueio por ONTs — e a passada
    // seguinte reprecificaria de volta, uma fatura nova por minuto.
    return await ChargeIssuingService.issueCurrent({ tenant, manual: true, countDevices, pendingBlockedBy });
  } catch (error) {
    console.error(`Reissue after self-service plan change failed for provider ${tenant.id}:`, error.message);
    return { issued: false, reason: 'error', error: error.message };
  }
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
   * ## Subir vale na hora; descer, na renovação
   *
   * A regra antiga — toda troca na hora — tinha um buraco que a revisão
   * achou: subir para o plano caro logo depois de pagar, usar os tetos
   * maiores e descer de volta antes de a próxima cobrança sair. O plano caro
   * nunca era pago. Então:
   *
   *   - **Subir** (preço novo maior que o atual) vale na hora, como sempre:
   *     o provedor ganha os tetos agora, e a próxima cobrança já sai pelo
   *     preço novo. Preço IGUAL também vale na hora — não há diferença a
   *     ganhar esperando, e chamar isso de descida só confundiria a tela.
   *   - **Descer** com um período pago correndo (`active`, `renews_at` no
   *     futuro) fica AGENDADO para a renovação: o plano e os tetos continuam
   *     os de agora até lá, e a cobrança daquele prazo — que paga o período
   *     seguinte — sai com o preço novo. O uso não é conferido agora: o
   *     provedor tem até a renovação para caber, e quem confere é a aplicação
   *     (`SubscriptionService.applyPendingPlan`), que não troca enquanto não
   *     couber.
   *   - **Descer** sem período pago correndo (teste, atraso, assinatura sem
   *     data) vale na hora: não há mês pago de plano caro a proteger, e fazer
   *     quem está em atraso esperar uma renovação que não vem seria prendê-lo
   *     no preço que ele justamente não consegue pagar.
   *   - Escolher o plano ATUAL com uma descida agendada é desistir dela.
   *     Escolher outro mais barato substitui a agendada.
   *
   * A ordem é a das recusas baratas primeiro e da única coisa irreversível por
   * último: plano, estado, uso — tudo leitura —, e só então o gateway, porque
   * uma cobrança cancelada lá não volta.
   *
   * @returns {Promise<{ changed: boolean, scheduled: boolean, pendingCanceled: boolean,
   *   effectiveAt: Date|null, from: number|null, to: number, plan: object,
   *   charge: 'none'|'reissued', reissue?: object }>}
   */
  static async changePlan({ planId, actorUserId = null, countDevices = null, now = new Date() }) {
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

    const de = subscription.plan_id ?? null;
    const atual = de ? await Plan.findById(de) : null;
    const agendadoId = subscription.pending_plan_id ? Number(subscription.pending_plan_id) : null;
    const base = { from: de, to: id, scheduled: false, pendingCanceled: false, effectiveAt: null, charge: 'none' };

    // A descida já PAGA pelo preço dela não se desfaz (0074): nem desistir,
    // nem trocar por outra, nem subir antes da data. Pagar o barato adiantado
    // e depois ficar no caro — por desistência, ou subindo "de volta" — era o
    // mês de plano caro pelo preço do barato. Pedir a própria descida de novo
    // é o único clique que passa, porque não muda nada. Depois da data ela se
    // aplica, e a trava some com ela.
    if (agendadoId && await descidaTravada(subscription, atual)) {
      if (agendadoId === id) {
        const plan = await Plan.findById(id);
        const quando = subscription.pending_plan_at ? new Date(subscription.pending_plan_at) : null;
        return { ...base, changed: false, scheduled: true, effectiveAt: quando, plan };
      }
      throw new SelfBillingError('subscription.pendingLocked', {
        code: 'pending_locked',
        status: 409,
        vars: { date: subscription.pending_plan_at ? ChargeIssuingService.isoDate(subscription.pending_plan_at) : '' },
        extra: {
          pendingPlanId: agendadoId,
          effectiveAt: subscription.pending_plan_at ? new Date(subscription.pending_plan_at).toISOString() : null
        }
      });
    }

    // O mesmo plano é um clique a mais, não um erro — e não uma linha no
    // extrato dizendo que algo mudou. Vale até para o plano atual inativo: é
    // "ficar onde está", e isso nunca foi proibido.
    //
    // Com uma descida agendada, "ficar onde está" é justamente desistir dela:
    // a cobrança da renovação, se já saiu com o preço menor, volta ao preço
    // do plano atual pela mesma porta da troca — cancelada lá e reemitida.
    if (Number(de) === id) {
      if (!agendadoId) return { ...base, changed: false, plan: atual };
      const cobranca = await reprecificarCobranca(subscription, atual);
      await gravarSegurando(cobranca, () => SubscriptionService.cancelPendingPlan());
      const reissue = await reemitir(cobranca, tenant, { countDevices });
      return {
        ...base, changed: false, pendingCanceled: true, canceledPlanId: agendadoId, plan: atual,
        charge: cobranca.acao, ...(reissue ? { reissue } : {})
      };
    }

    const plan = await Plan.findById(id);
    // Inativo ou de graça, a mesma resposta: não está no catálogo que este
    // provedor pode escolher (`listPlans`), e para quem pede é como se não
    // existisse. Um 403 para o de graça diria "existe, mas não para você", e
    // é uma frase que não precisa ser dita.
    if (!plan || !plan.active || !ehPago(plan)) {
      throw new SelfBillingError('subscription.planNotFound', { code: 'plan_not_found', status: 404 });
    }

    // Subida, descida agendada ou descida na hora — ver o comentário do método.
    // `renews_at` no futuro é o período pago correndo; o estado gravado
    // `active` com o prazo já vencido é `past_due` de fato (`effectiveStatus`)
    // e cai na descida imediata, como o atraso.
    const renovacao = subscription.renews_at ? new Date(subscription.renews_at) : null;
    const periodoCorrendo = subscription.status === 'active'
      && renovacao && !Number.isNaN(renovacao.getTime()) && renovacao.getTime() > now.getTime();
    const desce = Number(plan.price_cents ?? 0) < Number(atual?.price_cents ?? 0);
    const agendar = Boolean(periodoCorrendo && desce);

    // Pedir de novo a descida que já está agendada não muda nada — nem a
    // cobrança, nem a trilha, nem a data. A data sobretudo: depois de um
    // pagamento adiantado `renews_at` já é o mês seguinte, e regravar a
    // agendada com ele adiaria a descida por um clique repetido.
    if (agendar && agendadoId === id) {
      const jaAgendada = subscription.pending_plan_at ? new Date(subscription.pending_plan_at) : null;
      return { ...base, changed: false, scheduled: true, effectiveAt: jaAgendada ?? renovacao, plan };
    }

    // O uso tem que caber no plano novo — quando ele vale agora. Não é o mesmo
    // que o 402 dos limites, que recusa CRESCER além do teto: aqui o provedor
    // já está lá, e descer para um plano menor que o uso deixaria a conta
    // estourada no minuto seguinte — nada de novo cabe e ninguém entende por
    // quê. A contagem de ONTs pode faltar (o ACS fora do ar); faltando, ela
    // não decide nada, pela mesma regra de `usage`.
    //
    // Na descida agendada, não: o provedor tem até a renovação para se
    // ajustar, e recusar agora obrigaria a apagar operadores HOJE para um
    // plano que só vale daqui a semanas. A tela mostra o bloqueio
    // (`pendingPlan.blockedBy`) enquanto ele existir.
    if (!agendar) {
      const { usage } = await SubscriptionService.usage({ countDevices });
      const excesso = SubscriptionService.overLimitFor(SubscriptionService.limitsOf(plan), usage);
      if (excesso) {
        throw new SelfBillingError(MENSAGEM_DO_EXCESSO[excesso.resource], {
          code: 'over_limit',
          status: 409,
          vars: { used: excesso.used, limit: excesso.limit },
          extra: excesso
        });
      }
    }

    // QUANDO a descida vale. Na renovação — a não ser que o plano de agora
    // tenha sido alcançado por uma SUBIDA neste mesmo período pago
    // (`upgraded_at`, 0074). A subida não é cobrada no período em que
    // acontece (não há proporcional); quem a paga é a cobrança seguinte.
    // Descer já na renovação seria usar o plano de cima o período inteiro sem
    // nunca pagá-lo — então a descida vai para a renovação SEGUINTE, e o
    // próximo período é cobrado pelo preço de cima.
    let quando = renovacao;
    if (agendar && subscription.upgraded_at) {
      quando = new Date(renovacao.getTime() + SubscriptionService.periodDaysOf(atual) * 86_400_000);
    }
    const adiada = agendar && quando.getTime() !== renovacao.getTime();

    // A cobrança em aberto do prazo vivo passa a pedir o preço do plano que
    // aquele prazo compra. Na subida (e em toda troca na hora), o novo. Na
    // descida agendada para esta renovação, também o novo — essa cobrança
    // paga o período que começa nela —, mas só se o uso couber, pela mesma
    // conta que a emissão faz (`issueCurrent`): se não couber, a descida não
    // vai se aplicar e o período é do atual. E na descida adiada pela subida,
    // o atual: o período que essa cobrança paga ainda é o de cima.
    //
    // O veredito do uso vai junto para a reemissão, em vez de ela recontar:
    // uma contagem de ONTs que muda entre as duas leituras cancelaria a
    // fatura por um preço e a reemitiria por outro.
    let bloqueio;
    let alvo = plan;
    if (agendar) {
      bloqueio = adiada ? null : await SubscriptionService.overLimitOf(plan, { countDevices });
      if (adiada || bloqueio) alvo = atual;
    }
    const cobranca = await reprecificarCobranca(subscription, alvo);

    // A marca da subida no meio do período pago: só quando SOBE com o período
    // correndo, e a mais antiga fica (subir duas vezes no mesmo período não
    // apaga a primeira). Preço igual a mantém. Descer na hora a apaga — não há
    // período pago correndo a proteger.
    let upgradedAt = null;
    if (!agendar && periodoCorrendo) {
      const sobe = Number(plan.price_cents ?? 0) > Number(atual?.price_cents ?? 0);
      upgradedAt = subscription.upgraded_at ?? (sobe ? now : null);
    }

    await gravarSegurando(cobranca, () => (agendar
      ? SubscriptionService.schedulePlanChange({ planId: plan.id, at: quando })
      : SubscriptionService.changePlan({ planId: plan.id, actorUserId, upgradedAt })));

    const reissue = await reemitir(cobranca, tenant, { countDevices, pendingBlockedBy: bloqueio });
    return {
      ...base,
      changed: true,
      scheduled: agendar,
      effectiveAt: agendar ? quando : null,
      ...(adiada ? { deferredByUpgrade: true } : {}),
      ...(agendadoId && agendadoId !== id ? { replacedPlanId: agendadoId } : {}),
      plan,
      charge: cobranca.acao,
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
  static async payNow({ countDevices = null } = {}) {
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

    const resultado = await ChargeIssuingService.issueCurrent({ tenant: atual, manual: true, countDevices });
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

  /**
   * A cobrança em aberto do prazo vivo posta no preço de `plan` e reemitida —
   * a porta da troca de plano, aberta para a emissão quando uma descida
   * agendada fica bloqueada depois de a cobrança dela já ter saído (ver
   * `ChargeIssuingService.repriceBlockedDowngrade`). Lança `SelfBillingError`
   * como a troca: quem chama decide o que fazer com a recusa.
   */
  static async repriceOpenCharge({ subscription, plan, tenant, blockedBy = undefined }) {
    const cobranca = await reprecificarCobranca(subscription, plan);
    const reissue = await reemitir(cobranca, tenant, { pendingBlockedBy: blockedBy });
    return { charge: cobranca.acao, ...(reissue ? { reissue } : {}) };
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
