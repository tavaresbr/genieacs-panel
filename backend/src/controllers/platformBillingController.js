import Plan, { PLAN_LIMIT_COLUMNS } from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import BillingEvent from '../models/BillingEvent.js';
import Tenant from '../models/Tenant.js';
import PlatformAudit from '../models/PlatformAudit.js';
import AuditLog from '../models/AuditLog.js';
import SubscriptionService, { STATUSES } from '../services/subscriptionService.js';
import { manualBilling } from '../services/billing/manualBillingProvider.js';
import DeviceService from '../services/deviceService.js';
import { runInTenant } from '../config/tenantContext.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * A metade comercial do plano de controle: planos, a assinatura de cada
 * provedor, o pagamento que nós registramos e o uso contra o limite.
 *
 * Tudo que muda a assinatura de um provedor é feito NO ESCOPO DELE
 * (`runInTenant`), pelo mesmo motivo de `PlatformController.setStatus`: o
 * extrato e a linha da trilha têm que nascer no provedor a quem pertencem, ou
 * ele não os vê no próprio painel. E cada mudança grava duas vezes — na trilha
 * da plataforma (o que NÓS fizemos) e na do provedor (o que aconteceu COM ele,
 * com `actorKind: 'platform'`).
 */

const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Um limite: inteiro ≥ 0, ou null para "sem limite". Qualquer outra coisa é erro. */
function parseLimit(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

function presentPlan(plan) {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    limits: SubscriptionService.limitsOf(plan),
    priceCents: Number(plan.price_cents ?? 0),
    currency: plan.currency,
    trialDays: Number(plan.trial_days ?? 0),
    active: Boolean(plan.active),
    createdAt: plan.created_at ?? null
  };
}

async function tenantOr404(req, res) {
  const id = parseId(req.params?.id);
  if (!id) {
    res.status(400).json(createErrorResponse('Invalid provider id'));
    return null;
  }
  const tenant = await Tenant.findById(id);
  if (!tenant) {
    res.status(404).json(createErrorResponse('Provider not found'));
    return null;
  }
  return tenant;
}

/** As duas trilhas, de uma vez. */
async function recordBoth(req, tenant, { platformAction, detail }) {
  await PlatformAudit.fromRequest(req, { action: platformAction, tenant, detail });
  await runInTenant(tenant.id, () => AuditLog.fromRequest(req, {
    action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
    actorKind: 'platform',
    subjectType: 'subscription',
    subjectId: tenant.id,
    detail: { ...detail, platformAction }
  }));
}

class PlatformBillingController {
  // ── Planos ───────────────────────────────────────────────────────────

  static async listPlans(req, res) {
    try {
      const plans = await Plan.list();
      const counts = await Promise.all(plans.map((plan) => Plan.subscriberCount(plan.id)));
      return res.json(createResponse('Plans retrieved', {
        plans: plans.map((plan, i) => ({ ...presentPlan(plan), subscribers: counts[i] }))
      }));
    } catch (error) {
      console.error('List plans error:', error);
      return res.status(500).json(createErrorResponse('Failed to list plans', error.message));
    }
  }

