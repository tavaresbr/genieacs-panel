import Tenant from '../models/Tenant.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import BillingCharge, { OPEN_CHARGE_STATUSES, isoDateOf } from '../models/BillingCharge.js';
import PlatformAudit from '../models/PlatformAudit.js';
import SubscriptionService from '../services/subscriptionService.js';
import ChargeIssuingService from '../services/chargeIssuingService.js';
import { providerFor } from '../services/billing/registry.js';
import { AsaasError } from '../services/billing/asaasClient.js';
import { runInTenant } from '../config/tenantContext.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { recordBoth, subscriptionView } from './platformBillingController.js';

/**
 * A tela de Assinaturas do console: todos os provedores de uma vez, com o que
 * cada um deve, e os gestos sobre UMA cobrança — dar baixa, cancelar, mudar
 * vencimento ou valor, reemitir — mais o prazo mexido à mão.
 *
 * O resto do que se faz com uma assinatura (trocar o plano, suspender,
 * reativar) continua em `PUT /tenants/:id/subscription`, que já existia: esta
 * tela o chama em vez de ganhar uma segunda porta para a mesma coisa.
 *
 * ## As mesmas regras de `PlatformBillingController`
 *
 * Toda escrita acontece NO ESCOPO do provedor (`runInTenant`), e é isso que
 * torna o id da cobrança seguro: `BillingCharge.findById` lê por `tdb`, então
 * o id de uma cobrança do vizinho, pedido pela URL de outro provedor,
 * simplesmente não é achado — 404, e não "a cobrança certa do provedor
 * errado". E cada gesto grava nas duas trilhas (`recordBoth`): a nossa diz o
 * que fizemos, a do provedor diz o que aconteceu com ele.
 *
 * ## A garra, de novo
 *
 * Toda escrita sobre uma cobrança em aberto toma a linha antes
 * (`BillingCharge.claim` com `unissued: false`) e a solta depois — a mesma
 * garra da emissão e da troca de plano. Sem ela, o agendador (ou o "pagar
 * agora" do provedor) poderia estar reemitindo exatamente a linha que o
 * console está cancelando, e as duas escritas se cruzariam no gateway. Quem
 * perde a garra ouve `busy`, e tenta de novo em instantes.
 */

/** O prazo curto da garra do console: uma chamada ao gateway e duas escritas. */
const CLAIM_MS = ChargeIssuingService.CLAIM_MS;

/** Uma recusa com status e código, lançada de dentro do escopo e respondida fora. */
class ConsoleChargeError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** `YYYY-MM-DD` de verdade — o formato E um dia que existe (`2026-02-30` não). */
function parseIsoDay(value) {
  const texto = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const data = new Date(`${texto}T12:00:00Z`);
  if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== texto) return null;
  return texto;
}

/** Hoje, no fuso em que a cobrança é lida — o mesmo da emissão. */
function hoje(now = new Date()) {
  return ChargeIssuingService.isoDate(now);
}

/**
 * O provedor da URL, ou a resposta já dada.
 *
 * A caixa da plataforma responde 404 como um id que não existe, e não 400 nem
 * 409: ela não é cliente, não tem assinatura a mostrar nem cobrança a mexer,
 * e para esta tela ela simplesmente não está lá — é o mesmo recorte de
 * `Tenant.list()`, que a deixa fora da listagem.
 */
async function tenantOr404(req, res) {
  const id = parseId(req.params?.id);
  if (!id) {
    res.status(400).json(createErrorResponse('Invalid provider id'));
    return null;
  }
  const tenant = await Tenant.findById(id);
  if (!tenant || tenant.kind === 'platform') {
    res.status(404).json(createErrorResponse('Provider not found'));
    return null;
  }
  return tenant;
}

function responderRecusa(res, error) {
  return res.status(error.status).json({
    ...createErrorResponse(error.message, null, error.code),
    // Os campos nomeados no TOPO, como o 409 de `recordPayment`: o cliente de
    // API encaminha campo nomeado num erro, não o `data` inteiro.
    ...error.extra
  });
}

