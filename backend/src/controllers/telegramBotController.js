import TelegramBotService from '../services/telegramBotService.js';
import Tenant from '../models/Tenant.js';
import AuditLog from '../models/AuditLog.js';
import { WaError } from '../services/whatsappConfigService.js';
import { handleError } from './whatsappController.js';
import { createResponse } from '../utils/helpers.js';
import { currentTenantId } from '../config/tenantContext.js';
import { panelUrlFor } from '../services/mail/index.js';
import { telegramWebhookUrl } from '../config/telegramWebhookPath.js';

/** O código do cliente do Telegram → a frase (as mesmas do teste dos alertas). */
const REFUSAL_KEYS = Object.freeze({
  telegram_not_configured: 'whatsapp.alerts.telegramNotConfigured',
  telegram_invalid_token: 'whatsapp.alerts.telegramInvalidToken',
  telegram_bot_not_in_chat: 'whatsapp.alerts.telegramBotNotInChat',
  telegram_chat_not_found: 'whatsapp.alerts.telegramChatNotFound',
  telegram_unreachable: 'whatsapp.alerts.telegramUnreachable'
});

/**
 * A administração do bot de comandos do Telegram: ligar/desligar o webhook,
 * gerar o código de vínculo e listar/revogar os Telegrams vinculados.
 *
 * Fina de propósito — as regras vivem em `telegramBotService`. Todas as rotas
 * exigem `whatsapp.config`, a mesma capacidade dos alertas: quem decide quem
 * recebe alerta decide quem comanda o bot.
 */
class TelegramBotController {
  static async status(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.alerts.telegramBotLoaded'), await TelegramBotService.getPublicStatus()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.alerts.telegramBotFailed');
    }
  }

  static async enable(req, res) {
    try {
      const tenant = await Tenant.findPublicById(currentTenantId());
      const origin = panelUrlFor(tenant);
      // O Telegram só entrega em HTTPS.
      if (!origin || !origin.startsWith('https://')) {
        throw new WaError('whatsapp.alerts.telegramBotNoPublicUrl', { code: 'telegram_no_public_url', status: 400 });
      }
      const resultado = await TelegramBotService.enable({ webhookUrl: telegramWebhookUrl(origin, currentTenantId()) });
      if (!resultado.ok) {
        throw new WaError(REFUSAL_KEYS[resultado.code] || 'whatsapp.alerts.telegramBotFailed', {
          code: resultado.code,
          status: resultado.code === 'telegram_not_configured' ? 400 : 502
        });
      }
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TELEGRAM_BOT_CHANGED,
        subjectType: 'telegram',
        subjectId: null,
        detail: { enabled: true }
      });
      return res.json(createResponse(req.t('whatsapp.alerts.telegramBotEnabled'), await TelegramBotService.getPublicStatus()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.alerts.telegramBotFailed');
    }
  }

  static async disable(req, res) {
    try {
      await TelegramBotService.disable();
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TELEGRAM_BOT_CHANGED,
        subjectType: 'telegram',
        subjectId: null,
        detail: { enabled: false }
      });
      return res.json(createResponse(req.t('whatsapp.alerts.telegramBotDisabled'), await TelegramBotService.getPublicStatus()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.alerts.telegramBotFailed');
    }
  }

  /** O código vale para o operador logado: é ele que o Telegram vai virar. */
  static async linkCode(req, res) {
    try {
      const created = await TelegramBotService.createLinkCode(req.user.userId);
      return res.json(createResponse(req.t('whatsapp.alerts.telegramBotLinkCode'), created));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.alerts.telegramBotFailed');
    }
  }

  static async unlink(req, res) {
    try {
      const telegramUserId = String(req.body?.telegramUserId ?? '').slice(0, 32);
      const removed = await TelegramBotService.revokeLink(telegramUserId);
      if (!removed) {
        throw new WaError('whatsapp.alerts.telegramBotLinkNotFound', { code: 'telegram_link_not_found', status: 404 });
      }
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TELEGRAM_UNLINKED,
        subjectType: 'telegram',
        subjectId: telegramUserId,
        detail: null
      });
      return res.json(createResponse(req.t('whatsapp.alerts.telegramBotUnlinked'), await TelegramBotService.getPublicStatus()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.alerts.telegramBotFailed');
    }
  }
}

export default TelegramBotController;
