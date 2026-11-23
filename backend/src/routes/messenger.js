import express from 'express';
import MessengerController from '../controllers/messengerController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { whatsappSendLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// As mesmas capacidades do WhatsApp: ler a caixa é `whatsapp.read`, responder é
// `whatsapp.send` (falar COMO o provedor) e conectar a Página é `whatsapp.config`.
router.get('/status', authenticateToken, requirePermission('whatsapp.read'), MessengerController.status);
// O que a pessoa lê no Messenger em nome do provedor é configuração: `whatsapp.config`.
router.get('/settings', authenticateToken, requirePermission('whatsapp.config'), MessengerController.getSettings);
router.put('/settings', authenticateToken, requirePermission('whatsapp.config'), MessengerController.saveSettings);
router.get('/pages', authenticateToken, requirePermission('whatsapp.config'), MessengerController.listPages);
router.post('/pages', authenticateToken, requirePermission('whatsapp.config'), MessengerController.connectPage);
// O login do Facebook: o navegador entrega o token do usuário, o servidor faz o resto.
router.post('/facebook/pages', authenticateToken, requirePermission('whatsapp.config'), MessengerController.facebookPages);
router.post('/facebook/connect', authenticateToken, requirePermission('whatsapp.config'), MessengerController.facebookConnect);
router.post('/pages/:id/subscribe', authenticateToken, requirePermission('whatsapp.config'), MessengerController.resubscribePage);
router.delete('/pages/:id', authenticateToken, requirePermission('whatsapp.config'), MessengerController.disconnectPage);

// O link de vínculo é falar COMO o provedor com o assinante: `whatsapp.send`.
router.post('/links', authenticateToken, requirePermission('whatsapp.send'), whatsappSendLimiter, MessengerController.createLink);

router.get('/conversations', authenticateToken, requirePermission('whatsapp.read'), MessengerController.listConversations);
router.get('/conversations/:id/messages', authenticateToken, requirePermission('whatsapp.read'), MessengerController.listMessages);
router.post('/messages/:id/retry', authenticateToken, requirePermission('whatsapp.send'), whatsappSendLimiter, MessengerController.retry);
router.post('/conversations/:id/messages', authenticateToken, requirePermission('whatsapp.send'), whatsappSendLimiter, MessengerController.send);
// Dizer de quem é a conversa é trabalho de quem atende: `whatsapp.send`, como o vínculo do WhatsApp.
router.post('/conversations/:id/subscriber', authenticateToken, requirePermission('whatsapp.send'), MessengerController.linkSubscriber);
router.delete('/conversations/:id/subscriber', authenticateToken, requirePermission('whatsapp.send'), MessengerController.unlinkSubscriber);
router.post('/conversations/:id/closed', authenticateToken, requirePermission('whatsapp.send'), MessengerController.setClosed);

export default router;