/**
 * A cobrança da URL, dentro do escopo do provedor, e EM ABERTO.
 *
 * As duas recusas na ordem em que alguém as entende: primeiro "não existe"
 * (inclusive a do vizinho, que daqui não se vê), depois "existe, mas já
 * fechou" — paga, cancelada ou estornada não tem baixa, cancelamento nem
 * vencimento a mudar.
 */
async function cobrancaEmAberto(chargeId) {
  const cobranca = await BillingCharge.findById(chargeId);
  if (!cobranca) throw new ConsoleChargeError(404, 'Charge not found', 'not_found');
  if (!OPEN_CHARGE_STATUSES.includes(cobranca.status)) {
    throw new ConsoleChargeError(409, `The charge is ${cobranca.status}, not open`, 'not_open', {
      status: cobranca.status
    });
  }
  return cobranca;
}

/** Toma a linha para o console, ou recusa com `busy`. */
async function tomar(cobranca, now = new Date()) {
  const minha = await BillingCharge.claim(cobranca.id, {
    until: new Date(now.getTime() + CLAIM_MS), now, unissued: false
  });
  if (!minha) {
    throw new ConsoleChargeError(409, 'The charge is being changed by another process; try again shortly', 'busy');
  }
}

/**
 * A chamada ao gateway, com a recusa dele traduzida.
 *
 * 502 e `gateway_failed`, como no "pagar agora" do provedor: o pedido estava
 * certo, quem falhou foi o sistema de fora. O motivo do gateway vai em
 * `detail`, porque quem lê esta tela opera a conta de lá e é o texto dele que
 * resolve o chamado.
 */
async function noGateway(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AsaasError) {
      throw new ConsoleChargeError(502, `The payment gateway refused: ${error.message}`, 'gateway_failed', {
        detail: error.message
      });
    }
    throw error;
  }
}

/**
 * O provider que fala pela LINHA, se ela tem o que falar com ele.
 *
 * Pela linha e não pelo provedor: é o gateway que EMITIU esta cobrança quem
 * sabe dela, mesmo que o provedor tenha sido religado a outro depois. Sem id
 * do lado de lá, ou com um provider que não sabe fazer o gesto (o `manual`),
 * não há chamada nenhuma — o console mexe só do lado de cá.
 */
function gatewayDa(cobranca, metodo) {
  if (!cobranca.gateway_charge_id) return null;
  const provider = providerFor(cobranca.provider);
  return provider && typeof provider[metodo] === 'function' ? provider : null;
}

