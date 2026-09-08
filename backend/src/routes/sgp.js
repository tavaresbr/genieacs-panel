import express from 'express';
import SgpController from '../controllers/sgpController.js';
import SgpEventController from '../controllers/sgpEventController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { sgpWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// Unauthenticated: the caller is SGP, and the shared secret is the credential.
// Declared before the device routes so the matcher never treats `events` as a
// device id.
router.post('/events/webhook', sgpWebhookLimiter, SgpEventController.receive);

router.get('/events', authenticateToken, requireRole(['admin']), SgpEventController.list);
router.get('/events/:id', authenticateToken, requireRole(['admin']), SgpEventController.get);
router.post('/events/:id/retry', authenticateToken, requireRole(['admin']), SgpEventController.retry);
router.post('/events/secret/rotate', authenticateToken, requireRole(['admin']), SgpEventController.rotateSecret);
router.post('/reconcile', authenticateToken, requireRole(['admin']), SgpEventController.reconcile);

router.get('/config', authenticateToken, requireRole(['admin']), SgpController.getConfig);
router.put('/config', authenticateToken, requireRole(['admin']), SgpController.updateConfig);
router.post('/test', authenticateToken, requireRole(['admin']), SgpController.testConnection);
router.get('/customers', authenticateToken, requireRole(['admin']), SgpController.lookup);
router.get('/devices/:deviceId', authenticateToken, requireRole(['admin']), SgpController.getDeviceIntegration);
router.post('/devices/:deviceId/link', authenticateToken, requireRole(['admin']), SgpController.linkDevice);
router.delete('/devices/:deviceId/link', authenticateToken, requireRole(['admin']), SgpController.unlinkDevice);
router.post('/devices/:deviceId/unlock', authenticateToken, requireRole(['admin']), SgpController.unlockDevice);

export default router;
