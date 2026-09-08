import express from 'express';
import WhatsAppAlertsController from '../controllers/whatsappAlertsController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Admin-only, like everything else under /api/whatsapp. These routes hold the
// on-call roster and can put a message on a technician's phone at 3 a.m.
router.get('/alerts/settings', authenticateToken, requireRole(['admin']), WhatsAppAlertsController.getSettings);
router.put('/alerts/settings', authenticateToken, requireRole(['admin']), WhatsAppAlertsController.updateSettings);
router.post('/alerts/scan', authenticateToken, requireRole(['admin']), WhatsAppAlertsController.scan);

export default router;
