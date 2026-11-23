import express from 'express';
import { runInTenant } from '../config/tenantContext.js';
import Tenant from '../models/Tenant.js';
import TelegramCustomerBotService from '../services/telegramCustomerBotService.js';
import TelegramInboundService from '../services/telegramInboundService.js';
import { telegramWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * Entrada do bot dos CLIENTES do Telegram.
 *
 * PÚBLICA — montada antes de `authenticateToken`, porque quem chama é o
 * Telegram. Fail-closed: sem o segredo do cabeçalho, ou com um que não bate com
 * o hash guardado do provedor, é 401 — a mesma resposta para provedor
 * inexistente, bot desligado e segredo errado, para não dizer a quem sonda quais
 * provedores existem.
 *
 * Tudo o que for reconhecido responde 200 antes de processar: o Telegram
 * reentrega o que não recebe 2xx, e uma conversa lenta não pode virar laço.
 */
router.post('/:tenantId', telegramWebhookLimiter, async (req, res) => {
  const tenantId = Number.parseInt(req.params.tenantId, 10);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return res.sendStatus(401);
  try {
    const tenant = await Tenant.findPublicById(tenantId);
    if (!tenant) return res.sendStatus(401);
    const header = req.get('x-telegram-bot-api-secret-token');
    const accepted = await runInTenant(tenantId, async () => {
      if (!(await TelegramCustomerBotService.secretMatches(header))) return false;
      res.sendStatus(200);
      await TelegramInboundService.process(req.body);
      return true;
    });
    if (!accepted) return res.sendStatus(401);
    return undefined;
  } catch {
    console.warn('Telegram customer webhook failed');
    return res.headersSent ? undefined : res.sendStatus(200);
  }
});

export default router;
