import express from 'express';
import SgpController from '../controllers/sgpController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/config', authenticateToken, requireRole(['admin']), SgpController.getConfig);
router.put('/config', authenticateToken, requireRole(['admin']), SgpController.updateConfig);
router.post('/test', authenticateToken, requireRole(['admin']), SgpController.testConnection);
router.get('/customers', authenticateToken, requireRole(['admin']), SgpController.lookup);
router.get('/links', authenticateToken, requireRole(['admin']), SgpController.listLinks);
router.get('/overview', authenticateToken, requireRole(['admin']), SgpController.getOverview);
router.post('/sync', authenticateToken, requireRole(['admin']), SgpController.syncFleet);
router.get('/devices/:deviceId', authenticateToken, requireRole(['admin']), SgpController.getDeviceIntegration);
router.post('/devices/:deviceId/link', authenticateToken, requireRole(['admin']), SgpController.linkDevice);
router.delete('/devices/:deviceId/link', authenticateToken, requireRole(['admin']), SgpController.unlinkDevice);
router.post('/devices/:deviceId/unlock', authenticateToken, requireRole(['admin']), SgpController.unlockDevice);

export default router;
