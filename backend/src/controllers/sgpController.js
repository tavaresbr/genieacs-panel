import SgpService, { SgpError } from '../services/sgpService.js';
import SgpLink from '../models/SgpLink.js';
import AuditLog, { AUDIT_ACTIONS } from '../models/AuditLog.js';
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
        endpoints: body.endpoints,
        webhookEnabled: body.webhookEnabled,
        webhookRequireTimestamp: body.webhookRequireTimestamp,
        webhookToleranceSeconds: body.webhookToleranceSeconds,
        reconcileEnabled: body.reconcileEnabled,
        reconcileIntervalMinutes: body.reconcileIntervalMinutes,
        reconcileBatchSize: body.reconcileBatchSize,
        eventRetentionDays: body.eventRetentionDays,
        eventTypeMap: body.eventTypeMap,
        ticketEnabled: body.ticketEnabled,
        ticketOccurrenceType: body.ticketOccurrenceType
        // `webhookSecret` is deliberately not accepted here: it is only ever
        // set through the rotate action, which shows it once.
      });
      // The ERP credentials. The token reaches the system that holds every
      // subscriber's contract, name and document, so a change to it — or to the
      // address it is sent to — is worth a line even when the change was
      // routine.
      //
      // Booleans only, and that is the whole point of them: `tokenChanged` says
      // the credential moved without the log holding a second copy of it, and
      // `baseUrl` stays out because an address the token is sent to is the
      // other half of the credential. Best-effort by contract (see
      // AuditLog.record) — the settings row is already written.
      await AuditLog.recordFromRequest(req, {
        action: AUDIT_ACTIONS.SGP_CONFIG_CHANGED,
        targetType: 'integration',
        targetId: 'sgp',
        metadata: {
          enabled: Boolean(config.enabled),
          tokenChanged: body.token !== undefined,
          baseUrlChanged: body.baseUrl !== undefined
        }
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
        invoiceError,
        // Carried with the data it gates, so the device page does not need a
        // second request just to know whether to offer the button.
        ticketEnabled: (await SgpService.getConfig()).ticketEnabled === true
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

  /**
   * Opens a ticket in the ERP for the subscriber holding this ONT.
   *
   * The contract is resolved the same way the trust unlock resolves it — the
   * stored link first, a lookup only when there is none — so the operator names
   * the equipment and never the contract number.
   */
  static async openTicket(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) {
        return res.status(400).json(createErrorResponse(req.t('sgp.deviceIdRequired')));
      }
      const body = req.body ?? {};
      const link = await SgpLink.getByDeviceId(deviceId);
      const contract = link?.contract
        || (await SgpService.resolveDeviceContract(deviceId)).link.contract;
      const result = await SgpService.openTicket({
        contract,
        content: body.content,
        note: body.note,
        occurrenceType: body.occurrenceType
      });
      return res.json(createResponse(result.message || req.t('sgp.ticketOpened'), result));
    } catch (error) {
      return handleError(req, res, error, 'sgp.ticketFailed');
    }
  }
}

export default SgpController;
