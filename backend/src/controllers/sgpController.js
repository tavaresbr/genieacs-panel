import SgpService, { SgpError } from '../services/sgpService.js';
import SgpLink from '../models/SgpLink.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

function handleError(res, error, fallbackMessage) {
  if (error instanceof SgpError) {
    // The code lets the UI distinguish "integration is off" from a real
    // failure without leaking SGP internals to the browser.
    return res.status(error.status).json({
      ...createErrorResponse(error.message, error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackMessage}:`, error);
  return res.status(500).json(createErrorResponse(fallbackMessage, error.message));
}

function readDeviceId(req) {
  const deviceId = String(req.params?.deviceId ?? '').trim();
  return deviceId || null;
}

class SgpController {
  static async getConfig(req, res) {
    try {
      return res.json(createResponse(
        'Configuração do SGP carregada',
        await SgpService.getPublicConfig()
      ));
    } catch (error) {
      return handleError(res, error, 'Falha ao carregar a configuração do SGP');
    }
  }

  static async updateConfig(req, res) {
    try {
      const body = req.body ?? {};
      const config = await SgpService.saveConfig({
        enabled: body.enabled,
        baseUrl: body.baseUrl,
        app: body.app,
        // An absent token keeps the stored one; "" clears the integration.
        token: body.token === undefined ? undefined : body.token,
        linkMode: body.linkMode,
        portalBilling: body.portalBilling,
        portalUnlock: body.portalUnlock,
        invoiceLimit: body.invoiceLimit,
        endpoints: body.endpoints
      });
      return res.json(createResponse('Configuração do SGP salva', config));
    } catch (error) {
      return handleError(res, error, 'Falha ao salvar a configuração do SGP');
    }
  }

  static async testConnection(req, res) {
    try {
      const body = req.body ?? {};
      const result = await SgpService.testConnection({
        baseUrl: body.baseUrl,
        app: body.app,
        token: body.token,
        document: body.document,
        contract: body.contract,
        login: body.login
      });
      return res.json(createResponse(
        result.message || 'Conexão com o SGP estabelecida',
        result
      ));
    } catch (error) {
      return handleError(res, error, 'Falha ao testar a conexão com o SGP');
    }
  }

  static async lookup(req, res) {
    try {
      const { contracts, message } = await SgpService.lookupCustomer({
        document: req.query?.document,
        contract: req.query?.contract,
        login: req.query?.login
      });
      return res.json(createResponse(
        message || `${contracts.length} contrato(s) encontrado(s)`,
        { contracts }
      ));
    } catch (error) {
      return handleError(res, error, 'Falha ao consultar o cliente no SGP');
    }
  }

  static async getDeviceIntegration(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) {
        return res.status(400).json(createErrorResponse('Device ID é obrigatório'));
      }
      const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
      const { link } = await SgpService.resolveDeviceContract(deviceId, { refresh });
      const includeInvoices = req.query?.invoices !== '0';
      let invoices = [];
      let invoiceError = null;
      if (includeInvoices) {
        try {
          ({ invoices } = await SgpService.listInvoices({
            contract: link.contract,
            onlyOpen: req.query?.open !== '0'
          }));
        } catch (error) {
          invoiceError = error instanceof SgpError ? error.message : 'Falha ao consultar títulos';
        }
      }
      return res.json(createResponse('Dados do SGP carregados', {
        link: SgpService.publicLink(link),
        invoices,
        invoiceError
      }));
    } catch (error) {
      return handleError(res, error, 'Falha ao carregar os dados do SGP');
    }
  }

  static async linkDevice(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) {
        return res.status(400).json(createErrorResponse('Device ID é obrigatório'));
      }
      const link = await SgpService.linkDevice(deviceId, {
        contract: req.body?.contract,
        document: req.body?.document
      });
      return res.json(createResponse('Contrato do SGP vinculado ao ONT', {
        link: SgpService.publicLink(link)
      }));
    } catch (error) {
      return handleError(res, error, 'Falha ao vincular o contrato do SGP');
    }
  }

  static async unlinkDevice(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) {
        return res.status(400).json(createErrorResponse('Device ID é obrigatório'));
      }
      const removed = await SgpService.unlinkDevice(deviceId);
      if (!removed) {
        return res.status(404).json(createErrorResponse('Nenhum vínculo com o SGP para este ONT'));
      }
      return res.json(createResponse('Vínculo com o SGP removido'));
    } catch (error) {
      return handleError(res, error, 'Falha ao remover o vínculo com o SGP');
    }
  }

  static async unlockDevice(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) {
        return res.status(400).json(createErrorResponse('Device ID é obrigatório'));
      }
      const link = await SgpLink.getByDeviceId(deviceId);
      const contract = link?.contract
        || (await SgpService.resolveDeviceContract(deviceId)).link.contract;
      const result = await SgpService.requestTrustUnlock({ contract });
      return res.json(createResponse(result.message, { contract }));
    } catch (error) {
      return handleError(res, error, 'Falha ao solicitar a liberação em confiança');
    }
  }
}

export default SgpController;
