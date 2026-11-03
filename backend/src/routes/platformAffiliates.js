import express from 'express';
import AffiliateController from '../controllers/affiliateController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * O programa de afiliados (0126) visto do console: o cadastro, a aprovação e
 * os lotes mensais. Ids de tabelas da plataforma (`affiliates`,
 * `affiliate_payouts`), sem provedor a alcançar.
 */
const router = express.Router();
const guard = [authenticateToken, requirePlatformAdmin];

router.get('/affiliates', ...guard, AffiliateController.list);
router.post('/affiliates', ...guard, AffiliateController.create);
router.get('/affiliates/:id', ...guard, AffiliateController.detail);
router.patch('/affiliates/:id', ...guard, AffiliateController.update);
router.post('/affiliates/:id/password-link', ...guard, AffiliateController.passwordLink);
router.get('/affiliate-payouts', ...guard, AffiliateController.listPayouts);
router.post('/affiliate-payouts/build', ...guard, AffiliateController.buildPayouts);
router.post('/affiliate-payouts/:id/approve', ...guard, AffiliateController.approvePayout);
router.post('/affiliate-payouts/:id/send', ...guard, AffiliateController.sendPayout);
router.post('/affiliate-payouts/:id/refresh', ...guard, AffiliateController.refreshPayout);
router.post('/affiliate-payouts/:id/mark-paid', ...guard, AffiliateController.markPayoutPaid);
router.post('/affiliate-payouts/:id/cancel', ...guard, AffiliateController.cancelPayout);

export default router;
