import express from 'express';
import VendorController from '../controllers/vendorController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { requirePlatformCatalogueAuthority } from '../middleware/platformCatalogue.js';

const router = express.Router();

// Escrever no catálogo pede `catalogue.write` e, na caixa da plataforma da
// SaaS, também o cadastro da plataforma: ali o catálogo é o padrão de todo
// provedor, não o de uma equipe. Ver `platformCatalogue.js`.
const canWrite = [requirePermission('catalogue.write'), requirePlatformCatalogueAuthority];

router.get('/wifi-security-configs', authenticateToken, requirePermission('catalogue.read'), VendorController.getAllWifiSecurityConfigs);
router.get('/wifi-security-configs/by-product-class/:productClass', authenticateToken, requirePermission('catalogue.read'), VendorController.getWifiSecurityConfigByProductClass);
router.get('/wifi-security-configs/:id', authenticateToken, requirePermission('catalogue.read'), VendorController.getWifiSecurityConfigById);

router.post('/wifi-security-configs', authenticateToken, ...canWrite, VendorController.createWifiSecurityConfig);

router.put('/wifi-security-configs/:id', authenticateToken, ...canWrite, VendorController.updateWifiSecurityConfig);

router.post('/wifi-security-configs/:id/reset', authenticateToken, ...canWrite, VendorController.resetWifiSecurityConfig);

router.delete('/wifi-security-configs/:id', authenticateToken, ...canWrite, VendorController.deleteWifiSecurityConfig);

router.get('/', authenticateToken, requirePermission('catalogue.read'), VendorController.getAllVendors);
router.get('/:id', authenticateToken, requirePermission('catalogue.read'), VendorController.getVendorById);
router.post('/', authenticateToken, ...canWrite, VendorController.createVendor);
// Volta um perfil ao que está no catálogo padrão da plataforma. A cópia do
// provedor é dele e pode ter sido ajustada; isto desfaz o ajuste, e só dele.
router.post('/:id/reset', authenticateToken, ...canWrite, VendorController.resetVendor);
router.put('/:id', authenticateToken, ...canWrite, VendorController.updateVendor);
router.delete('/:id', authenticateToken, ...canWrite, VendorController.deleteVendor);

export default router;