class PlatformSubscriptionsController {
  /**
   * `GET /api/platform/subscriptions` — todos os provedores, com a assinatura,
   * o vínculo com o gateway e a cobrança em aberto mais recente.
   *
   * Quatro consultas, sempre, e nenhuma por provedor: os provedores, as
   * assinaturas com o plano (`Subscription.listWithPlans`), o catálogo (para a
   * descida agendada) e as cobranças em aberto de todos
   * (`BillingCharge.openAcrossTenants`). As duas escopadas são lidas sem
   * escopo com a razão escrita no modelo — é a única tela do produto em que
   * ver todos de uma vez é o trabalho.
   *
   * O estado de cada um é o que VALE (`effectiveStatus`), não o gravado: um
   * `active` com a renovação vencida é `past_due` para o gate, e a lista que
   * dissesse outra coisa esconderia exatamente quem precisa ser cobrado. O
   * gravado viaja ao lado (`storedStatus`) para quem precisar dos dois.
   */
  static async listSubscriptions(req, res) {
    try {
      const now = new Date();
      const tenants = await Tenant.list();
      const assinaturas = new Map(
        (await Subscription.listWithPlans()).map((row) => [Number(row.tenant_id), row])
      );
      const planos = new Map((await Plan.list()).map((plan) => [Number(plan.id), plan]));
      const ids = new Set(tenants.map((tenant) => Number(tenant.id)));

      // A mais recente em aberto de cada um (a lista vem por `period_end`
      // decrescente, então a primeira vista é a que fica) — a mesma escolha de
      // `BillingCharge.currentOpen`, que é a que o aviso de vencimento linka.
      const abertas = (await BillingCharge.openAcrossTenants())
        .filter((row) => ids.has(Number(row.tenant_id)));
      const abertaDe = new Map();
      for (const row of abertas) {
        if (!abertaDe.has(Number(row.tenant_id))) abertaDe.set(Number(row.tenant_id), row);
      }

      const byStatus = { trial: 0, active: 0, past_due: 0, suspended: 0, canceled: 0, none: 0 };
      const rows = tenants.map((tenant) => {
        const sub = assinaturas.get(Number(tenant.id)) || null;
        const status = sub ? SubscriptionService.effectiveStatus(sub, now).status : null;
        byStatus[status && status in byStatus ? status : 'none'] += 1;
        const pendente = sub?.pending_plan_id ? planos.get(Number(sub.pending_plan_id)) : null;
        return {
          tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
          subscription: sub ? {
            status,
            storedStatus: sub.status,
            planId: sub.plan_id ?? null,
            planCode: sub.plan_code ?? null,
            planName: sub.plan_name ?? null,
            priceCents: Number(sub.plan_price_cents ?? 0),
            currency: sub.plan_currency ?? null,
            trialEndsAt: sub.trial_ends_at ?? null,
            renewsAt: sub.renews_at ?? null,
            pendingPlan: SubscriptionService.presentPendingPlan(sub, pendente)
          } : null,
          // SE há vínculo, e nunca o id do cliente no gateway — a mesma regra
          // da trilha (`TENANT_GATEWAY_CHANGED`): é a chave que decide para
          // quem vai o crédito, e uma lista é lida por mais gente que a ficha.
          gateway: {
            gateway: tenant.billing_gateway || null,
            linked: Boolean(tenant.billing_gateway && tenant.billing_customer_ref)
          },
          openCharge: BillingCharge.presentForConsole(abertaDe.get(Number(tenant.id)) || null)
        };
      });

      // O total é de TODAS as em aberto, e não só da mais recente de cada um:
      // a pergunta é "quanto temos a receber", e uma cobrança velha esquecida
      // em aberto é dinheiro a receber como qualquer outra. Atrasada é a que
      // o gateway chamou de `overdue` OU a que passou do vencimento sem que o
      // aviso dele tenha chegado — contar só a etiqueta deixaria de fora quem
      // o webhook ainda não alcançou.
      const dia = hoje(now);
      let openTotalCents = 0;
      let overdueCount = 0;
      for (const row of abertas) {
        openTotalCents += Number(row.amount_cents) || 0;
        const vencimento = isoDateOf(row.due_date);
        if (row.status === 'overdue' || (vencimento && vencimento < dia)) overdueCount += 1;
      }

      return res.json(createResponse('Subscriptions retrieved', {
        rows,
        summary: { byStatus, openTotalCents, overdueCount }
      }));
    } catch (error) {
      console.error('List subscriptions error:', error);
      return res.status(500).json(createErrorResponse('Failed to list the subscriptions', error.message));
    }
  }

