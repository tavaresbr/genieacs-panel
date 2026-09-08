import express from 'express';
import SgpController from '../controllers/sgpController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { sgpAdminLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

router.get('/config', authenticateToken, requireRole(['admin']), SgpController.getConfig);
router.put('/config', authenticateToken, requireRole(['admin']), SgpController.updateConfig);
router.post('/test', authenticateToken, requireRole(['admin']), sgpAdminLimiter, SgpController.testConnection);
router.get('/customers', authenticateToken, requireRole(['admin']), sgpAdminLimiter, SgpController.lookup);
router.get('/devices/:deviceId', authenticateToken, requireRole(['admin']), sgpAdminLimiter, SgpController.getDeviceIntegration);
router.post('/devices/:deviceId/link', authenticateToken, requireRole(['admin']), sgpAdminLimiter, SgpController.linkDevice);
router.delete('/devices/:deviceId/link', authenticateToken, requireRole(['admin']), sgpAdminLimiter, SgpController.unlinkDevice);
router.post('/devices/:deviceId/unlock', authenticateToken, requireRole(['admin']), sgpAdminLimiter, SgpController.unlockDevice);

export default router;
