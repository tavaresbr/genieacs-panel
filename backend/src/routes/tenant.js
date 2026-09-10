import express from 'express';
import TenantController from '../controllers/tenantController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

/**
 * Unauthenticated on purpose, and the only route in the panel that is
 * unauthenticated by design rather than by necessity: the login screen has to
 * show the provider's name before there is anybody to authenticate.
 *
 * The path is `/public` rather than `/` so that the next thing mounted on this
 * router cannot inherit its openness by accident. A future `GET /api/tenant`
 * returning the provider's real settings would be a one-line addition to this
 * file, and with the open route sitting at `/` there would be nothing in the
 * shape of the code to make its author notice which side of the line they were
 * on. The word `public` in the path is the reminder.
 */
router.get('/public', TenantController.getPublicProfile);

// Do lado autenticado da linha: o plano e quanto dele já foi gasto. Basta ler
// as configurações — quem enxerga a tela de configurações enxerga o plano —, e
// não `settings.write`, que faria só quem pode mudar coisas saber por que não
// consegue mais cadastrar operador.
router.get('/usage', authenticateToken, requirePermission('settings.read'), TenantController.getUsage);

// E do outro lado da linha que o parágrafo acima descreve: tudo que este
// provedor cadastrou, num arquivo. Autenticada e com capacidade própria.
router.get('/export', authenticateToken, requirePermission('tenant.export'), TenantController.exportTenant);

export default router;
