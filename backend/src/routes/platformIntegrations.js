import express from 'express';
import PlatformIntegrationsController from '../controllers/platformIntegrationsController.js';
import PlatformSettingsController from '../controllers/platformSettingsController.js';
import PlatformBackupController from '../controllers/platformBackupController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';
import { BRANDING_KINDS } from '../services/platformBrandingService.js';

/**
 * As integrações da plataforma com sistemas de fora — hoje, a conta dela no
 * Asaas. Mesma guarda dupla do resto do console: a chave com que a plataforma
 * cobra os provedores é o segredo mais caro deste deploy, e o administrador de
 * um provedor, por mais dono que seja do ISP dele, não chega perto dela.
 */
const router = express.Router();
const guard = [authenticateToken, requirePlatformAdmin];

router.get('/integrations/asaas', ...guard, PlatformIntegrationsController.getAsaas);
router.put('/integrations/asaas', ...guard, PlatformIntegrationsController.updateAsaas);
router.post('/integrations/asaas/test', ...guard, PlatformIntegrationsController.testAsaas);
router.post('/integrations/asaas/webhook-token', ...guard, PlatformIntegrationsController.rotateWebhookToken);

// Configurações → Dados do SaaS: a empresa que vende, como o site a mostra.
router.get('/settings/profile', ...guard, PlatformSettingsController.getProfile);
router.put('/settings/profile', ...guard, PlatformSettingsController.updateProfile);
// A logo e o favicon. O corpo cru do PUT é lido em `app.js` (`BRANDING_UPLOAD_PATH`),
// antes do parser JSON; aqui só a rota e a guarda.
for (const kind of BRANDING_KINDS) {
  router.put(`/settings/branding/${kind}`, ...guard, PlatformSettingsController.saveBranding(kind));
  router.delete(`/settings/branding/${kind}`, ...guard, PlatformSettingsController.removeBranding(kind));
}
// Configurações → Alertas (0112): a configuração vai no perfil; o teste, aqui.
router.post('/alerts/test', ...guard, PlatformSettingsController.testAlert);
// O histórico da fila de alertas, e o reenvio do que falhou ou foi pulado.
router.get('/alerts', ...guard, PlatformSettingsController.listAlerts);
router.post('/alerts/:id/resend', ...guard, PlatformSettingsController.resendAlert);
// Configurações → E-mail: prova o SMTP do deploy mandando uma mensagem de verdade.
router.post('/mail/test', ...guard, PlatformSettingsController.testMail);
// Configurações → Régua de cobrança (0121): a régua vai no perfil; o teste, aqui.
router.post('/settings/reminder-policy/test', ...guard, PlatformSettingsController.testReminderPolicy);

// O provedor como cliente na conta Asaas da plataforma: cria lá e liga aqui.
router.post('/tenants/:id/gateway/asaas-customer', ...guard, PlatformIntegrationsController.createAsaasCustomer);

// Integrações → Backup externo: o S3 compatível, a chave pública (a privada
// nunca mora no servidor), o "fazer agora" e a verificação.
router.get('/integrations/backup', ...guard, PlatformBackupController.get);
router.put('/integrations/backup', ...guard, PlatformBackupController.update);
router.post('/integrations/backup/public-key', ...guard, PlatformBackupController.setPublicKey);
router.post('/integrations/backup/keypair', ...guard, PlatformBackupController.generateKeyPair);
router.post('/integrations/backup/test', ...guard, PlatformBackupController.test);
router.post('/integrations/backup/run', ...guard, PlatformBackupController.run);
router.post('/integrations/backup/verify', ...guard, PlatformBackupController.verify);

export default router;
