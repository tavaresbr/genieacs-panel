import AuditLog from '../models/AuditLog.js';
import ContactProfileService, { ContactProfileError } from '../services/contactProfileService.js';
import ContactSheetService from '../services/contactSheetService.js';
import ContactInvoiceService from '../services/contactInvoiceService.js';
import ContactOnboardingService from '../services/contactOnboardingService.js';
import { WaError } from '../services/whatsappConfigService.js';
import { SgpError } from '../services/sgpService.js';
import { translateError } from '../i18n/index.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof ContactProfileError || error instanceof SgpError || error instanceof WaError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

/** Who edited, as the record keeps it: the operator's name, never a token. */
function actorOf(req) {
  return req.user?.username ?? (req.user?.userId ? `#${req.user.userId}` : null);
}

class ContactController {
  static async get(req, res) {
    try {
      const profile = await ContactProfileService.get(req.params.key);
      if (!profile) {
        return res.status(404).json({ ...createErrorResponse(req.t('contacts.error.notFound'), 'not_found'), code: 'not_found' });
      }
      return res.json(createResponse(req.t('contacts.loaded'), profile));
    } catch (error) {
      return handleError(req, res, error, 'contacts.loadFailed');
    }
  }

  static async invoices(req, res) {
    try {
      return res.json(createResponse(req.t('contacts.loaded'), await ContactProfileService.invoices(req.params.key)));
    } catch (error) {
      return handleError(req, res, error, 'contacts.loadFailed');
    }
  }

  /** The suggested WhatsApp text for one open invoice; nothing is sent. */
  static async invoiceMessage(req, res) {
    try {
      const data = await ContactInvoiceService.preview(req.params.key, req.params.invoiceId, req.t);
      return res.json(createResponse(req.t('contacts.loaded'), data));
    } catch (error) {
      return handleError(req, res, error, 'contacts.invoiceSendFailed');
    }
  }

  static async sendInvoice(req, res) {
    try {
      const result = await ContactInvoiceService.send(
        req.params.key,
        req.params.invoiceId,
        { text: req.body?.text },
        req.user?.userId ?? null
      );
      // Which invoice went to whom, never the text: it carries the PIX code.
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_INVOICE_SENT,
        subjectType: 'contact',
        subjectId: String(req.params.key).slice(0, 64),
        detail: { contract: result.contract, invoiceId: result.invoiceId, conversationId: result.conversationId }
      });
      return res.status(201).json(createResponse(req.t('contacts.invoiceSent'), result));
    } catch (error) {
      return handleError(req, res, error, 'contacts.invoiceSendFailed');
    }
  }

  static async update(req, res) {
    try {
      const { profile, changed } = await ContactProfileService.update(req.params.key, req.body, actorOf(req));
      if (changed.length > 0) {
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.CONTACT_UPDATED,
          subjectType: 'contact',
          subjectId: String(req.params.key).slice(0, 64),
          detail: { fields: changed }
        });
      }
      return res.json(createResponse(req.t('contacts.updated'), profile));
    } catch (error) {
      return handleError(req, res, error, 'contacts.saveFailed');
    }
  }

  static async create(req, res) {
    try {
      const profile = await ContactProfileService.create(req.body, actorOf(req));
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_CREATED,
        subjectType: 'contact',
        subjectId: profile.key,
        detail: { fields: Object.keys(profile.fields).filter((field) => profile.fields[field].edited) }
      });
      return res.status(201).json(createResponse(req.t('contacts.created'), profile));
    } catch (error) {
      return handleError(req, res, error, 'contacts.saveFailed');
    }
  }

  /**
   * `GET /api/contacts/lookup/document?document=` — before the form: is this
   * CPF/CNPJ already a client (in the SGP or typed here), and, for a company
   * nobody has, what the Receita says. Writes only what the SGP lookup files.
   */
  static async lookupDocument(req, res) {
    try {
      const result = await ContactOnboardingService.lookupDocument(req.query?.document);
      return res.json(createResponse(req.t('contacts.lookupDone'), result));
    } catch (error) {
      return handleError(req, res, error, 'contacts.lookupFailed');
    }
  }

  /** `GET /api/contacts/lookup/cep?cep=` — the address of a CEP, to fill the form. */
  static async lookupCep(req, res) {
    try {
      const result = await ContactOnboardingService.lookupCep(req.query?.cep);
      if (!result.found) {
        return res.status(404).json({ ...createErrorResponse(req.t('contacts.cepNotFound')), code: 'cep_not_found' });
      }
      return res.json(createResponse(req.t('contacts.lookupDone'), result.data));
    } catch (error) {
      if (error instanceof ContactProfileError) return handleError(req, res, error, 'contacts.lookupFailed');
      return res.status(502).json({ ...createErrorResponse(req.t('contacts.lookupFailed')), code: 'cep_lookup_failed' });
    }
  }

  /** `POST /api/contacts/sgp` — the client created in the SGP, then filed here. */
  static async createInSgp(req, res) {
    try {
      const { profile, clientId } = await ContactOnboardingService.createInSgp(req.body);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_CREATED,
        subjectType: 'contact',
        subjectId: profile.key,
        // Where it was created and the SGP's id — never the values typed.
        detail: { sgp: true, sgpClientId: clientId }
      });
      return res.status(201).json(createResponse(req.t('contacts.createdInSgp'), profile));
    } catch (error) {
      return handleError(req, res, error, 'contacts.saveFailed');
    }
  }
}

/** The day in the file name, so two exports of the same day sort together. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

ContactController.exportSheet = async function exportSheet(req, res) {
  try {
    const filters = { search: String(req.query.search ?? ''), state: String(req.query.state ?? '') };
    const { csv, count } = await ContactSheetService.exportCsv(filters);
    await AuditLog.fromRequest(req, {
      action: AuditLog.ACTIONS.CONTACTS_EXPORTED,
      subjectType: 'contacts',
      subjectId: null,
      detail: { count, search: filters.search ? true : false, state: filters.state || null }
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contatos-${today()}.csv"`);
    return res.send(csv);
  } catch (error) {
    return handleError(req, res, error, 'contacts.exportFailed');
  }
};

/**
 * `?mode=preview` reads the sheet and says what it would do; `?mode=apply`
 * does it. The body is the CSV itself, as `text/csv`: a 5 MB sheet does not
 * fit the JSON parser's limit, and does not need to.
 */
ContactController.importSheet = async function importSheet(req, res) {
  try {
    const text = typeof req.body === 'string' ? req.body : '';
    const translate = (plan) => ({
      ...plan,
      errors: plan.errors.map((error) => ({ line: error.line, message: req.t(error.key, error.vars ?? undefined) }))
    });
    if (req.query.mode !== 'apply') {
      const plan = await ContactSheetService.plan(text);
      return res.json(createResponse(req.t('contacts.import.previewed'), translate(ContactSheetService.summary(plan))));
    }
    const result = await ContactSheetService.apply(text, actorOf(req));
    await AuditLog.fromRequest(req, {
      action: AuditLog.ACTIONS.CONTACTS_IMPORTED,
      subjectType: 'contacts',
      subjectId: null,
      detail: { total: result.total, updated: result.updated, created: result.created, errors: result.errors.length }
    });
    return res.json(createResponse(
      req.t('contacts.import.applied', { updated: result.updated, created: result.created }),
      translate(result)
    ));
  } catch (error) {
    return handleError(req, res, error, 'contacts.importFailed');
  }
};

export default ContactController;
