import express from 'express';
import AffiliateController from '../controllers/affiliateController.js';
import { authenticateAffiliate } from '../middleware/affiliateAuth.js';
import { affiliateLoginLimiter } from '../middleware/rateLimit.js';

/**
 * O portal do afiliado (0126), no endereço da plataforma. Sessão própria
 * (`affiliateAuth.js`), e nenhuma rota com parâmetro de caminho: o afiliado
 * só lê o que o id da SESSÃO dele alcança.
 */
const router = express.Router();

router.post('/login', affiliateLoginLimiter, AffiliateController.login);
router.post('/password', affiliateLoginLimiter, AffiliateController.setPassword);
router.post('/logout', authenticateAffiliate, AffiliateController.logout);
router.get('/overview', authenticateAffiliate, AffiliateController.overview);

export default router;
