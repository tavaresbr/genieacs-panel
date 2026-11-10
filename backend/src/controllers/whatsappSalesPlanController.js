import WaSalesPlanService from '../services/waSalesPlanService.js';
import AuditLog from '../models/AuditLog.js';
import { WaError } from '../services/whatsappConfigService.js';
import { SgpError } from '../services/sgpService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof WaError || error instanceof SgpError) {
    return res.status(error.status).json({ ...createErrorResponse(translateError(req.t, error), error.details || error.code), code: error.code });
  }
  console.error(`[wa] planos de venda: ${error?.code || error?.message}`);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey)));
}

const auditar = (req, op, plano) => AuditLog.fromRequest(req, {
  action: AuditLog.ACTIONS.WHATSAPP_SALES_PLAN_CHANGED,
  subjectType: 'sales_plan',
  subjectId: plano?.id != null ? String(plano.id) : null,
  detail: { op, name: plano?.name ?? null, priceCents: plano?.priceCents ?? null }
});

class WhatsAppSalesPlanController {
  static async list(req, res) {
    try {
      const planos = await WaSalesPlanService.list();
      return res.json(createResponse(req.t('whatsapp.salesPlans.loaded', { count: planos.length }), planos));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.salesPlans.saveFailed');
    }
  }

  static async create(req, res) {
    try {
      const plano = await WaSalesPlanService.create(req.body);
      await auditar(req, 'create', plano);
      return res.status(201).json(createResponse(req.t('whatsapp.salesPlans.created'), plano));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.salesPlans.saveFailed');
    }
  }

  static async update(req, res) {
    try {
      const plano = await WaSalesPlanService.update(Number(req.params.id), req.body);
      await auditar(req, 'update', plano);
      return res.json(createResponse(req.t('whatsapp.salesPlans.updated'), plano));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.salesPlans.saveFailed');
    }
  }

  static async remove(req, res) {
    try {
      await WaSalesPlanService.remove(Number(req.params.id));
      await auditar(req, 'delete', { id: req.params.id });
      return res.json(createResponse(req.t('whatsapp.salesPlans.deleted'), null));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.salesPlans.saveFailed');
    }
  }

  static async importFromSgp(req, res) {
    try {
      const resultado = await WaSalesPlanService.importFromSgp();
      await auditar(req, 'import', null);
      return res.json(createResponse(req.t('whatsapp.salesPlans.imported', { count: String(resultado.imported) }), resultado));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.salesPlans.importFailed');
    }
  }
}

export default WhatsAppSalesPlanController;
