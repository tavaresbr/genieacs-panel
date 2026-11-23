import TelegramCustomerBot from '../models/TelegramCustomerBot.js';
import TelegramConversation from '../models/TelegramConversation.js';
import TelegramMessage from '../models/TelegramMessage.js';
import Tenant from '../models/Tenant.js';
import AuditLog from '../models/AuditLog.js';
import TelegramCustomerBotService, { TelegramChatError, publicBot } from '../services/telegramCustomerBotService.js';
import TelegramSendService from '../services/telegramSendService.js';
import TelegramLinkService from '../services/telegramLinkService.js';
import TelegramLinkTokenService from '../services/telegramLinkTokenService.js';
import { MessengerError } from '../services/messengerPageService.js';
import { panelUrlFor } from '../services/mail/index.js';
import { telegramCustomerWebhookUrl } from '../config/telegramCustomerWebhookPath.js';
import { currentTenantId } from '../config/tenantContext.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

function fail(res, error, fallback) {
  // `resolveTarget` (a mesma do Messenger) lança `MessengerError`: o formato do erro é o mesmo.
  if (error instanceof TelegramChatError || error instanceof MessengerError) {
    return res.status(error.status).json({ ...createErrorResponse(error.message, error.code), code: error.code });
  }
  console.error(`telegram-chat ${fallback}:`, error.name || 'Error');
  return res.status(500).json(createErrorResponse(fallback));
}

/** Quanto da mensagem a lista leva: a prévia cabe numa linha, e o resto só sai ao abrir a conversa. */
const PREVIEW_LIMIT = 120;

export function publicPreview(message) {
  if (!message) return null;
  const flat = String(message.body ?? '').replace(/\s+/g, ' ').trim();
  return {
    direction: message.direction,
    text: flat ? (flat.length > PREVIEW_LIMIT ? `${flat.slice(0, PREVIEW_LIMIT - 1)}…` : flat) : null,
    deliveryStatus: message.delivery_status ?? null,
    at: message.created_at
  };
}

const publicConversation = (c, clientName = null, lastMessage = null) => ({
  id: c.id,
  chatId: c.chat_id,
  name: c.name,
  username: c.username,
  contract: c.contract,
  sgpContactId: c.sgp_contact_id ? Number(c.sgp_contact_id) : null,
  /** O cliente do SGP a que a conversa foi vinculada, se foi. */
  clientName,
  linked: Boolean(c.contract || c.sgp_contact_id),
  boundVia: c.bound_via ?? null,
  lastMessageAt: c.last_message_at,
  lastInboundAt: c.last_inbound_at,
  unreadCount: c.unread_count,
  closedAt: c.closed_at,
  /** O cliente bloqueou o bot: nada sai até ele escrever de novo. */
  blocked: Boolean(c.blocked_at),
  lastMessage: publicPreview(lastMessage)
});

const publicMessage = (m) => ({
  id: m.id,
  conversationId: m.conversation_id,
  direction: m.direction,
  body: m.body,
  source: m.source,
  deliveryStatus: m.delivery_status,
  deliveryError: m.delivery_error,
  createdAt: m.created_at
});

class TelegramChatController {
  static async status(req, res) {
    try {
      return res.json(createResponse('ok', publicBot(await TelegramCustomerBot.get())));
    } catch (error) {
      return fail(res, error, 'could not load the bot');
    }
  }

