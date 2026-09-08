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
router.post('/accounts', authenticateToken, requireRole(['admin']), WhatsAppController.createAccount);

// Declared before the `:id` routes so the matcher can never read
// `check-number` as an account id.
router.post('/accounts/check-number', authenticateToken, requireRole(['admin']), WhatsAppController.checkNumbers);

router.get('/accounts/:id/qr', authenticateToken, requireRole(['admin']), WhatsAppController.getQr);
router.get('/accounts/:id/status', authenticateToken, requireRole(['admin']), WhatsAppController.getStatus);
router.post('/accounts/:id/restart', authenticateToken, requireRole(['admin']), WhatsAppController.restartAccount);
router.post('/accounts/:id/disconnect', authenticateToken, requireRole(['admin']), WhatsAppController.disconnectAccount);
router.patch('/accounts/:id', authenticateToken, requireRole(['admin']), WhatsAppController.updateAccount);
router.delete('/accounts/:id', authenticateToken, requireRole(['admin']), WhatsAppController.deleteAccount);

export default router;
