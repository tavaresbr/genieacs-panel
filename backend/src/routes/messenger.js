import express from 'express';
import MessengerController from '../controllers/messengerController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { whatsappSendLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// As mesmas capacidades do WhatsApp: ler a caixa é `whatsapp.read`, responder é
// `whatsapp.send` (falar COMO o provedor) e conectar a Página é `whatsapp.config`.
router.get('/status', authenticateToken, requirePermission('whatsapp.read'), MessengerController.status);
router.get('/pages', authenticateToken, requirePermission('whatsapp.config'), MessengerController.listPages);
router.post('/pages', authenticateToken, requirePermission('whatsapp.config'), MessengerController.connectPage);
router.delete('/pages/:id', authenticateToken, requirePermission('whatsapp.config'), MessengerController.disconnectPage);

router.get('/conversations', authenticateToken, requirePermission('whatsapp.read'), MessengerController.listConversations);
router.get('/conversations/:id/messages', authenticateToken, requirePermission('whatsapp.read'), MessengerController.listMessages);
router.post('/conversations/:id/messages', authenticateToken, requirePermission('whatsapp.send'), whatsappSendLimiter, MessengerController.send);
router.post('/conversations/:id/closed', authenticateToken, requirePermission('whatsapp.send'), MessengerController.setClosed);

export default router;
