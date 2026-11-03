import AsaasWebhookService from '../services/asaasWebhookService.js';

/**
 * A entrega do webhook da conta Asaas do provedor. As respostas e o porquê de
 * cada uma estão no cabeçalho de `AsaasWebhookService`.
 */
class AsaasWebhookController {
  static async receive(req, res) {
    const token = req.headers['asaas-access-token'];

    let auth;
    try {
      auth = await AsaasWebhookService.authenticate(token);
    } catch (error) {
      console.error('Could not read the Asaas webhook configuration:', error.message);
      return res.status(503).json({ success: false, code: 'unavailable' });
    }
    if (auth.status === 'no_candidates') {
      return res.status(404).json({ success: false, code: 'webhook_disabled' });
    }
    if (auth.status !== 'ok') {
      // Panel-side only, e sem dizer qual parte falhou — nem de quem era o token.
      console.warn('Rejected an Asaas webhook delivery');
      return res.status(401).json({ success: false, code: 'invalid_token' });
    }

    try {
      const result = await AsaasWebhookService.apply(auth.tenantId, req.body);
      return res.json({ success: true, handled: result.handled });
    } catch (error) {
      // Falha genuína nossa: não-2xx para o gateway reentregar.
      console.error('Asaas webhook:', error.message);
      return res.status(500).json({ success: false, code: 'processing_failed' });
    }
  }
}

export default AsaasWebhookController;
