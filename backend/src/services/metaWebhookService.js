import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { GRAPH_ERROR_LIMIT as ERROR_LIMIT, META_GRAPH_VERSION, graphRequest, setMetaGraphFetcher } from './metaGraphClient.js';

/**
 * O webhook de um número oficial registrado pelo próprio painel na Meta.
 *
 * A Meta entrega os eventos do número em `<servidor Evolution>/webhook/meta`,
 * e quem confere o token de verificação é o servidor Evolution — um token só
 * (`WA_BUSINESS_TOKEN_WEBHOOK`) para todos os números dele. Na SaaS esse
 * servidor é da plataforma, e o token era o mesmo para todos os provedores:
 * mostrá-lo a cada um, para ele colar no app dele na Meta, entregava a todos o
 * segredo de todos.
 *
 * Em vez disso, o painel registra o webhook na conta WABA pela Graph API
 * (`POST /{waba}/subscribed_apps` com `override_callback_uri` e
 * `verify_token`), com o token da Meta do próprio número. O token de
 * verificação vai do servidor do painel direto para a Meta, e o provedor não o
 * vê. A Meta confere a URL na hora (o desafio `hub.challenge`), então um
 * `success` aqui já é a prova de que a volta funciona.
 *
 * O host é fixo, como o do Telegram (`telegramClient.js`): não passa pela
 * guarda de egresso dos endereços que vêm de dado. O token vai no cabeçalho,
 * nunca na URL, e nada daqui devolve a exceção do `fetch` nem a URL.
 */

const WABA_ID = /^\d{5,32}$/;

// O cliente da Graph mora em `metaGraphClient.js`; os testes continuam
// trocando a Graph falsa por aqui.
export { META_GRAPH_VERSION, setMetaGraphFetcher };

/**
 * Registra o webhook da conta WABA na Meta. Nunca lança.
 *
 * @param {{ wabaId: string, metaToken: string, callbackUrl: string, verifyToken: string }} p
 * @returns {Promise<{ ok: true, error: null } | { ok: false, error: string }>}
 */
export async function subscribeWabaWebhook({ wabaId, metaToken, callbackUrl, verifyToken }) {
  // Sem URL ou sem token de verificação a Meta recusaria de qualquer jeito;
  // dizer por quê é mais útil que a recusa dela.
  if (!callbackUrl || !verifyToken) return { ok: false, error: 'meta_webhook_unconfigured' };
  const waba = String(wabaId ?? '').trim();
  if (!WABA_ID.test(waba) || !metaToken) return { ok: false, error: 'meta_webhook_invalid_account' };

  const r = await graphRequest({
    path: `/${waba}/subscribed_apps`,
    method: 'POST',
    token: metaToken,
    body: { override_callback_uri: callbackUrl, verify_token: verifyToken }
  });
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error };
}

class MetaWebhookService {
  /**
   * Registra o webhook do número e grava o resultado na linha. Nunca lança:
   * quem chama é a criação e a troca de token, e nenhuma das duas pode ser
   * desfeita porque a Meta recusou o webhook.
   *
   * @param {object} account a linha de `whatsapp_accounts`
   * @param {string} [metaToken] o token da Meta já em mãos; sem ele, o cifrado da linha
   */
  static async register(account, metaToken) {
    let result;
    try {
      const config = await WhatsAppConfigService.getConfig();
      result = await subscribeWabaWebhook({
        wabaId: account.meta_waba_id,
        metaToken: metaToken || WhatsAppConfigService.decryptInstanceToken(account),
        // A instância mora em `account.base_url`: é o `/webhook/meta` DELE que
        // a Meta tem de chamar, salvo URL publicada na configuração.
        callbackUrl: WhatsAppConfigService.cloudCallbackUrl(config, account.base_url),
        verifyToken: config.cloudVerifyToken || ''
      });
    } catch {
      result = { ok: false, error: 'meta_webhook_failed' };
    }
    let updated = account;
    try {
      updated = await WhatsAppAccount.update(account.id, {
        meta_webhook_status: result.ok ? 'ok' : 'error',
        meta_webhook_error: result.ok ? null : String(result.error).slice(0, ERROR_LIMIT),
        meta_webhook_at: new Date()
      });
    } catch {
      // A linha fica como estava; o resultado ainda volta para quem chamou.
    }
    return { ...result, account: updated };
  }

  /** "Registrar de novo", pela tela. 404 de outro provedor, 409 de número por QR. */
  static async retry(id) {
    const { default: EvolutionInstanceService } = await import('./evolutionInstanceService.js');
    const account = await EvolutionInstanceService.loadAccount(id);
    if (!WhatsAppAccount.isCloud(account)) {
      throw new WaError('whatsapp.error.notCloud', { code: 'not_cloud', status: 409 });
    }
    const result = await this.register(account);
    if (!result.ok) {
      throw new WaError('whatsapp.metaWebhook.failed', {
        code: 'meta_webhook_failed',
        status: 502,
        vars: { reason: result.error }
      });
    }
    return { account: result.account };
  }
}

export default MetaWebhookService;
