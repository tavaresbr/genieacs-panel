import express from 'express';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService from '../services/whatsappConfigService.js';
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

  // Wave 1 wires the four handlers (QR, connection, message, receipt) onto the
  // canonical name above. Until then the receiver is authenticated and inert —
  // which is the correct state, since no account exists to produce events yet.
  return res.json({ success: true, event: evento, handled: false });
});

export default router;
