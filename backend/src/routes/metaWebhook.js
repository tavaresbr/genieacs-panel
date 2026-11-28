import express from 'express';
import MetaBridgeService from '../services/metaBridgeService.js';
import { verifyMetaSignature, safeEqual } from '../utils/messenger/messengerSignature.js';
import { bridgeAppSecret, bridgeConfigured, bridgeVerifyToken } from '../utils/wa/metaBridgeConfig.js';
import { metaWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * A ponte de eventos da Meta (modo sombra — ver `metaBridgeService.js`).
 *
 * Pública (quem chama é a Meta, não uma sessão) e montada com o corpo BRUTO, que
 * é o que a assinatura cobre. Desligada, ou sem algum dos requisitos, ela
 * responde 404 como se a rota não existisse: uma rota pública que aceita o que
 * não consegue conferir é pior que nenhuma.
 */
router.use((req, res, next) => (bridgeConfigured() ? next() : res.sendStatus(404)));

/**
 * Verificação do callback: a Meta faz um GET com `hub.verify_token` ao cadastrar
 * o endereço e espera o `hub.challenge` de volta, em texto puro. O token é o da
 * ponte (`META_WA_VERIFY_TOKEN`) e NÃO o do Evolution. Ele só prova que quem
 * cadastrou o endereço o conhece; quem autentica a ENTREGA é a assinatura.
 */
router.get('/', metaWebhookLimiter, (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe'
    && safeEqual(req.query['hub.verify_token'], bridgeVerifyToken());
  if (!ok) return res.sendStatus(403);
  // O desafio da Meta é um número. Só dígitos voltam: devolver o valor cru da
  // query seria refletir texto do chamador na resposta (XSS refletido).
  const challenge = String(req.query['hub.challenge'] ?? '');
  if (!/^\d{1,32}$/.test(challenge)) return res.sendStatus(400);
  return res.type('text/plain').send(challenge);
});

/**
 * Entrega de eventos. Falha fechada: sem assinatura válida, 401 e nada do corpo é
 * lido. Com ela, o corpo vai ao Evolution do número (`MetaBridgeService`); se o
 * Evolution não aceitou, 500 — e a Meta reenvia, como reenviaria se falasse com
 * ele direto.
 */
router.post('/', metaWebhookLimiter, async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const signature = String(req.get('x-hub-signature-256') ?? '');
  if (!verifyMetaSignature(rawBody, signature, bridgeAppSecret())) return res.sendStatus(401);
  try {
    const { status, ...detail } = await MetaBridgeService.handleDelivery(rawBody, signature);
    // O corpo diz o que houve, como no webhook do Evolution: sem ele, "encaminhou"
    // e "não conhecia o número" são o mesmo 200.
    return res.status(status).json({ success: status === 200, ...detail });
  } catch (error) {
    // Só o inesperado (o banco caiu): vale a reentrega da Meta.
    console.error('[meta-bridge] delivery failed:', error?.message || error);
    return res.status(500).json({ success: false, error: 'bridge_failed' });
  }
});

export default router;
