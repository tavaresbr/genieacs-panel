import WaBillingService from '../services/waBillingService.js';
import WaBroadcastService from '../services/waBroadcastService.js';
import WaTemplateService from '../services/waTemplateService.js';
import WaOptOut from '../models/WaOptOut.js';
import { WaError } from '../services/whatsappConfigService.js';
import { SgpError } from '../services/sgpService.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

/**
 * Both error classes are handled here because this surface straddles both
 * integrations: a campaign build fails on the SGP as readily as on WhatsApp,
 * and "the ERP is switched off" has to arrive at the screen as itself rather
 * than as an anonymous 500.
 */
function handleError(req, res, error, fallbackKey) {
  if (error instanceof WaError || error instanceof SgpError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code,
      // A build that ends with nobody to contact still owes the operator the
      // reason: "every one of them is on the do-not-disturb list" is the answer
      // they need, and it would be lost inside a bare 409.
      ...(error.skipped ? { skipped: error.skipped } : {})
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

/** The opt-out shape the browser may see, built field by field. */
function publicOptOut(row) {
  if (!row) return null;
  return {
    id: row.id,
    waPhoneE164: row.wa_phone_e164 || null,
    waLid: row.wa_lid || null,
    origin: row.origin,
    reasonText: row.reason_text || null,
    createdAt: row.created_at || null
  };
}

class WhatsAppBillingController {
  // ── Templates ────────────────────────────────────────────────────────

  static async listTemplates(req, res) {
    try {
      const templates = await WaTemplateService.list({
        category: req.query?.category,
        includeInactive: ['1', 'true'].includes(String(req.query?.includeInactive ?? ''))
      });
      return res.json(createResponse(
        req.t('whatsapp.templates.loaded', { count: templates.length }),
        templates
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.loadFailed');
    }
  }

  static async createTemplate(req, res) {
    try {
      const body = req.body ?? {};
      const template = await WaTemplateService.create({
        name: body.name,
        body: body.body,
        category: body.category
      });
      return res.status(201).json(createResponse(req.t('whatsapp.templates.created'), template));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.saveFailed');
    }
  }

  static async updateTemplate(req, res) {
    try {
      const body = req.body ?? {};
      const template = await WaTemplateService.update(req.params.id, {
        name: body.name,
        body: body.body,
        category: body.category,
        active: body.active
      });
      return res.json(createResponse(req.t('whatsapp.templates.updated'), template));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.saveFailed');
    }
  }

  static async deleteTemplate(req, res) {
    try {
      await WaTemplateService.remove(req.params.id);
      return res.json(createResponse(req.t('whatsapp.templates.deleted')));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.deleteFailed');
    }
  }

  // ── Do not disturb ───────────────────────────────────────────────────

  static async listOptOuts(req, res) {
    try {
      const rows = await WaOptOut.listActive();
      return res.json(createResponse(
        req.t('whatsapp.optOut.loaded', { count: rows.length }),
        rows.map(publicOptOut)
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.optOut.loadFailed');
    }
  }

  static async createOptOut(req, res) {
    try {
      const body = req.body ?? {};
      // Normalised on the way in, because that is the form a campaign asks
      // about: an entry saved as "(93) 98111-0449" would match nothing, and the
      // failure would be a message sent to someone who asked for silence.
      const phone = normalizarTelefoneBr(body.phone);
      if (!phone) {
        throw new WaError('whatsapp.error.invalidPhone', { code: 'invalid_phone', status: 400 });
      }
      const created = await WaOptOut.record({
        waPhone: phone,
        origin: 'operator',
        reasonText: body.reasonText
      });
      // A null means an active opt-out already covers this number. Answering
      // with it rather than with an error keeps the button idempotent — the
      // outcome the operator asked for is the outcome they have.
      const row = created
        || (await WaOptOut.listActive({ limit: 1000 })).find((entry) => entry.wa_phone_e164 === phone)
        || null;
      return res.status(created ? 201 : 200).json(createResponse(
        req.t('whatsapp.optOut.created'),
        publicOptOut(row)
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.optOut.failed');
    }
  }

  static async revokeOptOut(req, res) {
    try {
      const id = Number(req.params.id);
      const row = Number.isInteger(id) ? await WaOptOut.revoke(id, req.user?.userId ?? null) : null;
      if (!row) {
        return res.status(404).json(createErrorResponse(req.t('common.routeNotFound')));
      }
      return res.json(createResponse(req.t('whatsapp.optOut.revoked'), publicOptOut(row)));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.optOut.failed');
    }
  }

  // ── Billing cadence ──────────────────────────────────────────────────

  static async listOverdue(req, res) {
    try {
      const subscribers = await WaBillingService.listOverdue({
        daysMin: req.query?.daysMin,
        daysMax: req.query?.daysMax,
        search: req.query?.search,
        limit: req.query?.limit
      });
      return res.json(createResponse(
        req.t('whatsapp.billing.overdueLoaded', { count: subscribers.length }),
        subscribers
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.billing.overdueLoadFailed');
    }
  }

  /**
   * Builds the campaign. It does NOT send it.
   *
   * The response is a `draft` and a breakdown of who was left out, so the
   * operator can read the list before anyone's phone rings. Starting it is a
   * separate, deliberate request.
   */
  static async buildCampaign(req, res) {
    try {
      const body = req.body ?? {};
      const { broadcast, recipients, skipped } = await WaBillingService.buildCampaign({
        template: body.template,
        contracts: body.contracts,
        title: body.title,
        userId: req.user?.userId ?? null
      });
      return res.status(201).json(createResponse(
        req.t('whatsapp.billing.campaignBuilt', { count: recipients }),
        { broadcast: WaBroadcastService.publicBroadcast(broadcast), recipients, skipped }
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.billing.campaignFailed');
    }
  }

  // ── The subscriber's number ──────────────────────────────────────────

  /**
   * Sets or clears the operator's correction to a subscriber's number.
   *
   * An empty `phone` is not a missing field to reject: it is the operator
   * withdrawing a correction, which hands the contract back to the ERP record.
   * Only a non-empty entry that could not be dialled is refused.
   */
  static async setSubscriberPhone(req, res) {
    try {
      const subscriber = await WaBillingService.setSubscriberPhone(
        req.params.contract,
        req.body?.phone
      );
      return res.json(createResponse(req.t('whatsapp.phoneSaved'), subscriber));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.phoneSaveFailed');
    }
  }

  // ── Campaigns ────────────────────────────────────────────────────────

  static async listBroadcasts(req, res) {
    try {
      const broadcasts = await WaBroadcastService.list();
      return res.json(createResponse(
        req.t('whatsapp.broadcast.loaded', { count: broadcasts.length }),
        broadcasts
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.broadcast.loadFailed');
    }
  }

  static async setBroadcastStatus(req, res) {
    try {
      const broadcast = await WaBroadcastService.setStatus(req.params.id, req.body?.status);
      return res.json(createResponse(req.t('whatsapp.broadcast.statusChanged'), broadcast));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.broadcast.statusFailed');
    }
  }
}

export default WhatsAppBillingController;
