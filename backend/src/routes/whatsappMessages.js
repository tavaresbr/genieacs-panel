import express from 'express';
import WhatsAppMessageController from '../controllers/whatsappMessageController.js';
import WhatsAppAttachmentController from '../controllers/whatsappAttachmentController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Admin-only, like everything else under /api/whatsapp: sending from the
// provider's number is speaking as the provider.
router.get(
  '/conversations',
  authenticateToken,
  requireRole(['admin']),
  WhatsAppMessageController.listConversations
);

// Reading a thread clears its unread count, which is why this is a GET that
// writes: the operator looking at it is the only thing "read" can mean.
router.get(
  '/conversations/:id/messages',
  authenticateToken,
  requireRole(['admin']),
  WhatsAppMessageController.listMessages
);

// Filing, not deleting: the thread and its history stay, and an inbound
// message takes it back out of the archive on its own.
router.post(
  '/conversations/:id/status',
  authenticateToken,
  requireRole(['admin']),
  WhatsAppMessageController.setStatus
);

router.post(
  '/conversations/:id/messages',
  authenticateToken,
  requireRole(['admin']),
  WhatsAppMessageController.send
);

// The operator's file, one step ahead of the message that carries it. The body
// is the raw file and the parser for it is mounted in `app.js`, on this exact
// path and BEFORE the global JSON one — see `waAttachmentService`. Here the
// request is already past `apiLimiter` and the provider resolver, and the
// answer is the `{ path, type, name }` the send route takes back as
// `attachment`. No table is touched, so nothing here needs scoping of its own:
// the row that will point at this file is written by the send route, into
// `wa_messages`, which is scoped.
router.post(
  '/attachments',
  authenticateToken,
  requireRole(['admin']),
  WhatsAppAttachmentController.upload
);

export default router;
