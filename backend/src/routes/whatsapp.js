import express from 'express';
import WhatsAppController from '../controllers/whatsappController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Everything here is admin-only. The panel has no granular permissions, and
// every route below either exposes who the provider talks to or changes how it
// reaches them.
router.get('/config', authenticateToken, requireRole(['admin']), WhatsAppController.getConfig);
router.put('/config', authenticateToken, requireRole(['admin']), WhatsAppController.updateConfig);
router.get('/accounts', authenticateToken, requireRole(['admin']), WhatsAppController.listAccounts);

export default router;
