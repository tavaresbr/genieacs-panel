import express from 'express';
import TelegramChatController from '../controllers/telegramChatController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { telegramBotAdminLimiter, whatsappSendLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// As mesmas capacidades do WhatsApp e do Messenger: ler a caixa é `whatsapp.read`,
// responder é `whatsapp.send` (falar COMO o provedor) e ligar o bot é `whatsapp.config`.
router.get('/bot', authenticateToken, requirePermission('whatsapp.read'), TelegramChatController.status);
router.put('/bot', authenticateToken, requirePermission('whatsapp.config'), telegramBotAdminLimiter, TelegramChatController.saveBot);
router.post('/bot/enable', authenticateToken, requirePermission('whatsapp.config'), telegramBotAdminLimiter, TelegramChatController.enable);
router.post('/bot/disable', authenticateToken, requirePermission('whatsapp.config'), telegramBotAdminLimiter, TelegramChatController.disable);
router.post('/bot/disconnect', authenticateToken, requirePermission('whatsapp.config'), telegramBotAdminLimiter, TelegramChatController.disconnect);

// Quais avisos saem pelo Telegram: ler é de quem atende, mudar é configuração.
router.get('/notices', authenticateToken, requirePermission('whatsapp.read'), TelegramChatController.getNotices);
router.put('/notices', authenticateToken, requirePermission('whatsapp.config'), telegramBotAdminLimiter, TelegramChatController.saveNotices);

// O link de vínculo é falar COMO o provedor com o assinante: `whatsapp.send`.
router.post('/links', authenticateToken, requirePermission('whatsapp.send'), whatsappSendLimiter, TelegramChatController.createLink);

router.get('/conversations', authenticateToken, requirePermission('whatsapp.read'), TelegramChatController.listConversations);
router.get('/conversations/:id/messages', authenticateToken, requirePermission('whatsapp.read'), TelegramChatController.listMessages);
router.post('/conversations/:id/messages', authenticateToken, requirePermission('whatsapp.send'), whatsappSendLimiter, TelegramChatController.send);
router.post('/conversations/:id/subscriber', authenticateToken, requirePermission('whatsapp.send'), TelegramChatController.linkSubscriber);
router.delete('/conversations/:id/subscriber', authenticateToken, requirePermission('whatsapp.send'), TelegramChatController.unlinkSubscriber);
router.post('/conversations/:id/closed', authenticateToken, requirePermission('whatsapp.send'), TelegramChatController.setClosed);

export default router;