  /** `GET /api/platform/tenants/:id/charges` — as 24 mais recentes, como o console as vê. */
  static async listCharges(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      // Vinte e quatro: dois anos de um plano mensal, que é o horizonte em que
      // alguém ainda pergunta "esse mês foi pago?". Mais que isso é histórico,
      // e o histórico mora no extrato.
      const linhas = await runInTenant(tenant.id, () => BillingCharge.listRecent({ limit: 24 }));
      return res.json(createResponse('Charges retrieved', {
        charges: linhas.map((row) => BillingCharge.presentForConsole(row))
      }));
    } catch (error) {
      console.error('List charges error:', error);
      return res.status(500).json(createErrorResponse('Failed to list the charges', error.message));
    }
  }

  /**
   * `PATCH /api/platform/tenants/:id/subscription/deadlines` — a cortesia de
   * alguns dias (`extendDays`) ou a data exata (`renewsAt`, `trialEndsAt`).
   * Uma forma por pedido: somar dias E fixar a data ao mesmo tempo não tem
   * leitura que não seja um palpite sobre qual das duas se quis.
   *
   * Responde o mesmo que `GET /tenants/:id/subscription`, para a tela trocar
   * o que mostra sem ter de perguntar de novo.
   */
  static async setDeadlines(req, res) {
    try {
      const body = req.body ?? {};
      const temData = body.renewsAt !== undefined || body.trialEndsAt !== undefined;
      const temDias = body.extendDays !== undefined && body.extendDays !== null;
      if (!temData && !temDias) {
        return res.status(400).json(createErrorResponse('Nothing to update'));
      }
      if (temData && temDias) {
        return res.status(400).json(createErrorResponse('Send either extendDays or explicit dates, not both'));
      }
      let extendDays = null;
      if (temDias) {
        extendDays = Number(body.extendDays);
        if (!Number.isInteger(extendDays) || extendDays < 1 || extendDays > 365) {
          return res.status(400).json(createErrorResponse('extendDays must be an integer between 1 and 365'));
        }
      }
      if (body.renewsAt !== undefined
        && (body.renewsAt === null || Number.isNaN(new Date(body.renewsAt).getTime()))) {
        return res.status(400).json(createErrorResponse('renewsAt must be a date'));
      }
      if (body.trialEndsAt !== undefined && body.trialEndsAt !== null
        && Number.isNaN(new Date(body.trialEndsAt).getTime())) {
        return res.status(400).json(createErrorResponse('trialEndsAt must be a date or null'));
      }
      const reason = body.reason ? String(body.reason).slice(0, 255) : null;

      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const before = await Subscription.forTenant(tenant.id);
      if (!before) return res.status(404).json(createErrorResponse('Subscription not found'));

      const after = await runInTenant(tenant.id, () => SubscriptionService.setDeadlines({
        renewsAt: body.renewsAt,
        trialEndsAt: body.trialEndsAt,
        extendDays,
        reason,
        actorUserId: req.user?.userId ?? null
      }));

      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_DEADLINE_CHANGED,
        detail: {
          ...(extendDays ? { extendDays } : {}),
          from: { renewsAt: before.renews_at ?? null, trialEndsAt: before.trial_ends_at ?? null },
          to: { renewsAt: after.renews_at ?? null, trialEndsAt: after.trial_ends_at ?? null },
          status: before.status,
          reason
        }
      });
      return res.json(createResponse('Deadlines updated', await subscriptionView(tenant)));
    } catch (error) {
      console.error('Set deadlines error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the deadlines', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/charges/:chargeId/settle` — o provedor
   * pagou por fora, e alguém dá baixa na cobrança.
   *
   * ## A ordem é o que importa
   *
   *   1. **A conferência do valor, antes de tudo.** Contra o valor DA
   *      COBRANÇA, que é o que se pediu. Se ela recusasse depois do gateway, a
   *      Asaas já teria a cobrança como recebida — o provedor veria "pago" lá
   *      e "em aberto" aqui, e desfazer um recebimento no gateway é outro
   *      chamado. Pago a menos só passa com `allowUnderpayment`, explícito,
   *      como no botão de pagamento avulso.
   *   2. **A garra**, para ninguém reemitir ou cancelar esta linha no meio.
   *   3. **O gateway** (`receiveInCash`), quando a cobrança está lá. Se ele
   *      recusa, NADA é gravado: o crédito sem o recebimento do lado de lá
   *      deixaria uma cobrança viva no gateway para um período já pago — e o
   *      gateway continuaria cobrando o provedor por ela.
   *   4. **O crédito**, por `SubscriptionService.recordPayment` — a mesma porta
   *      do webhook, com a mesma idempotência. A referência é o id da cobrança
   *      no gateway, e é isso que faz o `PAYMENT_RECEIVED` que a Asaas manda
   *      depois do `receiveInCash` cair como `duplicate` em vez de creditar o
   *      período outra vez. Sem id no gateway, `charge:<id da linha>`.
   *   5. **A linha vira `paid`**, e a garra sai.
   *
   * Se o webhook ganhar a corrida — a Asaas avisa o recebimento enquanto esta
   * requisição ainda não gravou —, é o crédito DELE que vale, e o daqui
   * responde `duplicate: true`: um crédito só, venha de onde vier.
   */
  static async settle(req, res) {
    try {
      const body = req.body ?? {};
      const paidAt = parseIsoDay(body.paidAt);
      if (!paidAt) return res.status(400).json(createErrorResponse('paidAt must be a date as YYYY-MM-DD'));
      const now = new Date();
      // Um recebimento no futuro não é um recebimento, e o gateway recusaria
      // do mesmo jeito — só que depois da garra e com um texto pior.
      if (paidAt > hoje(now)) return res.status(400).json(createErrorResponse('paidAt cannot be in the future'));
      const amount = Number(body.amountCents);
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json(createErrorResponse('amountCents must be a positive integer'));
      }
      const allowUnderpayment = body.allowUnderpayment === true;
      const note = body.note ? String(body.note).slice(0, 255) : null;
      const chargeId = parseId(req.params?.chargeId);
      if (!chargeId) return res.status(400).json(createErrorResponse('Invalid charge id'));

      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const actorUserId = req.user?.userId ?? null;

      let resultado;
      try {
        resultado = await runInTenant(tenant.id, async () => {
          const cobranca = await cobrancaEmAberto(chargeId);
          const pedido = Number(cobranca.amount_cents);
          if (amount < pedido && !allowUnderpayment) {
            throw new ConsoleChargeError(409, 'The amount is short of what was charged', 'underpaid', {
              paidCents: amount, expectedCents: pedido, currency: cobranca.currency
            });
          }

          await tomar(cobranca, now);
          try {
            const gateway = gatewayDa(cobranca, 'receiveInCash');
            if (gateway) {
              await noGateway(() => gateway.receiveInCash(cobranca.gateway_charge_id, {
                paymentDate: paidAt, value: amount
              }));
            }

            const externalId = cobranca.gateway_charge_id || `charge:${cobranca.id}`;
            const pagamento = await SubscriptionService.recordPayment({
              amountCents: amount,
              currency: cobranca.currency,
              provider: 'manual',
              externalId,
              actorUserId,
              allowUnderpayment,
              now
            });
            if (pagamento.underpaid) {
              // Só numa corrida: a conferência lá em cima olhou a MESMA linha.
              // Se chegou aqui, o valor dela mudou entre as duas leituras — e o
              // gateway, se havia, já recebeu. Dito em voz alta, porque é o
              // único caminho em que os dois lados podem discordar.
              console.warn(
                `Console settlement of charge ${cobranca.id} (provider ${tenant.id}) came out short `
                + `after the gateway call: ${amount} of ${pagamento.expectedCents} cents`
              );
              throw new ConsoleChargeError(409, 'The amount is short of what was charged', 'underpaid', {
                paidCents: amount, expectedCents: pagamento.expectedCents, currency: cobranca.currency
              });
            }
            await BillingCharge.update(cobranca.id, { status: 'paid', last_error: null, issuing_until: null });
            return {
              cobranca,
              externalId,
              duplicate: Boolean(pagamento.duplicate),
              gateway: Boolean(gateway),
              charge: await BillingCharge.findById(cobranca.id),
              state: await SubscriptionService.current()
            };
          } finally {
            await BillingCharge.release(cobranca.id);
          }
        });
      } catch (error) {
        if (error instanceof ConsoleChargeError) return responderRecusa(res, error);
        throw error;
      }

      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.CHARGE_SETTLED,
        detail: {
          chargeId: resultado.cobranca.id,
          periodEnd: resultado.cobranca.period_end,
          amountCents: amount,
          expectedCents: Number(resultado.cobranca.amount_cents),
          currency: resultado.cobranca.currency,
          paidAt,
          note,
          reference: resultado.externalId,
          atGateway: resultado.gateway,
          duplicate: resultado.duplicate,
          ...(amount < Number(resultado.cobranca.amount_cents) ? { underpaymentAccepted: true } : {})
        }
      });
      return res.json(createResponse('Charge settled', {
        charge: BillingCharge.presentForConsole(resultado.charge),
        subscription: SubscriptionService.present(resultado.state),
        duplicate: resultado.duplicate
      }));
    } catch (error) {
      console.error('Settle charge error:', error);
      return res.status(500).json(createErrorResponse('Failed to settle the charge', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/charges/:chargeId/cancel` — a cobrança
   * sai de cena, no gateway e aqui.
   *
   * O gateway primeiro, e a recusa dele para tudo: cancelada só do lado de cá,
   * ela continuaria na mão do provedor com link de pagamento — e um pagamento
   * dela chegaria para creditar um período que o console decidiu não cobrar.
   * O 404 do gateway já é sucesso em `cancelCharge` (quem apagou lá fez o que
   * se queria).
   *
   * Cancelada, a cobrança do período atual não volta sozinha: a emissão
   * automática trata `canceled` como resolvido. Quem quiser cobrá-la de novo
   * usa o `reissue`.
   */
  static async cancel(req, res) {
    try {
      const chargeId = parseId(req.params?.chargeId);
      if (!chargeId) return res.status(400).json(createErrorResponse('Invalid charge id'));
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 255) : null;
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;

      let resultado;
      try {
        resultado = await runInTenant(tenant.id, async () => {
          const cobranca = await cobrancaEmAberto(chargeId);
          await tomar(cobranca);
          try {
            const gateway = gatewayDa(cobranca, 'cancelCharge');
            if (gateway) await noGateway(() => gateway.cancelCharge(cobranca.gateway_charge_id));
            await BillingCharge.update(cobranca.id, { status: 'canceled', issuing_until: null });
            return { cobranca, gateway: Boolean(gateway), charge: await BillingCharge.findById(cobranca.id) };
          } finally {
            await BillingCharge.release(cobranca.id);
          }
        });
      } catch (error) {
        if (error instanceof ConsoleChargeError) return responderRecusa(res, error);
        throw error;
      }

      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.CHARGE_CANCELED,
        detail: {
          chargeId: resultado.cobranca.id,
          periodEnd: resultado.cobranca.period_end,
          amountCents: Number(resultado.cobranca.amount_cents),
          statusBefore: resultado.cobranca.status,
          atGateway: resultado.gateway,
          reason
        }
      });
      return res.json(createResponse('Charge canceled', {
        charge: BillingCharge.presentForConsole(resultado.charge)
      }));
    } catch (error) {
      console.error('Cancel charge error:', error);
      return res.status(500).json(createErrorResponse('Failed to cancel the charge', error.message));
    }
  }

  /**
   * `PATCH /api/platform/tenants/:id/charges/:chargeId` — outro vencimento,
   * outro valor, ou os dois.
   *
   * O gateway primeiro, pela mesma razão do cancelamento; a linha depois, com
   * o valor novo — e é a linha que a conferência do pagamento lê
   * (`valorPedido`), então quem pagar o valor novo paga o que se pediu.
   *
   * Uma cobrança que NUNCA chegou ao gateway, de um gateway que emite, é
   * recusada (`not_issued`): a próxima emissão dela reescreve o valor com o
   * preço do plano e o vencimento com o do período (ver `issueCurrent`), e a
   * mudança feita aqui sumiria sem aviso. O gesto certo para ela é o
   * `reissue`.
   *
   * Uma `overdue` com vencimento novo volta a `pending`: ela não está mais
   * atrasada, e é o que o gateway também faz com ela.
   */
  static async update(req, res) {
    try {
      const chargeId = parseId(req.params?.chargeId);
      if (!chargeId) return res.status(400).json(createErrorResponse('Invalid charge id'));
      const body = req.body ?? {};
      const now = new Date();
      let dueDate;
      let amount;
      if (body.dueDate !== undefined) {
        dueDate = parseIsoDay(body.dueDate);
        if (!dueDate) return res.status(400).json(createErrorResponse('dueDate must be a date as YYYY-MM-DD'));
        // Hoje vale; ontem não. O gateway recusa vencimento no passado, e uma
        // cobrança que nasce vencida só serve para gerar aviso de atraso.
        if (dueDate < hoje(now)) return res.status(400).json(createErrorResponse('dueDate cannot be in the past'));
      }
      if (body.amountCents !== undefined) {
        amount = Number(body.amountCents);
        if (!Number.isInteger(amount) || amount <= 0) {
          return res.status(400).json(createErrorResponse('amountCents must be a positive integer'));
        }
      }
      if (dueDate === undefined && amount === undefined) {
        return res.status(400).json(createErrorResponse('Nothing to update'));
      }
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;

      let resultado;
      try {
        resultado = await runInTenant(tenant.id, async () => {
          const cobranca = await cobrancaEmAberto(chargeId);
          if (!cobranca.gateway_charge_id && providerFor(cobranca.provider)?.canIssue) {
            throw new ConsoleChargeError(
              409, 'This charge was never issued at the gateway; reissue it instead', 'not_issued'
            );
          }
          const antes = { amountCents: Number(cobranca.amount_cents), dueDate: isoDateOf(cobranca.due_date) };
          const mudaValor = amount !== undefined && amount !== antes.amountCents;
          const mudaData = dueDate !== undefined && dueDate !== antes.dueDate;
          if (!mudaValor && !mudaData) {
            return { cobranca, antes, depois: antes, charge: cobranca, gateway: false, nada: true };
          }

          await tomar(cobranca, now);
          try {
            const gateway = gatewayDa(cobranca, 'updateCharge');
            let respondido = null;
            if (gateway) {
              respondido = await noGateway(() => gateway.updateCharge(cobranca.gateway_charge_id, {
                ...(mudaData ? { dueDate } : {}),
                ...(mudaValor ? { value: amount } : {})
              }));
            }
            const patch = { issuing_until: null };
            if (mudaValor) patch.amount_cents = amount;
            if (mudaData) {
              // O que o gateway aceitou, quando ele diz: é a data em que o
              // boleto de fato vence, se ele a tiver ajustado.
              patch.due_date = respondido?.dueDate || dueDate;
              if (cobranca.status === 'overdue') patch.status = 'pending';
            }
            await BillingCharge.update(cobranca.id, patch);
            const charge = await BillingCharge.findById(cobranca.id);
            return {
              cobranca,
              antes,
              depois: { amountCents: Number(charge.amount_cents), dueDate: isoDateOf(charge.due_date) },
              charge,
              gateway: Boolean(gateway)
            };
          } finally {
            await BillingCharge.release(cobranca.id);
          }
        });
      } catch (error) {
        if (error instanceof ConsoleChargeError) return responderRecusa(res, error);
        throw error;
      }

      if (!resultado.nada) {
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.CHARGE_UPDATED,
          detail: {
            chargeId: resultado.cobranca.id,
            periodEnd: resultado.cobranca.period_end,
            before: resultado.antes,
            after: resultado.depois,
            atGateway: resultado.gateway
          }
        });
      }
      return res.json(createResponse(resultado.nada ? 'Nothing changed' : 'Charge updated', {
        charge: BillingCharge.presentForConsole(resultado.charge)
      }));
    } catch (error) {
      console.error('Update charge error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the charge', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/charges/:chargeId/reissue` — cobrar de
   * novo o período atual, pela porta de sempre.
   *
   * Só a cobrança `canceled` ou `failed` do período ATUAL (a chave do prazo
   * vivo, calculada como a emissão a calcula). Uma de período passado não tem
   * o que reemitir: o período dela acabou, e cobrá-lo de novo é uma cobrança
   * avulsa, não uma reemissão.
   *
   * Quem emite é `ChargeIssuingService.issueCurrent({ manual: true })` — o
   * mesmo caminho do "pagar agora" do provedor —, que já reabre a cancelada
   * do período com o preço de agora (guardando o id velho em
   * `superseded_charges`) e zera as tentativas da que falhou. Uma segunda
   * implementação aqui seria a que esquece a garra ou o preço da descida
   * agendada.
   */
  static async reissue(req, res) {
    try {
      const chargeId = parseId(req.params?.chargeId);
      if (!chargeId) return res.status(400).json(createErrorResponse('Invalid charge id'));
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;

      let resultado;
      try {
        resultado = await runInTenant(tenant.id, async () => {
          const cobranca = await BillingCharge.findById(chargeId);
          if (!cobranca) throw new ConsoleChargeError(404, 'Charge not found', 'not_found');
          if (cobranca.status !== 'canceled' && cobranca.status !== 'failed') {
            throw new ConsoleChargeError(409, `A ${cobranca.status} charge cannot be reissued`, 'not_reissuable', {
              status: cobranca.status
            });
          }
          const assinatura = await Subscription.forTenant(tenant.id);
          // O mesmo prazo que `issueCurrent` lê, na mesma ordem.
          const prazo = assinatura?.renews_at ?? assinatura?.trial_ends_at ?? null;
          const vencimento = prazo ? new Date(prazo) : null;
          if (!vencimento || Number.isNaN(vencimento.getTime())) {
            throw new ConsoleChargeError(409, 'The subscription has no current period', 'no_deadline');
          }
          if (String(cobranca.period_end).slice(0, 10) !== ChargeIssuingService.periodKey(vencimento)) {
            throw new ConsoleChargeError(
              409, 'Only a charge of the current period can be reissued', 'not_current_period'
            );
          }

          const emissao = await ChargeIssuingService.issueCurrent({ manual: true, tenant });
          if (emissao.reason === 'gateway_failed') {
            throw new ConsoleChargeError(502, `The payment gateway refused: ${emissao.error}`, 'gateway_failed', {
              detail: emissao.error
            });
          }
          // `already_issued` é sucesso: a cobrança do período está viva no
          // gateway, emitida por outra passada no meio — que é o que se pediu.
          if (!emissao.issued && emissao.reason !== 'already_issued') {
            throw new ConsoleChargeError(409, `The charge was not reissued: ${emissao.reason}`, emissao.reason);
          }
          return {
            cobranca,
            issued: emissao.issued,
            charge: emissao.charge ?? await BillingCharge.findById(cobranca.id)
          };
        });
      } catch (error) {
        if (error instanceof ConsoleChargeError) return responderRecusa(res, error);
        throw error;
      }

      if (resultado.issued) {
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.CHARGE_REISSUED,
          detail: {
            chargeId: resultado.cobranca.id,
            periodEnd: resultado.cobranca.period_end,
            statusBefore: resultado.cobranca.status,
            amountCents: Number(resultado.charge?.amount_cents ?? 0)
          }
        });
      }
      return res.json(createResponse('Charge reissued', {
        charge: BillingCharge.presentForConsole(resultado.charge)
      }));
    } catch (error) {
      console.error('Reissue charge error:', error);
      return res.status(500).json(createErrorResponse('Failed to reissue the charge', error.message));
    }
  }
}

export default PlatformSubscriptionsController;
