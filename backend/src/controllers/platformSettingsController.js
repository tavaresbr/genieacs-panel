import PlatformAudit from '../models/PlatformAudit.js';
import { PlatformProfileError, readProfile, saveProfile } from '../services/platformProfileService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import PlatformAlertService, { ALERT_STATUSES, HISTORY_EVENTS } from '../services/platformAlertService.js';
import { ALERT_CHANNELS } from '../services/platformProfileService.js';
import { mailTransport } from '../services/mail/index.js';
import { isValidEmail } from '../utils/helpers.js';
import {
  PlatformBrandingError,
  removeBrandingImage,
  saveBrandingImage
} from '../services/platformBrandingService.js';

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * O começo de um dia `YYYY-MM-DD` em Brasília (UTC−3; sem horário de verão
 * desde 2019), ou `null` se o texto não é uma data que existe.
 */
function inicioDoDia(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!m) return null;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(ano, mes - 1, dia));
  if (utc.getUTCFullYear() !== ano || utc.getUTCMonth() !== mes - 1 || utc.getUTCDate() !== dia) return null;
  return new Date(`${texto}T00:00:00-03:00`);
}

/** O inteiro da query (`padrao` sem valor), ou `null` se não é um. */
function inteiro(valor, padrao) {
  if (valor === undefined || valor === '') return padrao;
  if (typeof valor !== 'string' || !/^\d{1,9}$/.test(valor.trim())) return null;
  return Number(valor.trim());
}

/**
 * Configurações do console: os dados da empresa que vende o SaaS, que a
 * página pública e os avisos da equipe usam. Ver `platformProfileService`.
 */
