import express from 'express';
import WhatsAppAiKnowledgeController from '../controllers/whatsappAiKnowledgeController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

// O que a IA de vendas sabe da empresa: quem configura o chatbot decide.
const gestao = [authenticateToken, requirePermission('whatsapp.config')];

router.get('/ai-knowledge', ...gestao, WhatsAppAiKnowledgeController.list);
router.post('/ai-knowledge', ...gestao, WhatsAppAiKnowledgeController.create);
router.put('/ai-knowledge/:id', ...gestao, WhatsAppAiKnowledgeController.update);
router.delete('/ai-knowledge/:id', ...gestao, WhatsAppAiKnowledgeController.remove);

export default router;
