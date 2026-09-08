import WhatsAppConfigService, { WaError } from '../services/whatsappConfigService.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

export function handleError(res, error, fallbackMessage) {
  if (error instanceof WaError) {
    // The code lets the UI tell "the integration is off" from "the server
    // refused" without dumping the Evolution response at the operator.
    return res.status(error.status).json({
      ...createErrorResponse(error.message, error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackMessage}:`, error);
  return res.status(500).json(createErrorResponse(fallbackMessage, error.message));
}

class WhatsAppController {
  static async getConfig(req, res) {
    try {
      return res.json(createResponse(
        'Configuração do WhatsApp carregada',
        await WhatsAppConfigService.getPublicConfig()
      ));
    } catch (error) {
      return handleError(res, error, 'Falha ao carregar a configuração do WhatsApp');
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
      return res.json(createResponse('Configuração do WhatsApp salva', config));
    } catch (error) {
      return handleError(res, error, 'Falha ao salvar a configuração do WhatsApp');
    }
  }

  static async listAccounts(req, res) {
    try {
      const rows = await WhatsAppAccount.getAll();
      return res.json(createResponse(
        'Números do WhatsApp carregados',
        rows.map((row) => WhatsAppConfigService.publicAccount(row))
      ));
    } catch (error) {
      return handleError(res, error, 'Falha ao listar os números do WhatsApp');
    }
  }
}

export default WhatsAppController;
