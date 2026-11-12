import express from 'express';
import WhatsAppAiKnowledgeController from '../controllers/whatsappAiKnowledgeController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { whatsappSendLimiter } from '../middleware/rateLimit.js';
import { requireAddon } from '../middleware/addonGate.js';

const router = express.Router();

// O que a IA de vendas sabe da empresa: quem configura o chatbot decide.
const gestao = [authenticateToken, requirePermission('whatsapp.config')];

router.get('/ai-knowledge', ...gestao, WhatsAppAiKnowledgeController.list);
router.post('/ai-knowledge', ...gestao, WhatsAppAiKnowledgeController.create);
// A IA escreve (ou melhora) a resposta do item: só rascunho, e paga por uso (add-on `ai`).
// Declarada antes das rotas com `:id`, para `ai-draft` nunca ser lido como id.
router.post('/ai-knowledge/ai-draft', ...gestao, requireAddon('ai'), whatsappSendLimiter, WhatsAppAiKnowledgeController.draft);
router.put('/ai-knowledge/:id', ...gestao, WhatsAppAiKnowledgeController.update);
router.delete('/ai-knowledge/:id', ...gestao, WhatsAppAiKnowledgeController.remove);

export default router;
