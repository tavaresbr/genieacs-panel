import express from 'express';
import PlatformController from '../controllers/platformController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * The SaaS control plane.
 *
 * Every route here is guarded twice over, and the two guards answer different
 * questions. `authenticateToken` asks who is signed in and at which provider;
 * `requirePlatformAdmin` asks whether that person is on the platform roster at
 * all — a plane ABOVE any provider, because minting a provider and reaching
 * between providers is precisely what a provider's own administrator must not
 * be able to do, however senior they are inside their own ISP.
 *
 * `platform_admins` is created empty and no migration promotes anybody, so on a
 * deployment where nobody has been granted the role these routes exist and
 * refuse everyone. That is the safe side of failing.
 *
 * O DELETE existe desde a onda 22 e exige quatro coisas ao mesmo tempo — ver
 * o comentário no controlador, que explica por que a decisão anterior de não
 * ter DELETE continua correta na forma como ela foi tomada.
 */
const router = express.Router();

router.get('/tenants', authenticateToken, requirePlatformAdmin, PlatformController.listTenants);
router.post('/tenants', authenticateToken, requirePlatformAdmin, PlatformController.create);
router.patch('/tenants/:id', authenticateToken, requirePlatformAdmin, PlatformController.setStatus);
// O eixo comercial tem rota própria, e não um campo a mais no PATCH acima: um
// `status` que às vezes congela o provedor e às vezes marca a fatura em atraso
// é a ambiguidade que faz alguém suspender um cliente e, sem querer, torná-lo
// elegível para exclusão.
router.patch(
  '/tenants/:id/subscription',
  authenticateToken, requirePlatformAdmin, PlatformController.setSubscriptionStatus
);
router.delete('/tenants/:id', authenticateToken, requirePlatformAdmin, PlatformController.remove);

// A trilha do plano de controle. Só leitura, como a do provedor e pelo mesmo
// motivo: se desse para apagar uma linha, a primeira coisa a fazer depois de
// apagar um provedor seria apagar o registro disso.
router.get('/audit', authenticateToken, requirePlatformAdmin, PlatformController.listAudit);

export default router;
