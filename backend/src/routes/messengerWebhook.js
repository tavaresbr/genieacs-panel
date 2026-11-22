import express from 'express';
import MessengerInboundService from '../services/messengerInboundService.js';
import { verifyMetaSignature, safeEqual } from '../utils/messenger/messengerSignature.js';
import { waWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * Verificação do webhook: a Meta faz um GET com `hub.verify_token` ao
 * cadastrar a URL e espera o `hub.challenge` de volta, em texto puro.
 *
 * O token é UM só, da plataforma (`MESSENGER_VERIFY_TOKEN`), porque o app Meta
 * é um só. Ele não autentica entrega nenhuma — só prova que quem cadastrou a
 * URL na Meta conhece o segredo; quem autentica a entrega é a assinatura.
 */
router.get('/', waWebhookLimiter, (req, res) => {
  const expected = process.env.MESSENGER_VERIFY_TOKEN;
  const ok = expected
    && req.query['hub.mode'] === 'subscribe'
    && safeEqual(req.query['hub.verify_token'], expected);
  if (!ok) return res.sendStatus(403);
  return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
});

/**
 * Entrega de eventos. Pública (quem chama é a Meta, não uma sessão) e montada
 * com o corpo BRUTO, porque a assinatura é do corpo como chegou.
 *
 * Falha fechada: sem `META_APP_SECRET` ou com assinatura que não bate, 401 e
 * nada é lido do corpo. Com assinatura boa, o evento é gravado ANTES de
 * responder: é idempotente pelo `mid`, então um 500 (a Meta reentrega) não
 * duplica nada — e uma resposta 200 já significa "gravado".
 */
router.post('/', waWebhookLimiter, async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyMetaSignature(rawBody, req.get('x-hub-signature-256'), process.env.META_APP_SECRET)) {
    return res.sendStatus(401);
  }
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // Assinado e ilegível: reentregar não conserta, então 200 e segue.
    return res.sendStatus(200);
  }
  try {
    const { unknownPages } = await MessengerInboundService.process(body);
    if (unknownPages) console.warn(`[messenger] ${unknownPages} delivery entr${unknownPages === 1 ? 'y' : 'ies'} for unknown pages ignored`);
    return res.sendStatus(200);
  } catch (error) {
    console.error('[messenger] webhook processing failed:', error.message);
    return res.sendStatus(500);
  }
});

export default router;
