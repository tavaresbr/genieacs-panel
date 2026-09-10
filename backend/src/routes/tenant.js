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

// E do outro lado da linha que o parágrafo acima descreve: tudo que este
// provedor cadastrou, num arquivo. Autenticada e com capacidade própria.
router.get('/export', authenticateToken, requirePermission('tenant.export'), TenantController.exportTenant);

// O plano, o estado da assinatura e o uso contra o limite. Autenticada, e
// com `settings.read` — é o mesmo lado da linha que as configurações: quem
// pode ver a configuração do provedor pode ver em que plano ele está. Fica
// FORA da porta da assinatura (`subscriptionGate.js` a lista), porque é o que
// a tela de bloqueio mostra.
router.get('/subscription', authenticateToken, requirePermission('settings.read'), TenantController.getSubscription);

// O nome do provedor, escrito por quem administra. É o antigo `appName` das
// configurações, agora na linha do provedor — ver o controlador.
router.patch('/', authenticateToken, requirePermission('settings.write'), TenantController.rename);

export default router;
