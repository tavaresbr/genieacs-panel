import WaAlertService from '../services/waAlertService.js';
import { WaError } from '../services/whatsappConfigService.js';
import { handleError } from './whatsappController.js';
import { createResponse } from '../utils/helpers.js';

/**
 * The admin surface for technical alerts.
 *
 * Thin on purpose: every rule, every threshold and every refusal lives in
 * `waAlertService`, because the scan loop runs the same code with no request
 * behind it and the two must never drift.
 */
class WhatsAppAlertsController {
  static async getSettings(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.alerts.rulesLoaded'),
        await WaAlertService.getPublicSettings()
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.alerts.rulesLoadFailed');
    }
  }

  static async updateSettings(req, res) {
    try {
      const body = req.body ?? {};
      const settings = await WaAlertService.saveSettings({
        enabled: body.enabled,
        intervalSeconds: body.intervalSeconds,
        recipients: body.recipients,
        rules: body.rules
      });
      return res.json(createResponse(req.t('whatsapp.alerts.rulesSaved'), settings));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.alerts.rulesSaveFailed');
    }
  }

  /**
   * Runs one pass now.
   *
   * `scan()` never throws — the loop depends on that — so the two outcomes an
   * admin needs to be able to tell apart are read back off the summary instead.
   * A pass that could not run because nothing carries the alerts purpose is a
   * 409 with the reason, not a cheerful `{fired: 0}`: the operator pressed the
   * button precisely to find out whether this works.
   */
  static async scan(req, res) {
    try {
      const summary = await WaAlertService.scan();
      if (summary.skipped === 'no_recipients') {
        throw new WaError('whatsapp.alerts.noRecipients', {
          code: 'no_recipients',
          status: 409
        });
      }
      if (summary.error) {
        throw new WaError('whatsapp.alerts.scanFailed', {
          code: 'scan_failed',
          status: 502,
          details: summary.error
        });
      }
      return res.json(createResponse(
        req.t('whatsapp.alerts.scanDone', { fired: summary.fired, cleared: summary.cleared }),
        {
          fired: summary.fired,
          cleared: summary.cleared,
          notified: summary.notified,
          skipped: summary.skipped
        }
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.alerts.scanFailed');
    }
  }
}

export default WhatsAppAlertsController;
