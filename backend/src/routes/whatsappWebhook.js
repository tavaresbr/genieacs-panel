import express from 'express';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { runInTenant } from '../config/tenantContext.js';
import WhatsAppConfigService from '../services/whatsappConfigService.js';
import WaInboundService from '../services/waInboundService.js';
import { canonicalizarEvento } from '../utils/wa/waEventos.js';
import { pedidoAutorizado, tokenDaQuery, credencialDoPedido } from '../utils/wa/waWebhookAuth.js';
import { waWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * Quanto tempo entre dois registros de recusa da MESMA conta.
 *
 * A recusa precisa ficar visível — é ela que separa "o Evolution não está
 * chamando" de "está chamando e levando 401", dois problemas com consertos
 * opostos que hoje aparecem na tela como o mesmo "Nunca chegou nada". Mas esta
 * rota é pública, e gravar a cada recusa daria a quem souber o nome de uma
 * instância um jeito de fazer o painel escrever no banco em laço.
 *
 * Um minuto é curto o bastante para que a primeira recusa apareça enquanto o
 * operador ainda está olhando, e longo o bastante para que um servidor
 * reentregando em loop custe uma escrita por minuto.
 */
const REFUSAL_THROTTLE_MS = 60_000;

/**
 * Registra que um evento chegou e foi recusado.
 *
 * Nunca lança e nunca altera a resposta: isto é observabilidade pendurada num
 * caminho de recusa, e uma falha aqui não pode virar o motivo de um 500 numa
 * requisição que já estava decidida.
 */
async function registrarRecusa(account, reason) {
  try {
    const anterior = account.webhook_refused_at ? new Date(account.webhook_refused_at).getTime() : 0;
    if (Number.isFinite(anterior) && Date.now() - anterior < REFUSAL_THROTTLE_MS) return;
    await runInTenant(account.tenant_id, () => WhatsAppAccount.update(account.id, {
      webhook_refused_at: new Date(),
      webhook_refused_reason: reason
    }));
  } catch (error) {
    console.error('[wa] could not record webhook refusal:', error.message);
  }
}

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
  if (!autorizado) {
    // Antes da resposta e sem await no caminho crítico não daria: a escrita é
    // barata e estrangulada, e o servidor do outro lado está esperando de
    // qualquer forma. O que importa é que ela não altere o que se responde.
    await registrarRecusa(account, tokenDaQuery(req.query) ? 'bad_token' : 'no_credential');
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  const evento = canonicalizarEvento(body.event ?? body.Event ?? '');

  try {
    // The provider comes from the account the instance name resolved to, not
    // from whatever the request happened to be scoped to. Those are the same
    // thing while there is one provider; keeping them separate now is what
    // stops an event being filed under the wrong one later.
    const resultado = await runInTenant(
      account.tenant_id,
      () => WaInboundService.handle(account, evento, body)
    );
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
