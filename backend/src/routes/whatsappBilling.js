import express from 'express';
import WhatsAppBillingController from '../controllers/whatsappBillingController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

// Duas guardas, e a linha entre elas é a que separa ver de disparar. Ler a
// lista de inadimplentes ou os modelos é trabalho de plantão; criar campanha,
// mudar modelo ou tirar alguém do não-perturbe decide que centenas de pessoas
// recebem mensagem do provedor, e isso não é ato de plantão.
const leitura = [authenticateToken, requirePermission('campaigns.read')];
const gestao = [authenticateToken, requirePermission('campaigns.manage')];

// ── Templates ──────────────────────────────────────────────────────────
router.get('/templates', ...leitura, WhatsAppBillingController.listTemplates);
router.post('/templates', ...gestao, WhatsAppBillingController.createTemplate);
router.put('/templates/:id', ...gestao, WhatsAppBillingController.updateTemplate);
router.delete('/templates/:id', ...gestao, WhatsAppBillingController.deleteTemplate);

// ── Do not disturb ─────────────────────────────────────────────────────
router.get('/opt-outs', ...leitura, WhatsAppBillingController.listOptOuts);
router.post('/opt-outs', ...gestao, WhatsAppBillingController.createOptOut);
router.delete('/opt-outs/:id', ...gestao, WhatsAppBillingController.revokeOptOut);

// ── Billing cadence ────────────────────────────────────────────────────
// Both of these call the provider's SGP once per subscriber, so they are the
// two slowest routes in the panel by design. `campaign` builds a DRAFT and
// returns; it never sends.
router.get('/billing/overdue', ...leitura, WhatsAppBillingController.listOverdue);
router.post('/billing/campaign', ...gestao, WhatsAppBillingController.buildCampaign);

// ── The subscriber's number ────────────────────────────────────────────
// The only way to correct a number outside the database. `{ phone: '' }` is a
// clear, not an empty request: it drops the override and hands the contract
// back to what the ERP last synced.
router.put('/subscribers/:contract/phone', ...gestao, WhatsAppBillingController.setSubscriberPhone);

// ── Campaigns ──────────────────────────────────────────────────────────
router.get('/broadcasts', ...leitura, WhatsAppBillingController.listBroadcasts);
router.post('/broadcasts/:id/status', ...gestao, WhatsAppBillingController.setBroadcastStatus);

export default router;
