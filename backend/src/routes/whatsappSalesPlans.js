import express from 'express';
import WhatsAppSalesPlanController from '../controllers/whatsappSalesPlanController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

// O catálogo que a IA de vendas usa. Quem configura o chatbot decide o que se
// oferece e por quanto; ler a lista também é configuração, não plantão.
const gestao = [authenticateToken, requirePermission('whatsapp.config')];

router.get('/sales-plans', ...gestao, WhatsAppSalesPlanController.list);
router.post('/sales-plans', ...gestao, WhatsAppSalesPlanController.create);
// Declarada antes das rotas com `:id`, para `import-sgp` nunca ser lido como id.
router.post('/sales-plans/import-sgp', ...gestao, WhatsAppSalesPlanController.importFromSgp);
router.put('/sales-plans/:id', ...gestao, WhatsAppSalesPlanController.update);
router.delete('/sales-plans/:id', ...gestao, WhatsAppSalesPlanController.remove);

export default router;
