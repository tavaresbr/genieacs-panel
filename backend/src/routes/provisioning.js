import express from 'express';
import ProvisioningController from '../controllers/provisioningController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { provisioningActionLimiter } from '../middleware/rateLimit.js';

const router = express.Router();
const admin = [authenticateToken, requireRole(['admin'])];

router.get('/config', ...admin, ProvisioningController.getConfig);
router.put('/config', ...admin, ProvisioningController.updateConfig);

router.get('/profiles', ...admin, ProvisioningController.listProfiles);
router.post('/profiles', ...admin, ProvisioningController.createProfile);
router.put('/profiles/:id', ...admin, ProvisioningController.updateProfile);
router.delete('/profiles/:id', ...admin, ProvisioningController.deleteProfile);

router.get('/runs', ...admin, ProvisioningController.listRuns);
// Writing to a CPE is slow and visible to a subscriber, so the actions that do
// it are limited per operator on top of the shared API limit.
router.post('/run', ...admin, provisioningActionLimiter, ProvisioningController.runPass);
router.get('/devices/:deviceId/runs', ...admin, ProvisioningController.listDeviceRuns);
router.post(
  '/devices/:deviceId/preview', ...admin, provisioningActionLimiter, ProvisioningController.previewDevice
);
router.post(
  '/devices/:deviceId/provision', ...admin, provisioningActionLimiter, ProvisioningController.provisionDevice
);

export default router;
