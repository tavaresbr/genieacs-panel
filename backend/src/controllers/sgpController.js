import SgpService, { SgpError } from '../services/sgpService.js';
import SgpLink from '../models/SgpLink.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof SgpError) {
    // The code lets the UI distinguish "integration is off" from a real
    // failure without leaking SGP internals to the browser.
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

function readDeviceId(req) {
  const deviceId = String(req.params?.deviceId ?? '').trim();
  return deviceId || null;
}

class SgpController {
  static async getConfig(req, res) {
    try {
      return res.json(createResponse(
        req.t('sgp.configLoaded'),
        await SgpService.getPublicConfig()
      ));
    } catch (error) {
      return handleError(req, res, error, 'sgp.configLoadFailed');
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
      return res.json(createResponse(req.t('sgp.configSaved'), config));
    } catch (error) {
      return handleError(req, res, error, 'sgp.configSaveFailed');
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
      const message = result.messageKey
        ? req.t(result.messageKey, result.messageVars)
        : (result.message || req.t('sgp.connectionOk'));
      return res.json(createResponse(message, result));
    } catch (error) {
      return handleError(req, res, error, 'sgp.connectionTestFailed');
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
        message || req.t('sgp.contractsFound', { count: contracts.length }),
        { contracts }
      ));
    } catch (error) {
      return handleError(req, res, error, 'sgp.lookupFailed');
    }
  }

  static async listLinks(req, res) {
    try {
      const links = await SgpService.listLinks();
      return res.json(createResponse(
        req.t('sgp.linksLoaded', { count: links.length }),
        { links }
      ));
    } catch (error) {
      return handleError(req, res, error, 'sgp.linksLoadFailed');
    }
  }

  static async syncFleet(req, res) {
    try {
      const result = await SgpService.syncFleet();
      return res.json(createResponse(
        req.t('sgp.syncDone', { linked: result.linked, total: result.total }),
        result
      ));
    } catch (error) {
      return handleError(req, res, error, 'sgp.syncFailed');
    }
  }

  static async getOverview(req, res) {
    try {
      const overview = await SgpService.getFleetOverview();
      return res.json(createResponse(req.t('sgp.overviewLoaded'), overview));
    } catch (error) {
      return handleError(req, res, error, 'sgp.overviewFailed');
    }
  }

  static async getDeviceIntegration(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) {
        return res.status(400).json(createErrorResponse(req.t('sgp.deviceIdRequired')));
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
      return res.json(createResponse(req.t('sgp.dataLoaded'), {
        link: SgpService.publicLink(link),
        invoices,
        invoiceError
      }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.dataLoadFailed');
    }
  }

  static async linkDevice(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) {
        return res.status(400).json(createErrorResponse(req.t('sgp.deviceIdRequired')));
      }
      const link = await SgpService.linkDevice(deviceId, {
        contract: req.body?.contract,
        document: req.body?.document
      });
      return res.json(createResponse(req.t('sgp.contractLinked'), {
        link: SgpService.publicLink(link)
      }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.linkFailed');
    }
  }

  static async unlinkDevice(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) {
        return res.status(400).json(createErrorResponse(req.t('sgp.deviceIdRequired')));
      }
      const removed = await SgpService.unlinkDevice(deviceId);
      if (!removed) {
        return res.status(404).json(createErrorResponse(req.t('sgp.noLink')));
      }
      return res.json(createResponse(req.t('sgp.linkRemoved')));
    } catch (error) {
      return handleError(req, res, error, 'sgp.unlinkFailed');
    }
  }

  static async unlockDevice(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) {
        return res.status(400).json(createErrorResponse(req.t('sgp.deviceIdRequired')));
      }
      const link = await SgpLink.getByDeviceId(deviceId);
      const contract = link?.contract
        || (await SgpService.resolveDeviceContract(deviceId)).link.contract;
      const result = await SgpService.requestTrustUnlock({ contract });
      return res.json(createResponse(result.message, { contract }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.unlockFailed');
    }
  }
}

export default SgpController;
