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
      // Every reason a pass did nothing is a refusal, never a cheerful
      // `{fired: 0}`. "Nothing is wrong" and "nothing was checked" look
      // identical in that number, and the admin pressed the button precisely
      // to tell them apart. `no_alert_recipients` is not the campaign's
      // `no_recipients`: one means nobody is on duty to be woken, the other
      // that the filters left no subscriber to charge, and a screen that
      // translates the code cannot render both.
      const REFUSALS = {
        disabled: ['whatsapp.alerts.disabledSkip', 'alerts_disabled', 409],
        not_configured: ['whatsapp.error.notConfigured', 'not_configured', 409],
        no_alert_number: ['whatsapp.alerts.noAlertNumber', 'no_alert_number', 409],
        no_recipients: ['whatsapp.alerts.noRecipients', 'no_alert_recipients', 409],
        no_devices: ['whatsapp.alerts.noDevices', 'no_devices', 502]
      };
      const refusal = summary.skipped ? REFUSALS[summary.skipped] : null;
      if (refusal) {
        const [key, code, status] = refusal;
        throw new WaError(key, { code, status });
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
