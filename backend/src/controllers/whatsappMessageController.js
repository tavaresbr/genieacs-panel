import WaSendService from '../services/waSendService.js';
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