class PlatformSettingsController {
  static async getProfile(req, res) {
    try {
      return res.json(createResponse('Profile retrieved', await readProfile()));
    } catch (error) {
      console.error('Read platform profile error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the profile', error.message));
    }
  }

  static async updateProfile(req, res) {
    try {
      const changed = await saveProfile(req.body ?? {});
      if (changed.length) {
        await PlatformAudit.fromRequest(req, {
          action: PlatformAudit.ACTIONS.PLATFORM_PROFILE_CHANGED,
          detail: { fields: changed }
        });
      }
      return res.json(createResponse('Profile saved', { ...(await readProfile()), changed }));
    } catch (error) {
      if (error instanceof PlatformProfileError) {
        return res.status(error.status).json({ ...createErrorResponse(error.message), field: error.field });
      }
      console.error('Save platform profile error:', error);
      return res.status(500).json(createErrorResponse('Failed to save the profile', error.message));
    }
  }

  /** `PUT /api/platform/settings/branding/:kind` — o corpo é a imagem crua. */
  static saveBranding = (kind) => async (req, res) => {
    try {
      await saveBrandingImage(kind, req.body);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_BRANDING_CHANGED,
        detail: { kind, removed: false }
      });
      return res.json(createResponse('Branding saved', { kind }));
    } catch (error) {
      return PlatformSettingsController.brandingError(res, error, 'Save platform branding error:');
    }
  };

  /** `DELETE /api/platform/settings/branding/:kind` — volta ao padrão. */
  static removeBranding = (kind) => async (req, res) => {
    try {
      await removeBrandingImage(kind);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_BRANDING_CHANGED,
        detail: { kind, removed: true }
      });
      return res.json(createResponse('Branding removed', { kind }));
    } catch (error) {
      return PlatformSettingsController.brandingError(res, error, 'Remove platform branding error:');
    }
  };

  static brandingError(res, error, label) {
    if (error instanceof PlatformBrandingError) {
      return res.status(error.status).json({ ...createErrorResponse(error.message), code: error.code });
    }
    console.error(label, error);
    return res.status(500).json(createErrorResponse('Failed to save the branding', error.message));
  }

  /**
   * `POST /api/platform/alerts/test` — manda um alerta de teste AGORA, pelos
   * `channels` pedidos (os dois, sem pedido), fora do resumo diário. 200 com o
   * resultado por canal (`true` saiu, `false` falhou, `null` sem destino);
   * 409 `no_destination` quando nenhum canal pedido tem destino configurado;
   * 502 `send_failed` quando todos os canais com destino falharam.
   */
  static async testAlert(req, res) {
    try {
      const pedidos = req.body?.channels;
      if (pedidos !== undefined && (!Array.isArray(pedidos) || pedidos.some((c) => !ALERT_CHANNELS.includes(c)))) {
        return res.status(400).json({ ...createErrorResponse('Invalid channels'), code: 'invalid_channels' });
      }
      const resultado = await PlatformAlertService.sendTest({ channels: pedidos ?? null });
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_ALERT_TEST,
        detail: { status: resultado.status, channels: resultado.channels ?? {} }
      });
      if (resultado.reason === 'no_destination') {
        return res.status(409).json({
          ...createErrorResponse('No WhatsApp or email to send the alert to'), code: 'no_destination'
        });
      }
      if (resultado.status !== 'sent') {
        return res.status(502).json({
          ...createErrorResponse('The test alert could not be sent'), code: 'send_failed', channels: resultado.channels ?? {}
        });
      }
      return res.json(createResponse('Test alert sent', { channels: resultado.channels }));
    } catch (error) {
      console.error('Platform alert test error:', error);
      return res.status(500).json(createErrorResponse('Failed to send the test alert', error.message));
    }
  }

  /**
   * `GET /api/platform/alerts` — o histórico da fila de alertas, o mais novo
   * primeiro. Query: `status`, `event`, `from`/`to` (`YYYY-MM-DD`, dias de
   * Brasília, os dois inclusive), `page` (1+), `pageSize` (1..100, 25 sem
   * pedido). 200 `{ alerts, total, page, pageSize, counts }`; 400 com `code`
   * (`invalid_status`, `invalid_event`, `invalid_from`, `invalid_to`,
   * `invalid_range`, `invalid_page`, `invalid_page_size`).
   */
  static async listAlerts(req, res) {
    try {
      const q = req.query ?? {};
      const recusa = (code, message) => res.status(400).json({ ...createErrorResponse(message), code });
      const texto = (v) => (typeof v === 'string' ? v.trim() : v === undefined ? '' : null);

      const status = texto(q.status);
      if (status === null || (status && !ALERT_STATUSES.includes(status))) return recusa('invalid_status', 'Invalid status');
      const event = texto(q.event);
      if (event === null || (event && !HISTORY_EVENTS.includes(event))) return recusa('invalid_event', 'Invalid event');

      const fromTxt = texto(q.from);
      const from = fromTxt ? inicioDoDia(fromTxt) : null;
      if (fromTxt === null || (fromTxt && !from)) return recusa('invalid_from', 'Invalid start date');
      const toTxt = texto(q.to);
      const to = toTxt ? inicioDoDia(toTxt) : null;
      if (toTxt === null || (toTxt && !to)) return recusa('invalid_to', 'Invalid end date');
      if (from && to && from.getTime() > to.getTime()) return recusa('invalid_range', 'The start date is after the end date');

      const page = inteiro(q.page, 1);
      if (page === null || page < 1) return recusa('invalid_page', 'Invalid page');
      const pageSize = inteiro(q.pageSize, 25);
      if (pageSize === null || pageSize < 1 || pageSize > 100) return recusa('invalid_page_size', 'Invalid page size');

      const dados = await PlatformAlertService.history({
        status: status || null,
        event: event || null,
        from,
        // `to` inclusive: até o começo do dia seguinte.
        until: to ? new Date(to.getTime() + DIA_MS) : null,
        page,
        pageSize,
        locale: req.locale
      });
      return res.json(createResponse('Alerts retrieved', dados));
    } catch (error) {
      console.error('Platform alert history error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the alerts', error.message));
    }
  }

  /**
   * `POST /api/platform/alerts/:id/resend` — põe de novo na fila um alerta
   * `failed`/`skipped` (o `test` não). 200 `{ alert, requeued }`; 400
   * `invalid_id`; 404 `not_found`; 409 `not_resendable` com o `status` atual.
   */
  static async resendAlert(req, res) {
    try {
      const id = /^\d{1,15}$/.test(String(req.params.id ?? '')) ? Number(req.params.id) : 0;
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ ...createErrorResponse('Invalid alert id'), code: 'invalid_id' });
      }
      const r = await PlatformAlertService.resend(id, { locale: req.locale });
      if (r.error === 'not_found') {
        return res.status(404).json({ ...createErrorResponse('Alert not found'), code: 'not_found' });
      }
      if (r.error) {
        return res.status(409).json({
          ...createErrorResponse('This alert cannot be resent'), code: 'not_resendable', status: r.status
        });
      }
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_ALERT_RESENT,
        detail: { alertId: id, event: r.event, from: r.previousStatus, requeued: r.requeued }
      });
      return res.json(createResponse('Alert queued again', { alert: r.alert, requeued: r.requeued }));
    } catch (error) {
      console.error('Platform alert resend error:', error);
      return res.status(500).json(createErrorResponse('Failed to resend the alert', error.message));
    }
  }

  /**
   * `POST /api/platform/mail/test` — manda um e-mail de teste AGORA pelo SMTP do
   * deploy (`SMTP_URL`/`MAIL_FROM`) para `to`, ou para o e-mail de avisos de
   * Dados do SaaS quando não vem. 200 `{ sent: true }`; 400 `invalid_email`;
   * 409 `not_configured` sem SMTP no deploy; 502 `send_failed` com `reason`
   * (`auth`, `connection`, `timeout`, `tls`, `rejected`, `unknown`).
   */
  static async testMail(req, res) {
    try {
      let to = String(req.body?.to ?? '').trim();
      if (!to) {
        const { values } = await readProfile().catch(() => ({ values: {} }));
        to = String(values?.notifyEmail ?? '').trim();
      }
      if (!isValidEmail(to)) {
        return res.status(400).json({ ...createErrorResponse('Invalid e-mail address'), code: 'invalid_email' });
      }
      const resultado = await mailTransport().probe({
        to,
        subject: 'E-mail de teste',
        text: 'Este é um e-mail de teste do painel. Se você o recebeu, o servidor de e-mail está configurado corretamente.'
      });
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_MAIL_TEST,
        detail: resultado.ok ? { sent: true } : { sent: false, reason: resultado.reason }
      });
      if (resultado.reason === 'not_configured') {
        return res.status(409).json({
          ...createErrorResponse('No SMTP server is configured for this deployment'), code: 'not_configured'
        });
      }
      if (!resultado.ok) {
        return res.status(502).json({
          ...createErrorResponse('The test e-mail could not be sent'), code: 'send_failed', reason: resultado.reason
        });
      }
      return res.json(createResponse('Test e-mail sent', { sent: true }));
    } catch (error) {
      console.error('Platform mail test error:', error);
      return res.status(500).json(createErrorResponse('Failed to send the test e-mail', error.message));
    }
  }
}

export default PlatformSettingsController;
