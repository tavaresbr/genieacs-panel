import express from 'express';
import { runInTenant } from '../config/tenantContext.js';
import Tenant from '../models/Tenant.js';
import TelegramBotService from '../services/telegramBotService.js';
import { telegramWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * Entrada do bot de comandos do Telegram.
 *
 * PÚBLICA — montada antes de `authenticateToken`, porque quem chama é o
 * Telegram, não um navegador. Fail-closed: sem o header de segredo, ou com um
 * que não bate com o guardado do provedor, é 401 — e a mesma resposta serve a
 * provedor inexistente e a bot desligado, para não dizer a quem sonda quais
 * provedores existem.
 *
 * Tudo o que for reconhecido responde 200, ligado a uma ação ou não: o Telegram
 * reentrega o que não recebe 2xx, e reentregar uma mensagem que o bot decidiu
 * ignorar seria um laço.
 */
router.post('/:tenantId', telegramWebhookLimiter, async (req, res) => {
  const tenantId = Number.parseInt(req.params.tenantId, 10);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return res.sendStatus(401);
  try {
    const tenant = await Tenant.findPublicById(tenantId);
    if (!tenant) return res.sendStatus(401);
    const header = req.get('x-telegram-bot-api-secret-token');
    const accepted = await runInTenant(tenantId, async () => {
      if (!(await TelegramBotService.secretMatches(header))) return false;
      // Responde já; o que o bot faz a seguir (uma consulta ao ACS pode demorar)
      // não segura o Telegram nem provoca reentrega. `handleUpdate` nunca lança
      // e continua dentro do escopo do provedor.
      res.sendStatus(200);
      await TelegramBotService.handleUpdate(req.body);
      return true;
    });
    if (!accepted) return res.sendStatus(401);
    return undefined;
  } catch (error) {
    console.warn(`Telegram webhook failed: ${String(error?.message || 'error').replace(/[\r\n]+/g, ' ').slice(0, 120)}`);
    // 200: um erro nosso não deve virar reentrega em laço do mesmo update.
    return res.headersSent ? undefined : res.sendStatus(200);
  }
});

export default router;
