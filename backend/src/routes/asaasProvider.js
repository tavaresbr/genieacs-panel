import express from 'express';
import AsaasProviderController from '../controllers/asaasProviderController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { asaasAdminLimiter } from '../middleware/rateLimit.js';

/**
 * A conta Asaas do provedor. Fica em `/api/asaas`, e não junto das rotas de
 * cobrança da plataforma (`/api/platform/...`): aquela é a conta que cobra os
 * provedores, esta é a que cobra os assinantes.
 */
const router = express.Router();

router.get('/config', authenticateToken, requirePermission('asaas.config'), AsaasProviderController.getConfig);
router.put('/config', authenticateToken, requirePermission('asaas.config'), AsaasProviderController.updateConfig);
router.post('/test', authenticateToken, requirePermission('asaas.config'), asaasAdminLimiter, AsaasProviderController.testConnection);

export default router;
