import MessengerPage from '../models/MessengerPage.js';
import MessengerConversation from '../models/MessengerConversation.js';
import MessengerMessage from '../models/MessengerMessage.js';
import MessengerPageService, { MessengerError, publicPage, messengerConfigured } from '../services/messengerPageService.js';
import MessengerSendService, { windowOpen } from '../services/messengerSendService.js';
import MessengerLinkService from '../services/messengerLinkService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

function fail(res, error, fallback) {
  if (error instanceof MessengerError) {
    return res.status(error.status).json({ ...createErrorResponse(error.message, error.code), code: error.code });
  }
  console.error(`messenger ${fallback}:`, error);
  return res.status(500).json(createErrorResponse(fallback, error.message));
}

const publicConversation = (c, clientName = null) => ({
  id: c.id,
  pageRowId: c.page_row_id,
  psid: c.psid,
  name: c.name,
  contract: c.contract,
  sgpContactId: c.sgp_contact_id ? Number(c.sgp_contact_id) : null,
  /** O cliente do SGP a que a conversa foi vinculada, se foi. */
  clientName,
  linked: Boolean(c.contract || c.sgp_contact_id),
  lastMessageAt: c.last_message_at,
  lastInboundAt: c.last_inbound_at,
  unreadCount: c.unread_count,
  closedAt: c.closed_at,
  windowOpen: windowOpen(c)
});

const publicMessage = (m) => ({
  id: m.id,
  conversationId: m.conversation_id,
  direction: m.direction,
  body: m.body,
  attachmentType: m.attachment_type,
  attachmentUrl: m.attachment_url,
  source: m.source,
  deliveryStatus: m.delivery_status,
  deliveryError: m.delivery_error,
  readAt: m.read_at,
  createdAt: m.created_at
});

class MessengerController {
  static async status(req, res) {
    return res.json(createResponse('ok', {
      configured: messengerConfigured(),
      webhookPath: MessengerPageService.webhookPath()
    }));
  }

  static async listPages(req, res) {
    try {
      const rows = await MessengerPage.getAll();
      return res.json(createResponse('ok', rows.map(publicPage)));
    } catch (error) {
      return fail(res, error, 'could not load pages');
    }
  }

  static async connectPage(req, res) {
    try {
      const row = await MessengerPageService.connect({
        pageId: req.body?.pageId,
        pageToken: req.body?.pageToken
      });
      return res.status(201).json(createResponse('ok', publicPage(row)));
    } catch (error) {
      return fail(res, error, 'could not connect page');
    }
  }

  static async disconnectPage(req, res) {
    try {
      await MessengerPageService.disconnect(Number(req.params.id));
      return res.json(createResponse('ok'));
    } catch (error) {
      return fail(res, error, 'could not disconnect page');
    }
  }

  static async listConversations(req, res) {
    try {
      const rows = await MessengerConversation.listRecent({
        limit: req.query?.limit, offset: req.query?.offset, status: req.query?.status
      });
      const names = await MessengerLinkService.clientNames(rows);
      return res.json(createResponse('ok', rows.map((c) => publicConversation(c, names.get(c.id)))));
    } catch (error) {
      return fail(res, error, 'could not load conversations');
    }
  }

  /** Ler uma conversa zera o não lido: quem a abre é quem a leu. */
  static async listMessages(req, res) {
    try {
      const id = Number(req.params.id);
      const conversation = await MessengerConversation.getById(id);
      if (!conversation) throw new MessengerError('conversation_not_found', 'conversation not found', 404);
      const rows = await MessengerMessage.listByConversation(id, {
        limit: req.query?.limit, beforeId: Number(req.query?.before) || null
      });
      if (conversation.unread_count) await MessengerConversation.update(id, { unread_count: 0 });
      return res.json(createResponse('ok', {
        conversation: publicConversation(
          { ...conversation, unread_count: 0 },
          (await MessengerLinkService.clientNames([conversation])).get(conversation.id)
        ),
        messages: rows.map(publicMessage)
      }));
    } catch (error) {
      return fail(res, error, 'could not load messages');
    }
  }

  static async send(req, res) {
    try {
      const message = await MessengerSendService.sendText(
        Number(req.params.id), req.body?.text, req.user?.userId ?? null
      );
      return res.status(message.delivery_status === 'failed' ? 502 : 201)
        .json(createResponse('ok', publicMessage(message)));
    } catch (error) {
      return fail(res, error, 'could not send message');
    }
  }

  /** Vincular a conversa a um assinante: `{ contract }` (o contrato, ou `c:<id>`). */
  static async linkSubscriber(req, res) {
    try {
      const row = await MessengerLinkService.link(Number(req.params.id), req.body?.contract);
      return res.json(createResponse('ok', publicConversation(row, (await MessengerLinkService.clientNames([row])).get(row.id))));
    } catch (error) {
      return fail(res, error, 'could not link subscriber');
    }
  }

  static async unlinkSubscriber(req, res) {
    try {
      const row = await MessengerLinkService.unlink(Number(req.params.id));
      return res.json(createResponse('ok', publicConversation(row)));
    } catch (error) {
      return fail(res, error, 'could not unlink subscriber');
    }
  }

  /** Arquivar ou reabrir: `{ closed: true | false }`. */
  static async setClosed(req, res) {
    try {
      const id = Number(req.params.id);
      if (!(await MessengerConversation.getById(id))) {
        throw new MessengerError('conversation_not_found', 'conversation not found', 404);
      }
      if (typeof req.body?.closed !== 'boolean') throw new MessengerError('invalid_body', '`closed` must be true or false');
      const row = await MessengerConversation.update(id, { closed_at: req.body.closed ? new Date() : null });
      return res.json(createResponse('ok', publicConversation(row, (await MessengerLinkService.clientNames([row])).get(row.id))));
    } catch (error) {
      return fail(res, error, 'could not update conversation');
    }
  }
}

export default MessengerController;
