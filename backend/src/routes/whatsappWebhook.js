import express from 'express';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService from '../services/whatsappConfigService.js';
import WaInboundService from '../services/waInboundService.js';
import { canonicalizarEvento } from '../utils/wa/waEventos.js';
import { pedidoAutorizado, tokenDaQuery, credencialDoPedido } from '../utils/wa/waWebhookAuth.js';
import { waWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * Inbound events from the Evolution server.
 *
 * This route is PUBLIC — it is mounted before `authenticateToken`, because the
 * caller is a server, not a browser session. Its only credential is the token
 * in the query string, and the check is fail-closed: no credential means 401.
 *
 * It answers 200 for anything it recognises but does not act on. That is not
 * laziness: both servers retry on non-2xx, and retrying an event we have
 * deliberately ignored (a group message, an edit with no receipt) would turn a
 * quiet no-op into a loop.
 */
router.post('/', waWebhookLimiter, async (req, res) => {
  const body = req.body ?? {};
  const instance = String(body.instance ?? body.instanceName ?? '').trim();
  if (!instance) return res.status(400).json({ success: false, error: 'missing instance' });

  const account = await WhatsAppAccount.getByName(instance);
  // Unknown instance and wrong credential answer the same 401 on purpose: the
  // difference would tell a prober which instance names exist.
  if (!account) return res.status(401).json({ success: false, error: 'unauthorized' });

  const autorizado = pedidoAutorizado(
    {
      webhookToken: WhatsAppConfigService.decryptWebhookToken(account),
      instanceToken: WhatsAppConfigService.decryptInstanceToken(account)
    },
    {
      urlToken: tokenDaQuery(req.query),
      credencial: credencialDoPedido(req.headers, body)
    }
  );
  if (!autorizado) return res.status(401).json({ success: false, error: 'unauthorized' });

  const evento = canonicalizarEvento(body.event ?? body.Event ?? '');

  try {
    const resultado = await WaInboundService.handle(account, evento, body);
    // The body names what happened. It is the only observability this path has:
    // an event that was stored and an event that was deliberately dropped both
    // answer 200, and without `skipped` they are indistinguishable from the
    // outside — which is how the source system went sixteen days with no
    // delivery receipts at all and nobody noticed.
    return res.json({ success: true, event: evento, ...resultado });
  } catch (error) {
    // 500 on purpose, and only here. An unexpected failure (the database is
    // down, the disk is full) IS worth retrying, and a retry is exactly what a
    // non-2xx buys us. Everything we merely choose not to act on left through
    // the 200 above.
    console.error(`[wa] webhook handler failed for ${evento}:`, error.message);
    return res.status(500).json({ success: false, event: evento, error: 'handler_failed' });
  }
});

export default router;
