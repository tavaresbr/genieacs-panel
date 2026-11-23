import MessengerPage from '../models/MessengerPage.js';
import MessengerConversation from '../models/MessengerConversation.js';
import MessengerMessage from '../models/MessengerMessage.js';
import MessengerPageService, { MessengerError, publicPage, messengerConfigured } from '../services/messengerPageService.js';
import MessengerSendService, { windowOpen } from '../services/messengerSendService.js';
import MessengerLinkService from '../services/messengerLinkService.js';
import MessengerLinkTokenService from '../services/messengerLinkTokenService.js';
import MessengerLinkedNoticeService from '../services/messengerLinkedNoticeService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import MessengerFacebookLoginService, { facebookAppId, facebookLoginAvailable } from '../services/messengerFacebookLoginService.js';

function fail(res, error, fallback) {
  if (error instanceof MessengerError) {
    return res.status(error.status).json({ ...createErrorResponse(error.message, error.code), code: error.code });
  }
  console.error(`messenger ${fallback}:`, error);
  return res.status(500).json(createErrorResponse(fallback, error.message));
}

/** Quanto da mensagem a lista leva: a prévia cabe numa linha, e o resto só sai ao abrir a conversa. */
const PREVIEW_LIMIT = 120;

/** A prévia da última mensagem como a lista a recebe, ou `null` sem mensagens. */
export function publicPreview(message) {
  if (!message) return null;
  const flat = String(message.body ?? '').replace(/\s+/g, ' ').trim();
  return {
    direction: message.direction,
    text: flat ? (flat.length > PREVIEW_LIMIT ? `${flat.slice(0, PREVIEW_LIMIT - 1)}…` : flat) : null,
    attachmentType: message.attachment_type ?? null,
    deliveryStatus: message.delivery_status ?? null,
    at: message.created_at
  };
}

const publicConversation = (c, clientName = null, lastMessage = null) => ({
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
  windowOpen: windowOpen(c),
  /** A última mensagem, só na lista; nas demais respostas, `null`. */
  lastMessage: publicPreview(lastMessage)
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
  /** Tentativas feitas (a fila tenta até 7 vezes antes de desistir). */
  attempts: Number(m.attempts || 0),
  readAt: m.read_at,
  createdAt: m.created_at
});

class MessengerController {
  static async status(req, res) {
    return res.json(createResponse('ok', {
      configured: messengerConfigured(),
      facebookLogin: { available: facebookLoginAvailable(), appId: facebookAppId() },
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

  /** Passo 1 do login do Facebook: as Páginas que a pessoa administra (sem token). */
  static async facebookPages(req, res) {
    try {
      const pages = await MessengerFacebookLoginService.listPages(req.body?.userToken);
      return res.json(createResponse('ok', pages));
    } catch (error) {
      return fail(res, error, 'could not list facebook pages');
    }
  }

  /** Passo 2: conecta a Página escolhida. */
  static async facebookConnect(req, res) {
    try {
      const row = await MessengerFacebookLoginService.connect(req.body?.userToken, req.body?.pageId);
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

  /** A confirmação que a pessoa recebe ao abrir o link de vínculo: ligada? e com que texto. */
  static async getSettings(req, res) {
    try {
      return res.json(createResponse('ok', { linkedNotice: await MessengerLinkedNoticeService.read() }));
    } catch (error) {
      return fail(res, error, 'could not load settings');
    }
  }

  static async saveSettings(req, res) {
    try {
      const notice = req.body?.linkedNotice;
      if (!notice || typeof notice !== 'object') throw new MessengerError('invalid_body', '`linkedNotice` is required');
      const linkedNotice = await MessengerLinkedNoticeService.save({ enabled: notice.enabled, text: notice.text });
      return res.json(createResponse('ok', { linkedNotice }));
    } catch (error) {
      return fail(res, error, 'could not save settings');
    }
  }

  /** Assina de novo os campos do webhook da Página (depois de um campo novo). */
  static async resubscribePage(req, res) {
    try {
      const row = await MessengerPageService.resubscribe(Number(req.params.id));
      return res.json(createResponse('ok', publicPage(row)));
    } catch (error) {
      return fail(res, error, 'could not subscribe page');
    }
  }

  /**
   * Emite o link `m.me/<Página>?ref=…` que vincula a conversa ao assinante
   * quando ele o abre. O atendente o manda ao cliente (WhatsApp, e-mail, fatura).
   */
  static async createLink(req, res) {
    try {
      const { url, expiresAt } = await MessengerLinkTokenService.create(req.body?.contract, {
        source: 'operator', userId: req.user?.userId ?? null
      });
      return res.status(201).json(createResponse('ok', { url, expiresAt }));
    } catch (error) {
      return fail(res, error, 'could not create link');
    }
  }

  static async listConversations(req, res) {
    try {
      const rows = await MessengerConversation.listRecent({
        limit: req.query?.limit, offset: req.query?.offset, status: req.query?.status
      });
      const names = await MessengerLinkService.clientNames(rows);
      const previews = await MessengerMessage.lastOfConversations(rows.map((c) => c.id));
      return res.json(createResponse('ok', rows.map((c) => publicConversation(c, names.get(c.id), previews.get(c.id)))));
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
      // 201 saiu; 202 ficou na fila (a Meta ou a rede não aguentou agora, e a fila
      // tenta de novo); 502 a Meta recusou por motivo dela.
      const status = message.delivery_status === 'failed' ? 502 : message.delivery_status === 'sent' ? 201 : 202;
      // `send_refused` na recusa: o corpo de um erro HTTP não chega à tela, e o código é o
      // que a manda recarregar a conversa, onde a mensagem ficou gravada com o motivo.
      return res.status(status).json(createResponse('ok', publicMessage(message), status === 502 ? 'send_refused' : null));
    } catch (error) {
      return fail(res, error, 'could not send message');
    }
  }

  /** Reenvia à mão uma resposta que falhou. Mesmos status do envio: 201, 202 ou 502. */
  static async retry(req, res) {
    try {
      const message = await MessengerSendService.retry(Number(req.params.id));
      const status = message.delivery_status === 'failed' ? 502 : message.delivery_status === 'sent' ? 201 : 202;
      return res.status(status).json(createResponse('ok', publicMessage(message), status === 502 ? 'send_refused' : null));
    } catch (error) {
      return fail(res, error, 'could not retry message');
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
