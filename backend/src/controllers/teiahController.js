import TeiahService, { TeiahError } from '../services/teiahService.js';
import TeiahExportService from '../services/teiahExportService.js';
import ContactTeiahService from '../services/contactTeiahService.js';
import AuditLog from '../models/AuditLog.js';
import { SgpError } from '../services/sgpService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

const EXPORT_STATUSES = new Set(['sent', 'skipped', 'error']);

function handleError(req, res, error, fallbackKey) {
  // The export reads the SGP too, so its errors come in both kinds.
  if (error instanceof TeiahError || error instanceof SgpError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

class TeiahController {
  static async getConfig(req, res) {
    try {
      return res.json(createResponse(req.t('teiah.configLoaded'), await TeiahService.getPublicConfig()));
    } catch (error) {
      return handleError(req, res, error, 'teiah.configLoadFailed');
    }
  }

  static async updateConfig(req, res) {
    try {
      const body = req.body ?? {};
      const config = await TeiahService.saveConfig({
        enabled: body.enabled,
        baseUrl: body.baseUrl,
        // An absent key keeps the stored one; "" clears it.
        apiKey: body.apiKey === undefined ? undefined : body.apiKey,
        exportEnabled: body.exportEnabled,
        exportIntervalHours: body.exportIntervalHours,
        batchSize: body.batchSize,
        webUrl: body.webUrl,
        rentalDefault: body.rentalDefault
      });
      return res.json(createResponse(req.t('teiah.configSaved'), config));
    } catch (error) {
      return handleError(req, res, error, 'teiah.configSaveFailed');
    }
  }

  static async testConnection(req, res) {
    try {
      const body = req.body ?? {};
      const result = await TeiahService.testConnection({ baseUrl: body.baseUrl, apiKey: body.apiKey });
      return res.json(createResponse(req.t('teiah.connectionOk'), result));
    } catch (error) {
      return handleError(req, res, error, 'teiah.connectionTestFailed');
    }
  }

  /** `GET /api/teiah/consultations/summary?from=&to=` — what the TeiaH consultations cost, from its history. */
  static async consultationSummary(req, res) {
    try {
      const summary = await TeiahService.consultationSummary({ from: req.query.from, to: req.query.to });
      return res.json(createResponse(req.t('teiah.configLoaded'), summary));
    } catch (error) {
      return handleError(req, res, error, 'teiah.summaryFailed');
    }
  }

  /** `GET /api/teiah/guards` — the admin's spend guards and this month's usage. */
  static async getGuards(req, res) {
    try {
      const [guards, usage] = await Promise.all([TeiahService.getGuards(), TeiahService.monthUsage()]);
      return res.json(createResponse(req.t('teiah.configLoaded'), { guards, usage }));
    } catch (error) {
      return handleError(req, res, error, 'teiah.configLoadFailed');
    }
  }

  /** `PUT /api/teiah/guards` — confirmed with the admin's own password (middleware). */
  static async updateGuards(req, res) {
    try {
      const body = req.body ?? {};
      const guards = await TeiahService.saveGuards({
        monthlyLimit: body.monthlyLimit,
        priceCpf: body.priceCpf,
        priceAddress: body.priceAddress,
        alertWorsening: body.alertWorsening,
        phoneScan: body.phoneScan
      });
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TEIAH_GUARDS_CHANGED,
        subjectType: 'teiah',
        detail: {
          monthlyLimit: guards.monthlyLimit,
          priceCpf: guards.priceCpf,
          priceAddress: guards.priceAddress,
          alertWorsening: guards.alertWorsening,
          phoneScan: guards.phoneScan
        }
      });
      return res.json(createResponse(req.t('teiah.configSaved'), { guards, usage: await TeiahService.monthUsage() }));
    } catch (error) {
      return handleError(req, res, error, 'teiah.configSaveFailed');
    }
  }

  /** `GET /api/teiah/worsened` — the clients whose risk went up lately. */
  static async worsened(req, res) {
    try {
      return res.json(createResponse(req.t('teiah.configLoaded'), { items: await ContactTeiahService.worsened() }));
    } catch (error) {
      return handleError(req, res, error, 'teiah.configLoadFailed');
    }
  }

  /** `GET /api/teiah/reconsult/preview` — how many stale clients, and the estimated cost. */
  static async reconsultPreview(req, res) {
    try {
      return res.json(createResponse(req.t('teiah.configLoaded'), await ContactTeiahService.reconsultPreview()));
    } catch (error) {
      return handleError(req, res, error, 'teiah.configLoadFailed');
    }
  }

  /** `POST /api/teiah/reconsult/run` — confirmed with the admin's own password (middleware). */
  static async reconsultRun(req, res) {
    try {
      const result = await ContactTeiahService.reconsultStale({ max: req.body?.max });
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TEIAH_RECONSULT_RUN,
        subjectType: 'teiah',
        detail: {
          processed: result.processed,
          failed: result.failed,
          worsened: result.worsened.length,
          stoppedByLimit: result.stoppedByLimit
        }
      });
      return res.json(createResponse(req.t('teiah.reconsultDone'), result));
    } catch (error) {
      return handleError(req, res, error, 'teiah.reconsultFailed');
    }
  }

  /** `POST /api/teiah/consultations/export` — the spend report as CSV, confirmed with the password. */
  static async exportSpend(req, res) {
    try {
      const body = req.body ?? {};
      const { csv, count, from, to } = await TeiahService.spendCsv({ from: body.from, to: body.to });
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TEIAH_SPEND_EXPORTED,
        subjectType: 'teiah',
        detail: { count, from, to }
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="teiah-gastos-${from}-a-${to}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(csv);
    } catch (error) {
      return handleError(req, res, error, 'teiah.summaryFailed');
    }
  }

  static async getExportStatus(req, res) {
    try {
      const status = await TeiahExportService.getStatus();
      const lastError = status.lastError
        ? { at: status.lastError.at, code: status.lastError.code, message: translateError(req.t, status.lastError) }
        : null;
      return res.json(createResponse(req.t('teiah.exportLoaded'), { ...status, lastError }));
    } catch (error) {
      return handleError(req, res, error, 'teiah.exportFailed');
    }
  }

  static async listExportItems(req, res) {
    try {
      const status = EXPORT_STATUSES.has(String(req.query?.status)) ? String(req.query.status) : null;
      const items = await TeiahExportService.listItems({ status, limit: req.query?.limit });
      return res.json(createResponse(req.t('teiah.exportLoaded'), { items }));
    } catch (error) {
      return handleError(req, res, error, 'teiah.exportFailed');
    }
  }

  static async previewExport(req, res) {
    try {
      return res.json(createResponse(req.t('teiah.exportPreviewed'), await TeiahExportService.preview({})));
    } catch (error) {
      return handleError(req, res, error, 'teiah.exportFailed');
    }
  }

  static async runExport(req, res) {
    try {
      await TeiahExportService.start();
      return res.status(202).json(createResponse(req.t('teiah.exportStarted'), { running: true }));
    } catch (error) {
      return handleError(req, res, error, 'teiah.exportFailed');
    }
  }
}

export default TeiahController;
