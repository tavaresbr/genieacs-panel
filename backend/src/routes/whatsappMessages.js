import express from 'express';
import WhatsAppMessageController from '../controllers/whatsappMessageController.js';
import WhatsAppMediaController from '../controllers/whatsappMediaController.js';
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

// The bytes of one message's attachment, for the operator looking at the
// thread. Session-authenticated and provider-scoped like its neighbours — the
// Evolution server fetches the same file from `/api/whatsapp-media/:id`, which
// is a different route with a different credential precisely because it is a
// different audience.
router.get(
  '/messages/:id/media',
  authenticateToken,
  requireRole(['admin']),
  WhatsAppMediaController.fetch
);

export default router;
