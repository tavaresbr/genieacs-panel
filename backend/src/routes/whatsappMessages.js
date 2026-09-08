import express from 'express';
import WhatsAppMessageController from '../controllers/whatsappMessageController.js';
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

router.post(
  '/conversations/:id/messages',
  authenticateToken,
  requireRole(['admin']),
  WhatsAppMessageController.send
);

export default router;