  static async createPlan(req, res) {
    try {
      const body = req.body ?? {};
      const code = String(body.code ?? '');
      const name = String(body.name ?? '').trim();
      if (!CODE_PATTERN.test(code)) {
        return res.status(400).json(createErrorResponse(
          'Plan code must be 2 to 32 lowercase letters, digits, hyphens or underscores'
        ));
      }
      if (name.length < 1 || name.length > 128) {
        return res.status(400).json(createErrorResponse('Name must be between 1 and 128 characters'));
      }
      const row = { code, name };
      for (const [key, column] of [
        ['maxOperators', 'max_operators'],
        ['maxSubscribers', 'max_subscribers'],
        ['maxDevices', 'max_devices']
      ]) {
        const parsed = parseLimit(body[key]);
        if (!parsed.ok) {
          return res.status(400).json(createErrorResponse(`${key} must be a non-negative integer or null`));
        }
        row[column] = parsed.value;
      }
      const price = parseLimit(body.priceCents);
      const trial = parseLimit(body.trialDays);
      if (!price.ok || !trial.ok) {
        return res.status(400).json(createErrorResponse('priceCents and trialDays must be non-negative integers'));
      }
      row.price_cents = price.value ?? 0;
      row.trial_days = trial.value ?? 0;
      row.currency = String(body.currency ?? 'BRL').toUpperCase().slice(0, 3);
      row.active = body.active === undefined ? true : Boolean(body.active);

      if (await Plan.findByCode(code)) {
        return res.status(409).json(createErrorResponse('Plan code already taken'));
      }
      const plan = await Plan.create(row);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLAN_CREATED,
        detail: presentPlan(plan)
      });
      return res.status(201).json(createResponse('Plan created', { plan: presentPlan(plan) }));
    } catch (error) {
      console.error('Create plan error:', error);
      return res.status(500).json(createErrorResponse('Failed to create the plan', error.message));
    }
  }

  /**
   * Muda nome, limites, preço, teste ou `active`. O `code` NÃO muda: é o que
   * os testes, o extrato e o seed nomeiam; renomear seria reescrever o passado.
   */
  static async updatePlan(req, res) {
    try {
      const id = parseId(req.params?.id);
      if (!id) return res.status(400).json(createErrorResponse('Invalid plan id'));
      const plan = await Plan.findById(id);
      if (!plan) return res.status(404).json(createErrorResponse('Plan not found'));

      const body = req.body ?? {};
      const patch = {};
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (name.length < 1 || name.length > 128) {
          return res.status(400).json(createErrorResponse('Name must be between 1 and 128 characters'));
        }
        patch.name = name;
      }
      for (const [key, column] of [
        ['maxOperators', 'max_operators'],
        ['maxSubscribers', 'max_subscribers'],
        ['maxDevices', 'max_devices'],
        ['priceCents', 'price_cents'],
        ['trialDays', 'trial_days']
      ]) {
        if (body[key] === undefined) continue;
        const parsed = parseLimit(body[key]);
        if (!parsed.ok) {
          return res.status(400).json(createErrorResponse(`${key} must be a non-negative integer or null`));
        }
        patch[column] = (column === 'price_cents' || column === 'trial_days') ? (parsed.value ?? 0) : parsed.value;
      }
      if (body.currency !== undefined) patch.currency = String(body.currency).toUpperCase().slice(0, 3);
      if (body.active !== undefined) patch.active = Boolean(body.active);
      if (Object.keys(patch).length === 0) {
        return res.status(400).json(createErrorResponse('Nothing to update'));
      }

      const updated = await Plan.update(id, patch);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLAN_UPDATED,
        detail: { id, before: presentPlan(plan), after: presentPlan(updated) }
      });
      return res.json(createResponse('Plan updated', { plan: presentPlan(updated) }));
    } catch (error) {
      console.error('Update plan error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the plan', error.message));
    }
  }

  // ── A assinatura de um provedor ─────────────────────────────────────

  static async getSubscription(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const state = await runInTenant(tenant.id, () => SubscriptionService.current());
      const events = await runInTenant(tenant.id, () => BillingEvent.listRecent({ limit: 50 }));
      return res.json(createResponse('Subscription retrieved', {
        tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
        subscription: SubscriptionService.present(state),
        planId: state.subscription?.plan_id ?? null,
        events: events.map((event) => ({
          id: event.id,
          type: event.type,
          amountCents: event.amount_cents,
          currency: event.currency,
          provider: event.provider,
          externalId: event.external_id,
          detail: event.detail ? JSON.parse(event.detail) : null,
          at: event.created_at
        }))
      }));
    } catch (error) {
      console.error('Get subscription error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the subscription', error.message));
    }
  }

  /**
   * `PUT /tenants/:id/subscription` com `planId` e/ou `status` (mais
   * `trialEndsAt`/`renewsAt` quando o status pede). Um pedido pode trazer os
   * dois; cada um vira a sua linha no extrato.
   */
  static async updateSubscription(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const body = req.body ?? {};
      const planId = body.planId === undefined ? undefined : parseId(body.planId);
      const status = body.status;
      if (body.planId !== undefined && !planId) {
        return res.status(400).json(createErrorResponse('Invalid plan id'));
      }
      if (planId && !(await Plan.findById(planId))) {
        return res.status(404).json(createErrorResponse('Plan not found'));
      }
      if (status !== undefined && !STATUSES.includes(status)) {
        return res.status(400).json(createErrorResponse(`Status must be one of: ${STATUSES.join(', ')}`));
      }
      if (planId === undefined && status === undefined) {
        return res.status(400).json(createErrorResponse('Nothing to update'));
      }
      for (const key of ['trialEndsAt', 'renewsAt']) {
        if (body[key] !== undefined && body[key] !== null && Number.isNaN(new Date(body[key]).getTime())) {
          return res.status(400).json(createErrorResponse(`${key} must be a date`));
        }
      }

      const before = await Subscription.forTenant(tenant.id);
      const actorUserId = req.user?.userId ?? null;
      await runInTenant(tenant.id, async () => {
        if (planId !== undefined) {
          await SubscriptionService.changePlan({ planId, actorUserId });
        }
        if (status !== undefined) {
          await SubscriptionService.setStatus({
            status,
            reason: body.reason ? String(body.reason).slice(0, 255) : null,
            actorUserId,
            trialEndsAt: body.trialEndsAt,
            renewsAt: body.renewsAt
          });
        }
      });
      const after = await Subscription.forTenant(tenant.id);

      if (planId !== undefined) {
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_PLAN_CHANGED,
          detail: { from: before?.plan_id ?? null, to: planId }
        });
      }
      if (status !== undefined) {
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_STATUS_CHANGED,
          detail: { from: before?.status ?? null, to: status, reason: body.reason ?? null }
        });
      }

      const state = await runInTenant(tenant.id, () => SubscriptionService.current());
      return res.json(createResponse('Subscription updated', {
        subscription: SubscriptionService.present(state),
        planId: after?.plan_id ?? null
      }));
    } catch (error) {
      console.error('Update subscription error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the subscription', error.message));
    }
  }

  /** Nós marcamos pago. */
  static async recordPayment(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const body = req.body ?? {};
      const amount = Number(body.amountCents);
      if (!Number.isInteger(amount) || amount < 0) {
        return res.status(400).json(createErrorResponse('amountCents must be a non-negative integer'));
      }
      const currency = String(body.currency ?? 'BRL').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        return res.status(400).json(createErrorResponse('currency must be a three-letter code'));
      }
      const externalId = body.reference ? String(body.reference).slice(0, 128) : null;
      const before = await Subscription.forTenant(tenant.id);
      if (!before) return res.status(404).json(createErrorResponse('Subscription not found'));

      const { subscription: after, duplicate } = await runInTenant(tenant.id, () => manualBilling.recordPayment({
        amountCents: amount,
        currency,
        externalId,
        actorUserId: req.user?.userId ?? null
      }));
      // Uma referência já vista não é um segundo pagamento: nada foi
      // creditado, e uma segunda linha na trilha diria que foi.
      if (duplicate) {
        const state = await runInTenant(tenant.id, () => SubscriptionService.current());
        return res.status(200).json(createResponse('Payment already recorded', {
          subscription: SubscriptionService.present(state),
          duplicate: true
        }));
      }
      await recordBoth(req, tenant, {
        platformAction: PlatformAudit.ACTIONS.PAYMENT_RECORDED,
        detail: {
          amountCents: amount,
          currency,
          reference: externalId,
          statusBefore: before.status,
          statusAfter: after.status,
          renewsAt: after.renews_at ?? null
        }
      });
      const state = await runInTenant(tenant.id, () => SubscriptionService.current());
      return res.status(201).json(createResponse('Payment recorded', {
        subscription: SubscriptionService.present(state)
      }));
    } catch (error) {
      console.error('Record payment error:', error);
      return res.status(500).json(createErrorResponse('Failed to record the payment', error.message));
    }
  }

  /** Uso contra o limite, com a contagem de ONTs vinda do GenieACS do provedor. */
  static async getUsage(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      const usage = await runInTenant(tenant.id, () => SubscriptionService.usage({
        countDevices: () => DeviceService.countDevicesFromGenieAcs()
      }));
      return res.json(createResponse('Usage retrieved', {
        tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
        ...usage
      }));
    } catch (error) {
      console.error('Get usage error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the usage', error.message));
    }
  }
}

export { PLAN_LIMIT_COLUMNS };
export default PlatformBillingController;
