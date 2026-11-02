import AsaasProviderService, { AsaasProviderError } from '../services/asaasProviderService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof AsaasProviderError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

class AsaasProviderController {
  static async getConfig(req, res) {
    try {
      return res.json(createResponse(
        req.t('asaas.configLoaded'),
        await AsaasProviderService.getPublicConfig()
      ));
    } catch (error) {
      return handleError(req, res, error, 'asaas.configLoadFailed');
    }
  }

  static async updateConfig(req, res) {
    try {
      const body = req.body ?? {};
      const config = await AsaasProviderService.saveConfig({
        enabled: body.enabled,
        environment: body.environment,
        // Ausente mantém a chave guardada; "" apaga e desliga a integração.
        apiKey: body.apiKey
      });
      return res.json(createResponse(req.t('asaas.configSaved'), config));
    } catch (error) {
      return handleError(req, res, error, 'asaas.configSaveFailed');
    }
  }

  static async testConnection(req, res) {
    try {
      const body = req.body ?? {};
      const result = await AsaasProviderService.testConnection({
        apiKey: body.apiKey,
        environment: body.environment
      });
      const message = result.accountName
        ? req.t('asaas.connectionOkAccount', { account: result.accountName })
        : req.t('asaas.connectionOk');
      return res.json(createResponse(message, result));
    } catch (error) {
      return handleError(req, res, error, 'asaas.connectionTestFailed');
    }
  }
}

export default AsaasProviderController;
