import express from 'express';
import WhatsAppAlertsController from '../controllers/whatsappAlertsController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { telegramTestLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// `whatsapp.config` e não `whatsapp.read`: aqui está a escala de plantão, e
// mexer nela põe mensagem no telefone de um técnico às três da manhã. Quem está
// de plantão recebe o alerta; quem decide quem recebe é outra pessoa.
router.get('/alerts/settings', authenticateToken, requirePermission('whatsapp.config'), WhatsAppAlertsController.getSettings);
router.put('/alerts/settings', authenticateToken, requirePermission('whatsapp.config'), WhatsAppAlertsController.updateSettings);
router.post('/alerts/scan', authenticateToken, requirePermission('whatsapp.config'), WhatsAppAlertsController.scan);
// Uma mensagem de teste no grupo do Telegram: é o que diz se o bot está lá.
router.post('/alerts/telegram/test', authenticateToken, requirePermission('whatsapp.config'), telegramTestLimiter, WhatsAppAlertsController.testTelegram);

export default router;
