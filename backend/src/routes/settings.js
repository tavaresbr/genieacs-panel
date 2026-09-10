import express from 'express';
import SettingsController from '../controllers/settingsController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, requirePermission('settings.read'), SettingsController.getAllSettings);

// A credencial com que o painel se apresenta à NBI. Leitura em `settings.read`
// porque a resposta não traz o segredo — só o tipo, o usuário e se existe um —
// e quem administra precisa ver o que está configurado sem poder mudá-lo.
//
// ANTES de `/:key`, e não junto de `/test-genieacs` lá embaixo: `/:key` casa
// com qualquer segmento, então declarada depois esta rota nunca seria
// alcançada — o GET responderia "configuração não encontrada" e o PUT tentaria
// gravar uma chave chamada `genieacs-auth`, que a allowlist recusa. Os dois
// erros parecem bug de outra coisa.
router.get('/genieacs-auth', authenticateToken, requirePermission('settings.read'), SettingsController.getGenieAcsAuth);
router.put('/genieacs-auth', authenticateToken, requirePermission('settings.write'), SettingsController.updateGenieAcsAuth);

router.get('/:key', authenticateToken, requirePermission('settings.read'), SettingsController.getSettingByKey);

router.post('/', authenticateToken, requirePermission('settings.write'), SettingsController.createSetting);

router.post('/sync-customer-ids', authenticateToken, requirePermission('settings.write'), SettingsController.syncCustomerIds);

router.put('/:key', authenticateToken, requirePermission('settings.write'), SettingsController.updateSetting);

router.delete('/:key', authenticateToken, requirePermission('settings.write'), SettingsController.deleteSetting);

router.post('/test-genieacs', authenticateToken, requirePermission('settings.write'), SettingsController.testGenieAcsConnection);

export default router;
