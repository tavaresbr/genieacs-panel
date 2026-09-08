import WaSendService from '../services/waSendService.js';
import WaConversationService from '../services/waConversationService.js';
import { WaError } from '../services/whatsappConfigService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof WaError) {
    // The code lets the UI tell "no number is connected" from "this thread has
    // nowhere to send" without dumping the Evolution response at the operator.
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

class WhatsAppMessageController {
  /**
   * Enqueues one outbound message and answers immediately.
   *
   * The response is deliberately not "sent": it is the queued row, delivery
   * status and all. Waiting on the Evolution server here would make the reply
   * box as slow as the slowest thing in the chain, and would leave the operator
   * with no message at all when it timed out — the worker despatches, and the
   * webhook moves the row to delivered and read.
   */
  static async listConversations(req, res) {
    try {
      const rows = await WaConversationService.list({
        limit: req.query?.limit,
        offset: req.query?.offset,
        search: req.query?.search,
        status: req.query?.status
      });
      return res.json(createResponse(req.t('whatsapp.conversationsLoaded', { count: rows.length }), rows));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.conversationsLoadFailed');
    }
  }

  static async listMessages(req, res) {
    try {
      const data = await WaConversationService.messages(req.params?.id, { limit: req.query?.limit });
      return res.json(createResponse(
        req.t('whatsapp.messagesLoaded', { count: data.messages.length }),
        data
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.messagesLoadFailed');
    }
  }

  /**
   * Closes a thread, or reopens it.
   *
   * The two literals are the whole vocabulary: an unrecognized value is a 400
   * rather than a silent close, because the difference between the two is what
   * an operator sees in their list tomorrow morning.
   */
  static async setStatus(req, res) {
    const status = req.body?.status;
    if (status !== 'open' && status !== 'closed') {
      return res.status(400).json(createErrorResponse(req.t('whatsapp.conversationStatusFailed')));
    }
    try {
      const conversation = await WaConversationService.setStatus(req.params?.id, status);
      return res.json(createResponse(
        req.t(status === 'closed' ? 'whatsapp.conversationClosed' : 'whatsapp.conversationReopened'),
        conversation
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.conversationStatusFailed');
    }
  }

  static async send(req, res) {
    try {
      const body = req.body ?? {};
      const message = await WaSendService.enqueue({
        conversationId: req.params.id,
        body: body.body,
        attachment: body.attachment,
        isNote: body.isNote === true,
        userId: req.user?.userId ?? null
      });
      return res.status(201).json(createResponse(
        req.t('whatsapp.messageQueued'),
        WaSendService.publicMessage(message)
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.messageSendFailed');
    }
  }
}

export default WhatsAppMessageController;
