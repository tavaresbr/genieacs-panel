import express from 'express';
import WhatsAppBillingController from '../controllers/whatsappBillingController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Admin-only, like every other WhatsApp route: each one below either exposes
// who the provider is about to contact or decides that hundreds of people are
// messaged.
const admin = [authenticateToken, requireRole(['admin'])];

// ── Templates ──────────────────────────────────────────────────────────
router.get('/templates', ...admin, WhatsAppBillingController.listTemplates);
router.post('/templates', ...admin, WhatsAppBillingController.createTemplate);
router.put('/templates/:id', ...admin, WhatsAppBillingController.updateTemplate);
router.delete('/templates/:id', ...admin, WhatsAppBillingController.deleteTemplate);

// ── Do not disturb ─────────────────────────────────────────────────────
router.get('/opt-outs', ...admin, WhatsAppBillingController.listOptOuts);
router.post('/opt-outs', ...admin, WhatsAppBillingController.createOptOut);
router.delete('/opt-outs/:id', ...admin, WhatsAppBillingController.revokeOptOut);

// ── Billing cadence ────────────────────────────────────────────────────
// Both of these call the provider's SGP once per subscriber, so they are the
// two slowest routes in the panel by design. `campaign` builds a DRAFT and
// returns; it never sends.
router.get('/billing/overdue', ...admin, WhatsAppBillingController.listOverdue);
router.post('/billing/campaign', ...admin, WhatsAppBillingController.buildCampaign);

// ── The subscriber's number ────────────────────────────────────────────
// The only way to correct a number outside the database. `{ phone: '' }` is a
// clear, not an empty request: it drops the override and hands the contract
// back to what the ERP last synced.
router.put('/subscribers/:contract/phone', ...admin, WhatsAppBillingController.setSubscriberPhone);

// ── Campaigns ──────────────────────────────────────────────────────────
router.get('/broadcasts', ...admin, WhatsAppBillingController.listBroadcasts);
router.post('/broadcasts/:id/status', ...admin, WhatsAppBillingController.setBroadcastStatus);

export default router;
