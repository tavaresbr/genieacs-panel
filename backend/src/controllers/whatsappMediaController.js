import WaMessage from '../models/WaMessage.js';
import { resolveStoredAttachment, streamAttachment } from '../services/waAttachmentService.js';
import { createErrorResponse } from '../utils/helpers.js';

/**
 * The operator's half of the attachment story: `GET /api/whatsapp/messages/:id/media`.
 *
 * Session-authenticated and provider-scoped like everything else under
 * `/api/whatsapp`, which is what makes it a different route from the signed one
 * the Evolution server uses. The two must not merge: this one answers to a
 * human with a session and no token, that one to a server with a token and no
 * session, and the only reason either is safe is that neither accepts the
 * other's credential.
 *
 * What the request may say about the file is: which message. Nothing else. The
 * path is read from the row, and `resolveStoredAttachment` confines it to
 * `DATA_DIR` before anything is opened.
 */
class WhatsAppMediaController {
  static async fetch(req, res) {
    const notFound = () => res.status(404).json(createErrorResponse(
      req.t('whatsapp.error.attachmentNotFound'),
      null,
      'attachment_not_found'
    ));

    const id = Number(req.params?.id);
    if (!Number.isInteger(id) || id <= 0) return notFound();

    try {
      // Scoped read: `WaMessage.getById` goes through `tdb`, so another
      // provider's message is not "forbidden" here — it does not exist, which
      // is both the safer answer and the true one.
      const message = await WaMessage.getById(id);
      if (!message) return notFound();

      const resolved = await resolveStoredAttachment(message);
      // A row with no attachment, a path that escapes DATA_DIR and a file that
      // was deleted off the disk all land here, on purpose: the operator can do
      // nothing different about any of them, and telling them apart would tell
      // a prober which paths exist.
      if (!resolved) return notFound();

      return streamAttachment(res, resolved);
    } catch (error) {
      console.error('whatsapp.error.attachmentNotFound:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }
}

export default WhatsAppMediaController;
