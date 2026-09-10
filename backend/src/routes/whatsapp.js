import express from 'express';
import WhatsAppController from '../controllers/whatsappController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

// A instância e o servidor Evolution são `whatsapp.config`: mudar por onde o
// provedor fala é decisão de quem administra. O que responde "está
// funcionando?" — a lista de números, o estado de um deles, a saúde da fila — é
// `whatsapp.read`, porque é a primeira coisa que o plantão olha quando o
// atendimento para, e mandar procurar um administrador às três da manhã para
// descobrir que a instância caiu não é política de acesso, é atraso.
router.get('/config', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.getConfig);
router.put('/config', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.updateConfig);
router.get('/accounts', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.listAccounts);

// The one read that answers "is this working?". A screen polls it, so it is
// declared with the other reads and stays as cheap as they are.
router.get('/health', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.getHealth);
router.post('/accounts', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.createAccount);

// Declared before the `:id` routes so the matcher can never read
// `check-number` as an account id.
router.post('/accounts/check-number', authenticateToken, requirePermission('whatsapp.send'), WhatsAppController.checkNumbers);

router.get('/accounts/:id/qr', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.getQr);
router.get('/accounts/:id/status', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.getStatus);
router.post('/accounts/:id/restart', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.restartAccount);
router.post('/accounts/:id/disconnect', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.disconnectAccount);
router.patch('/accounts/:id', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.updateAccount);
router.delete('/accounts/:id', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.deleteAccount);

export default router;
