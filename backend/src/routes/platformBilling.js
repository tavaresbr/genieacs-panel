import express from 'express';
import PlatformBillingController from '../controllers/platformBillingController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * A metade comercial do plano de controle. Mesma guarda dupla de
 * `platform.js`, pelo mesmo motivo: o plano de um provedor é decisão de quem
 * opera o SaaS, e o administrador do próprio provedor — por mais dono que seja
 * — não muda o que paga por uma rota do painel.
 */
const router = express.Router();
const guard = [authenticateToken, requirePlatformAdmin];

router.get('/plans', ...guard, PlatformBillingController.listPlans);
router.post('/plans', ...guard, PlatformBillingController.createPlan);
router.patch('/plans/:id', ...guard, PlatformBillingController.updatePlan);

router.get('/tenants/:id/subscription', ...guard, PlatformBillingController.getSubscription);
router.put('/tenants/:id/subscription', ...guard, PlatformBillingController.updateSubscription);
router.post('/tenants/:id/payments', ...guard, PlatformBillingController.recordPayment);
router.get('/tenants/:id/usage', ...guard, PlatformBillingController.getUsage);

export default router;
