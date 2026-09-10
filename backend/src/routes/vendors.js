import express from 'express';
import VendorController from '../controllers/vendorController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

router.get('/wifi-security-configs', authenticateToken, requirePermission('catalogue.read'), VendorController.getAllWifiSecurityConfigs);
router.get('/wifi-security-configs/by-product-class/:productClass', authenticateToken, requirePermission('catalogue.read'), VendorController.getWifiSecurityConfigByProductClass);
router.get('/wifi-security-configs/:id', authenticateToken, requirePermission('catalogue.read'), VendorController.getWifiSecurityConfigById);

router.get('/:vendorId/wifi-security', authenticateToken, requirePermission('catalogue.read'), VendorController.getWifiSecurityMappings);

router.post('/wifi-security-configs', authenticateToken, requirePermission('catalogue.write'), VendorController.createWifiSecurityConfig);
router.post('/:vendorId/wifi-security', authenticateToken, requirePermission('catalogue.write'), VendorController.createWifiSecurityMapping);

router.put('/wifi-security/:id', authenticateToken, requirePermission('catalogue.write'), VendorController.updateWifiSecurityMapping);
router.put('/wifi-security-configs/:id', authenticateToken, requirePermission('catalogue.write'), VendorController.updateWifiSecurityConfig);

router.delete('/wifi-security/:id', authenticateToken, requirePermission('catalogue.write'), VendorController.deleteWifiSecurityMapping);
router.delete('/wifi-security-configs/:id', authenticateToken, requirePermission('catalogue.write'), VendorController.deleteWifiSecurityConfig);

router.get('/', authenticateToken, requirePermission('catalogue.read'), VendorController.getAllVendors);
router.get('/:id', authenticateToken, requirePermission('catalogue.read'), VendorController.getVendorById);
router.post('/', authenticateToken, requirePermission('catalogue.write'), VendorController.createVendor);
router.put('/:id', authenticateToken, requirePermission('catalogue.write'), VendorController.updateVendor);
router.delete('/:id', authenticateToken, requirePermission('catalogue.write'), VendorController.deleteVendor);

export default router;