import SgpEvent from '../models/SgpEvent.js';
import SgpEventService from '../services/sgpEventService.js';
import SgpService, { SgpError, WEBHOOK_PATH } from '../services/sgpService.js';
import { verifyWebhookSignature } from '../utils/webhookSignature.js';
import { translateError } from '../i18n/index.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof SgpError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

class SgpEventController {
  /**
   * Public endpoint SGP posts to. It is mounted before the global JSON parser
   * so the signature is computed over the exact bytes that were signed; the
   * body is only parsed once the signature checks out.
   */
  static async receive(req, res) {
    let config;
    try {
      config = await SgpService.getConfig();
    } catch {
      return res.status(503).json({ success: false, code: 'unavailable' });
    }

    // A disabled endpoint answers 404, so an unauthenticated prober cannot
    // learn whether this panel talks to SGP at all.
    if (!config.webhookEnabled || !config.webhookSecret) {
      return res.status(404).json({ success: false, code: 'webhook_disabled' });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const verdict = verifyWebhookSignature({
      rawBody,
      secret: config.webhookSecret,
      headers: req.headers,
      toleranceSeconds: config.webhookToleranceSeconds,
      requireTimestamp: config.webhookRequireTimestamp
    });
    if (!verdict.ok) {
      console.warn(`Rejected an SGP webhook delivery: ${verdict.reason}`);
      // The response never says which part failed.
      return res.status(401).json({ success: false, code: 'invalid_signature' });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      return res.status(400).json({ success: false, code: 'invalid_json' });
    }

    try {
      const { created, event } = await SgpEventService.ingestWebhook(rawBody, parsed, config);
      if (!created) {
        // A redelivery must not look like a failure, or SGP keeps retrying.
        return res.status(200).json({ success: true, duplicate: true, id: event?.id ?? null });
      }
      // Answer before touching SGP or GenieACS: a delivery that waits on our
      // round-trips times out on the sender and gets retried.
      res.status(202).json({ success: true, duplicate: false, id: event.id });
      void SgpEventService.processPending({ limit: 5 }).catch((error) => {
        console.warn(`Deferred SGP event processing failed: ${error.message}`);
      });
      return undefined;
    } catch (error) {
      console.error('Failed to store an SGP webhook delivery:', error);
      return res.status(500).json({ success: false, code: 'storage_failed' });
    }
  }

  static async list(req, res) {
    try {
      const events = await SgpEvent.list({
        status: req.query?.status ?? null,
        type: req.query?.type ?? null,
        contract: req.query?.contract ?? null,
        limit: req.query?.limit
      });
      return res.json(createResponse(req.t('sgp.events.loaded'), { events }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.events.loadFailed');
    }
  }

  static async get(req, res) {
    try {
      const event = await SgpEvent.getById(Number(req.params?.id));
      if (!event) return res.status(404).json(createErrorResponse(req.t('sgp.events.notFound')));
      return res.json(createResponse(req.t('sgp.events.loaded'), { event }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.events.loadFailed');
    }
  }

  static async retry(req, res) {
    try {
      const event = await SgpEventService.retry(Number(req.params?.id));
      if (!event) return res.status(404).json(createErrorResponse(req.t('sgp.events.notFound')));
      return res.json(createResponse(req.t('sgp.events.retried'), { event }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.events.retryFailed');
    }
  }

  static async rotateSecret(req, res) {
    try {
      const secret = await SgpService.rotateWebhookSecret();
      // Shown once, exactly like a regenerated portal password.
      return res.json(createResponse(req.t('sgp.events.secretRotated'), {
        secret,
        path: WEBHOOK_PATH
      }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.events.secretRotateFailed');
    }
  }

  static async reconcile(req, res) {
    try {
      const summary = await SgpEventService.reconcile({});
      return res.json(createResponse(req.t('sgp.events.reconciled'), summary));
    } catch (error) {
      return handleError(req, res, error, 'sgp.events.reconcileFailed');
    }
  }
}

export default SgpEventController;
