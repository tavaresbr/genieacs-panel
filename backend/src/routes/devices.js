import express from 'express';
import DeviceController from '../controllers/deviceController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { portalPasswordAdminLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

router.get('/', authenticateToken, requirePermission('devices.list'), DeviceController.getDevices);
router.get('/dashboard', authenticateToken, requirePermission('devices.list'), DeviceController.getDashboard);
router.get('/faults', authenticateToken, requirePermission('devices.list'), DeviceController.getFaults);
router.delete('/faults/:faultId', authenticateToken, requirePermission('devices.write'), DeviceController.deleteFault);
// Above the bare `/:deviceId` route, so `/swaps` is not read as a device id.
router.get('/swaps', authenticateToken, requirePermission('devices.inspect'), DeviceController.getSwaps);
router.post('/swaps/:id/acknowledge', authenticateToken, requirePermission('devices.write'), DeviceController.acknowledgeSwap);
// Above the bare `/:deviceId` route, like the other device sub-paths.
router.get('/:deviceId/history', authenticateToken, requirePermission('devices.list'), DeviceController.getHistory);
router.get('/:deviceId/swaps', authenticateToken, requirePermission('devices.inspect'), DeviceController.getDeviceSwaps);
router.get('/:deviceId/portal-password', authenticateToken, requirePermission('customers.secrets'), portalPasswordAdminLimiter, DeviceController.getPortalPassword);
router.post('/:deviceId/portal-password/reset', authenticateToken, requirePermission('customers.secrets'), portalPasswordAdminLimiter, DeviceController.resetPortalPassword);
router.get('/:deviceId', authenticateToken, requirePermission('devices.inspect'), DeviceController.getDeviceDetail);
router.delete('/:deviceId', authenticateToken, requirePermission('devices.write'), DeviceController.deleteDevice);
router.post('/reboot', authenticateToken, requirePermission('devices.write'), DeviceController.rebootDevice);
router.post('/summon', authenticateToken, requirePermission('devices.write'), DeviceController.summonDevice);
router.post('/:id/update-wan', authenticateToken, requirePermission('devices.write'), DeviceController.updateWanConfig);
router.post('/:id/add-wan', authenticateToken, requirePermission('devices.write'), DeviceController.addWanConnection);
router.put('/:id/installation-date', authenticateToken, requirePermission('devices.write'), DeviceController.updateInstallationDate);
router.post('/:id/update-wifi', authenticateToken, requirePermission('devices.write'), DeviceController.updateWifiConfig);
router.post('/:id/update-credentials', authenticateToken, requirePermission('devices.write'), DeviceController.updateCredentials);

export default router;
