import express from 'express';
import { timingSafeEqual } from 'node:crypto';
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

/**
 * Passes a scraper carrying `METRICS_TOKEN`; sends everybody else through the
 * console's two guards. The token is compared in constant time and read per
 * request, so rotating it is editing the environment and restarting. Unset,
 * only a platform administrator's session reads the counters.
 */
function allowMetricsScraper(req, res, next) {
  const expected = String(process.env.METRICS_TOKEN || '');
  const offered = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1] ?? '';
  if (expected.length >= 32 && offered.length === expected.length
    && timingSafeEqual(Buffer.from(offered), Buffer.from(expected))) {
    return next();
  }
  return authenticateToken(req, res, (error) => {
    if (error) return next(error);
    return requirePlatformAdmin(req, res, next);
  });
}

router.get('/tenants', authenticateToken, requirePlatformAdmin, PlatformController.listTenants);
router.post('/tenants', authenticateToken, requirePlatformAdmin, PlatformController.create);
router.patch('/tenants/:id', authenticateToken, requirePlatformAdmin, PlatformController.setStatus);
router.delete('/tenants/:id', authenticateToken, requirePlatformAdmin, PlatformController.remove);

// O que o processo contou desde que subiu, no formato que o Prometheus lê,
// com `tenant_id` em toda série. Contagem por provedor é a lista de clientes
// com o tamanho de cada um, então fica atrás do mesmo guarda que o resto do
// console — ou de `METRICS_TOKEN`, que é como um coletor entra: um coletor
// não tem sessão, e um JWT de uma hora não é coisa que se cole num scrape.
router.get('/metrics', allowMetricsScraper, PlatformController.metrics);

// A trilha do plano de controle. Só leitura, como a do provedor e pelo mesmo
// motivo: se desse para apagar uma linha, a primeira coisa a fazer depois de
// apagar um provedor seria apagar o registro disso.
router.get('/audit', authenticateToken, requirePlatformAdmin, PlatformController.listAudit);

export default router;
