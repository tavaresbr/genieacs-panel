import express from 'express';
import AsaasWebhookController from '../controllers/asaasWebhookController.js';
import { asaasWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * A entrega do webhook da conta Asaas dos provedores.
 *
 * Pública porque quem chama é um servidor: autentica pelo token que o provedor
 * colou no painel do Asaas (cabeçalho `asaas-access-token`), e é esse token que
 * diz de qual provedor é a entrega. Montada acima do resolvedor de provedor em
 * `app.js`, como a de cobrança da plataforma.
 */
router.post('/', asaasWebhookLimiter, AsaasWebhookController.receive);

export default router;
