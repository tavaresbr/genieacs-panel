import AddonService from '../services/addonService.js';
import AuditLog from '../models/AuditLog.js';
import PlatformAudit from '../models/PlatformAudit.js';
import Tenant from '../models/Tenant.js';
import { TranslatableError, translateError } from '../i18n/index.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * Os add-ons pagos na tela de Plano do provedor (0126): a vitrine, ativar e
 * cancelar na renovação. A regra é de `AddonService`; aqui ficam as duas
 * trilhas — a do provedor ("quem contratou isto?") e a da plataforma, que é
 * onde se reconstrói o que cada cliente paga (`selfService: true`).
 */

function recusa(req, res, error) {
  return res.status(error.status || 400).json(
    createErrorResponse(translateError(req.t, error), error.detail ?? null, error.code)
  );
}

/** O que vai às duas trilhas de uma mudança — sem preço de plano, com o da pró-rata. */
function trilha(resultado, acao) {
  return {
    action: acao,
    addon: resultado.addon?.code ?? null,
    selfService: true,
    ...(resultado.already ? { already: true } : {}),
    ...(resultado.scheduled !== undefined ? { scheduled: resultado.scheduled, effectiveAt: resultado.effectiveAt ?? null } : {}),
    ...(resultado.charge && resultado.charge !== 'none' ? { openCharge: resultado.charge } : {}),
    ...(resultado.proration ? {
      proration: {
        amountCents: resultado.proration.amountCents,
        issued: resultado.proration.issued,
        ...(resultado.proration.skipped ? { skipped: resultado.proration.skipped } : {}),
        ...(resultado.proration.reason ? { reason: resultado.proration.reason } : {}),
        ...(resultado.proration.charge?.id ? { chargeId: resultado.proration.charge.id } : {})
      }
    } : {})
  };
}

async function gravarTrilhas(req, detail) {
  await AuditLog.fromRequest(req, {
    action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
    subjectType: 'subscription',
    subjectId: req.tenantId,
    detail
  });
  const provedor = await Tenant.findById(req.tenantId);
  const registrada = await PlatformAudit.fromRequest(req, {
    action: PlatformAudit.ACTIONS.TENANT_ADDON_CHANGED, tenant: provedor, detail
  });
  if (!registrada) console.warn(`Provider ${req.tenantId} changed an add-on without a platform trail line`);
}

class AddonController {
  /** `GET /api/tenant/addons` — a vitrine e o que o provedor tem. */
  static async list(req, res) {
    try {
      return res.json(createResponse(req.t('addons.retrieved'), await AddonService.listForTenant()));
    } catch (error) {
      console.error('List add-ons error:', error);
      return res.status(500).json(createErrorResponse(req.t('addons.retrieveFailed'), error.message));
    }
  }

  /** `POST /api/tenant/addons/:code/activate` — ativa (ou reativa) o add-on. */
  static async activate(req, res) {
    try {
      const resultado = await AddonService.activate({ code: req.params?.code, actorUserId: req.user?.userId ?? null });
      if (!resultado.already) {
        await gravarTrilhas(req, trilha(resultado, resultado.reactivated ? 'reactivated' : 'activated'));
      }
      const chave = resultado.already ? 'addons.alreadyActive' : (resultado.reactivated ? 'addons.reactivated' : 'addons.activated');
      return res.json(createResponse(req.t(chave, { name: resultado.addon.name }), {
        ...(await AddonService.listForTenant()),
        result: {
          code: resultado.addon.code,
          activated: Boolean(resultado.activated),
          reactivated: Boolean(resultado.reactivated),
          already: Boolean(resultado.already),
          proration: resultado.proration ?? null
        }
      }));
    } catch (error) {
      if (error instanceof TranslatableError) return recusa(req, res, error);
      console.error('Activate add-on error:', error);
      return res.status(500).json(createErrorResponse(req.t('addons.changeFailed'), error.message));
    }
  }

  /** `POST /api/tenant/addons/:code/cancel` — cancela na renovação (ou na hora, sem período pago). */
  static async cancel(req, res) {
    try {
      const resultado = await AddonService.cancel({ code: req.params?.code, actorUserId: req.user?.userId ?? null });
      if (!resultado.already) await gravarTrilhas(req, trilha(resultado, 'canceled'));
      const chave = resultado.already || resultado.scheduled ? 'addons.cancelScheduled' : 'addons.canceled';
      return res.json(createResponse(req.t(chave, { name: resultado.addon.name }), {
        ...(await AddonService.listForTenant()),
        result: {
          code: resultado.addon.code,
          scheduled: Boolean(resultado.scheduled || resultado.already),
          effectiveAt: resultado.effectiveAt ?? null
        }
      }));
    } catch (error) {
      if (error instanceof TranslatableError) return recusa(req, res, error);
      console.error('Cancel add-on error:', error);
      return res.status(500).json(createErrorResponse(req.t('addons.changeFailed'), error.message));
    }
  }
}

export default AddonController;
