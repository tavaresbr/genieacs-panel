import WaSendService from '../services/waSendService.js';
import WaConversationService from '../services/waConversationService.js';
import WaMessage from '../models/WaMessage.js';
import { WaError } from '../services/whatsappConfigService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

/**
 * The widest window the bulk requeue will take, whatever the request asks for.
 *
 * `hours` arrives from the browser, and an unclamped one is a mistake in the
 * same family as an unbounded DELETE, only pointing the other way: a typo of
 * 720 would put a month of failures back on the wire at once. Twenty-four is
 * the ceiling because it is the window the panel already shows — `failed24h`
 * on the health strip is the number the operator is looking at when they reach
 * for this button, so the button can requeue what they can see and no more.
 *
 * Past a day the content itself is the argument: a dunning notice from last
 * week is not a message anyone wants delivered today, and the subscriber it
 * would reach may well have paid in the meantime.
 */
const MAX_REQUEUE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

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
      const data = await WaConversationService.messages(req.params?.id, {
        limit: req.query?.limit,
        before: req.query?.before
      });
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
      // With a machine `code`, like every other refusal here: a screen that
      // translates codes cannot translate a bare message, and this route was
      // the only one in the WhatsApp surface answering without one.
      return res.status(400).json(createErrorResponse(
        req.t('whatsapp.error.invalidConversationStatus'),
        null,
        'invalid_conversation_status'
      ));
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
        userId: req.user?.userId ?? null,
        // Said rather than left to the default: this route is the one place a
        // human is demonstrably behind the message, and the row should say so
        // in its own right and not only by having a `sentBy`.
        source: 'operator'
      });
      return res.status(201).json(createResponse(
        req.t('whatsapp.messageQueued'),
        WaSendService.publicMessage(message)
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.messageSendFailed');
    }
  }

  /**
   * `POST /messages/:id/requeue` — one failed row, back in the queue as itself.
   *
   * Every eligibility question is `WaMessage.requeue`'s to answer, and it
   * answers all of them with the same null: the row is another provider's, or
   * the id is not a row at all, or the row is not `failed`. Those are one
   * sentence to the operator and must stay one — telling them apart would tell
   * a prober which ids exist, and the person at the panel can do nothing
   * different about any of the three.
   *
   * A row that is not `failed` is a 409 rather than a shrug: two operators
   * looking at the same red bubble will both press, and the second one has to
   * be told the message is already on its way rather than watching a button do
   * nothing.
   */
  static async requeue(req, res) {
    const id = Number(req.params?.id);
    const refuse = () => res.status(409).json(createErrorResponse(
      req.t('whatsapp.messageNotRequeueable'),
      null,
      'message_not_requeueable'
    ));

    if (!Number.isInteger(id) || id <= 0) return refuse();

    try {
      const message = await WaMessage.requeue(id);
      if (!message) return refuse();
      return res.json(createResponse(
        req.t('whatsapp.messageRequeued'),
        WaSendService.publicMessage(message)
      ));
    } catch (error) {
      return handleError(req, res, error, 'common.internalError');
    }
  }

  /**
   * `POST /messages/requeue-failed` — every failure inside a window, at once.
   *
   * IN THE SCOPE OF THE PROVIDER WHO ASKED, and nobody else's. The model's
   * `tdb` puts the provider the resolver opened into the WHERE, which is the
   * whole reason this is safe: the deployment-wide version of this statement
   * would let an admin at one ISP put another ISP's queue back on the wire,
   * which is the exact bug wave 8 fixed on the media sweep button.
   *
   * The statement itself is `WaMessage.requeueFailedSince` rather than a query
   * written here, so the patch and the `failed`-only rule have one definition
   * shared with the single-row path. This controller decides only the window.
   *
   * One statement rather than a loop over `WaMessage.requeue`, because the case
   * this exists for is thousands of rows and thousands of round trips is not a
   * recovery. The patch below is deliberately the same one that method applies
   * — cleared error, cleared claim, attempts back to zero and `next_attempt_at`
   * NULL for "due now" — and the WHERE carries the same per-row rule it does,
   * so a `sent` row cannot be swept up here either.
   *
   * The window is measured on `created_at` and not on when the row failed: it
   * is the column the index `(delivery_status, created_at)` sorts by, so this
   * is a seek instead of a scan over every failure the panel ever had, and it
   * is the same column `failed24h` counts — the figure the operator read before
   * pressing.
   */
  static async requeueFailed(req, res) {
    const asked = Number(req.body?.hours);
    // An absent or unparsable `hours` is the ceiling and anything under an hour
    // is an hour — a clamp rather than a 400, because the screen sends one
    // fixed value and an operator recovering a campaign is owed the recovery
    // instead of a form error. Both ends of the clamp fail towards a window the
    // operator could have asked for.
    const hours = Number.isFinite(asked)
      ? Math.min(Math.max(Math.floor(asked), 1), MAX_REQUEUE_HOURS)
      : MAX_REQUEUE_HOURS;

    try {
      const requeued = await WaMessage.requeueFailedSince(
        new Date(Date.now() - hours * HOUR_MS)
      );

      // Zero is a real answer and comes back as one: nothing failed inside the
      // window is not the same as a button that did not work, and the count is
      // the only thing that separates them on screen.
      return res.json(createResponse(
        req.t('whatsapp.messagesRequeued', { count: requeued }),
        { requeued }
      ));
    } catch (error) {
      return handleError(req, res, error, 'common.internalError');
    }
  }
}

export default WhatsAppMessageController;
