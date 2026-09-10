import express from 'express';
import SettingsController from '../controllers/settingsController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, requirePermission('settings.read'), SettingsController.getAllSettings);

router.get('/:key', authenticateToken, requirePermission('settings.read'), SettingsController.getSettingByKey);

router.post('/', authenticateToken, requirePermission('settings.write'), SettingsController.createSetting);

router.post('/sync-customer-ids', authenticateToken, requirePermission('settings.write'), SettingsController.syncCustomerIds);

router.put('/:key', authenticateToken, requirePermission('settings.write'), SettingsController.updateSetting);

router.delete('/:key', authenticateToken, requirePermission('settings.write'), SettingsController.deleteSetting);

router.post('/test-genieacs', authenticateToken, requirePermission('settings.write'), SettingsController.testGenieAcsConnection);

export default router;
