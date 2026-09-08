import WhatsAppConfigService, { WaError } from '../services/whatsappConfigService.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

export function handleError(req, res, error, fallbackKey) {
  if (error instanceof WaError) {
    // The code lets the UI tell "the integration is off" from "the server
    // refused" without dumping the Evolution response at the operator.
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

class WhatsAppController {
  static async getConfig(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.configLoaded'),
        await WhatsAppConfigService.getPublicConfig()
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  static async updateConfig(req, res) {
    try {
      const body = req.body ?? {};
      const config = await WhatsAppConfigService.saveConfig({
        enabled: body.enabled,
        allowedHosts: body.allowedHosts,
        webhookBaseUrl: body.webhookBaseUrl,
        rejectCallMessage: body.rejectCallMessage,
        rateLimitPerMin: body.rateLimitPerMin,
        managedUrl: body.managedUrl,
        // An absent key keeps the stored one; "" clears it.
        managedAdminKey: body.managedAdminKey === undefined ? undefined : body.managedAdminKey
      });
      return res.json(createResponse(req.t('whatsapp.configSaved'), config));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configSaveFailed');
    }
  }

  static async listAccounts(req, res) {
    try {
      const rows = await WhatsAppAccount.getAll();
      return res.json(createResponse(
        req.t('whatsapp.accountsLoaded', { count: rows.length }),
        rows.map((row) => WhatsAppConfigService.publicAccount(row))
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountsLoadFailed');
    }
  }
}

export default WhatsAppController;
