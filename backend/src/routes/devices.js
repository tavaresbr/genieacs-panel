import express from 'express';
import DeviceController from '../controllers/deviceController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { portalPasswordAdminLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

router.get('/', authenticateToken, DeviceController.getDevices);
router.get('/dashboard', authenticateToken, DeviceController.getDashboard);
router.get('/faults', authenticateToken, DeviceController.getFaults);
router.delete('/faults/:faultId', authenticateToken, requireRole(['admin']), DeviceController.deleteFault);
// Above the bare `/:deviceId` route, like the other device sub-paths.
router.get('/:deviceId/history', authenticateToken, DeviceController.getHistory);
router.get('/:deviceId/portal-password', authenticateToken, requireRole(['admin']), portalPasswordAdminLimiter, DeviceController.getPortalPassword);
router.post('/:deviceId/portal-password/reset', authenticateToken, requireRole(['admin']), portalPasswordAdminLimiter, DeviceController.resetPortalPassword);
router.get('/:deviceId', authenticateToken, requireRole(['admin']), DeviceController.getDeviceDetail);
router.delete('/:deviceId', authenticateToken, requireRole(['admin']), DeviceController.deleteDevice);
router.post('/reboot', authenticateToken, requireRole(['admin']), DeviceController.rebootDevice);
router.post('/summon', authenticateToken, requireRole(['admin']), DeviceController.summonDevice);
router.post('/:id/update-wan', authenticateToken, requireRole(['admin']), DeviceController.updateWanConfig);
router.post('/:id/add-wan', authenticateToken, requireRole(['admin']), DeviceController.addWanConnection);
router.put('/:id/installation-date', authenticateToken, requireRole(['admin']), DeviceController.updateInstallationDate);
router.post('/:id/update-wifi', authenticateToken, requireRole(['admin']), DeviceController.updateWifiConfig);
router.post('/:id/update-credentials', authenticateToken, requireRole(['admin']), DeviceController.updateCredentials);

export default router;