  /** Guarda o token do bot (o Telegram o confere). */
  static async saveBot(req, res) {
    try {
      const row = await TelegramCustomerBotService.connect(req.body?.token);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TELEGRAM_CHAT_BOT_CHANGED,
        subjectType: 'telegram',
        subjectId: null,
        detail: { change: 'token', botUsername: row.bot_username || null }
      });
      return res.status(201).json(createResponse('ok', publicBot(row)));
    } catch (error) {
      return fail(res, error, 'could not save the bot');
    }
  }

  static async enable(req, res) {
    try {
      const tenant = await Tenant.findPublicById(currentTenantId());
      const origin = panelUrlFor(tenant);
      // O Telegram só entrega em HTTPS.
      if (!origin || !origin.startsWith('https://')) {
        throw new TelegramChatError('no_public_url', 'the panel has no public HTTPS address', 400);
      }
      const row = await TelegramCustomerBotService.enable({
        webhookUrl: telegramCustomerWebhookUrl(origin, currentTenantId())
      });
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TELEGRAM_CHAT_BOT_CHANGED,
        subjectType: 'telegram', subjectId: null, detail: { change: 'enabled' }
      });
      return res.json(createResponse('ok', publicBot(row)));
    } catch (error) {
      return fail(res, error, 'could not turn the bot on');
    }
  }

  static async disable(req, res) {
    try {
      const row = await TelegramCustomerBotService.disable();
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TELEGRAM_CHAT_BOT_CHANGED,
        subjectType: 'telegram', subjectId: null, detail: { change: 'disabled' }
      });
      return res.json(createResponse('ok', publicBot(row)));
    } catch (error) {
      return fail(res, error, 'could not turn the bot off');
    }
  }

  static async disconnect(req, res) {
    try {
      const row = await TelegramCustomerBotService.disconnect();
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TELEGRAM_CHAT_BOT_CHANGED,
        subjectType: 'telegram', subjectId: null, detail: { change: 'removed' }
      });
      return res.json(createResponse('ok', publicBot(row)));
    } catch (error) {
      return fail(res, error, 'could not remove the bot');
    }
  }

  /**
   * Emite o link `t.me/<bot>?start=…` que vincula a conversa ao assinante quando
   * ele o abre. O atendente o manda ao cliente (WhatsApp, e-mail, fatura).
   */
  static async createLink(req, res) {
    try {
      const { url, expiresAt } = await TelegramLinkTokenService.create(req.body?.contract, {
        source: 'operator', userId: req.user?.userId ?? null
      });
      return res.status(201).json(createResponse('ok', { url, expiresAt }));
    } catch (error) {
      return fail(res, error, 'could not create link');
    }
  }

  static async listConversations(req, res) {
    try {
      const rows = await TelegramConversation.listRecent({
        limit: req.query?.limit, offset: req.query?.offset, status: req.query?.status
      });
      const names = await TelegramLinkService.clientNames(rows);
      const previews = await TelegramMessage.lastOfConversations(rows.map((c) => c.id));
      return res.json(createResponse('ok', rows.map((c) => publicConversation(c, names.get(c.id), previews.get(c.id)))));
    } catch (error) {
      return fail(res, error, 'could not load conversations');
    }
  }

  /** Ler uma conversa zera o não lido: quem a abre é quem a leu. */
  static async listMessages(req, res) {
    try {
      const id = Number(req.params.id);
      const conversation = await TelegramConversation.getById(id);
      if (!conversation) throw new TelegramChatError('conversation_not_found', 'conversation not found', 404);
      const rows = await TelegramMessage.listByConversation(id, {
        limit: req.query?.limit, beforeId: Number(req.query?.before) || null
      });
      if (conversation.unread_count) await TelegramConversation.update(id, { unread_count: 0 });
      return res.json(createResponse('ok', {
        conversation: publicConversation(
          { ...conversation, unread_count: 0 },
          (await TelegramLinkService.clientNames([conversation])).get(conversation.id)
        ),
        messages: rows.map(publicMessage)
      }));
    } catch (error) {
      return fail(res, error, 'could not load messages');
    }
  }

  static async send(req, res) {
    try {
      const message = await TelegramSendService.sendText(
        Number(req.params.id), req.body?.text, req.user?.userId ?? null
      );
      // 201 saiu; 502 o Telegram recusou (a mensagem ficou gravada com o motivo).
      const status = message.delivery_status === 'failed' ? 502 : 201;
      return res.status(status).json(createResponse('ok', publicMessage(message), status === 502 ? 'send_refused' : null));
    } catch (error) {
      return fail(res, error, 'could not send message');
    }
  }

  /** Vincular a conversa a um assinante: `{ contract }` (o contrato, ou `c:<id>`). */
  static async linkSubscriber(req, res) {
    try {
      const row = await TelegramLinkService.link(Number(req.params.id), req.body?.contract);
      return res.json(createResponse('ok', publicConversation(row, (await TelegramLinkService.clientNames([row])).get(row.id))));
    } catch (error) {
      return fail(res, error, 'could not link subscriber');
    }
  }

  static async unlinkSubscriber(req, res) {
    try {
      const row = await TelegramLinkService.unlink(Number(req.params.id));
      return res.json(createResponse('ok', publicConversation(row)));
    } catch (error) {
      return fail(res, error, 'could not unlink subscriber');
    }
  }

  /** Arquivar ou reabrir: `{ closed: true | false }`. */
  static async setClosed(req, res) {
    try {
      const id = Number(req.params.id);
      if (!(await TelegramConversation.getById(id))) {
        throw new TelegramChatError('conversation_not_found', 'conversation not found', 404);
      }
      if (typeof req.body?.closed !== 'boolean') throw new TelegramChatError('invalid_body', '`closed` must be true or false');
      const row = await TelegramConversation.update(id, { closed_at: req.body.closed ? new Date() : null });
      return res.json(createResponse('ok', publicConversation(row, (await TelegramLinkService.clientNames([row])).get(row.id))));
    } catch (error) {
      return fail(res, error, 'could not update conversation');
    }
  }
}

export default TelegramChatController;
