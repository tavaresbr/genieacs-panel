import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import {
  GRAPH_ERROR_LIMIT, META_GRAPH_VERSION, META_ID, graphRefusal, graphRequest, setMetaGraphFetcher
} from './metaGraphClient.js';

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
 * A chamada em si é do `metaGraphClient.js`: host fixo, token só no
 * cabeçalho, nada da exceção do `fetch` nem da URL volta para quem chamou.
 */

/** O tamanho da coluna `meta_webhook_error`. */
const ERROR_LIMIT = GRAPH_ERROR_LIMIT;

// Reexportados: o cliente da Graph mora em `metaGraphClient.js`, e quem já
// importava daqui (os testes) continua importando.
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
  if (!META_ID.test(waba) || !metaToken) return { ok: false, error: 'meta_webhook_invalid_account' };

  const resposta = await graphRequest({
    method: 'POST',
    path: `/${waba}/subscribed_apps`,
    metaToken,
    body: { override_callback_uri: callbackUrl, verify_token: verifyToken }
  });
  if (resposta.ok && resposta.data?.success !== false) return { ok: true, error: null };
  return { ok: false, error: resposta.error || graphRefusal(resposta.status, resposta.data) };
}

/** Os campos que a revisão dos modelos precisa — `rejected_reason` só vem se pedido. */
const TEMPLATE_STATUS_FIELDS = 'id,name,language,status,category,rejected_reason,quality_score';
const TEMPLATE_PAGE_SIZE = 200;
/** Teto de páginas: 1000 modelos numa WABA já é muito mais que o normal. */
const TEMPLATE_MAX_PAGES = 5;

/**
 * O status de cada modelo da conta WABA, direto na Graph API. Nunca lança.
 *
 * Existe porque o `/template/find` do Evolution chama a Graph sem `fields=`, e
 * sem isso ela não devolve `rejected_reason` — o motivo de uma recusa, que é
 * justamente o que o provedor precisa para corrigir o modelo. A lista em si
 * continua vindo do Evolution (é o caminho do envio e da criação); isto só
 * COMPLETA o motivo e a qualidade, e quem chama segue sem eles se falhar.
 *
 * Pagina pelo cursor `paging.cursors.after`, nunca pela URL `paging.next`: o
 * endereço é sempre o da Graph, e o token vai no cabeçalho de cada página.
 *
 * @param {{ wabaId: string, metaToken: string }} p
 * @returns {Promise<{ ok: true, templates: object[] } | { ok: false, error: string }>}
 */
export async function fetchTemplateStatuses({ wabaId, metaToken }) {
  const waba = String(wabaId ?? '').trim();
  if (!META_ID.test(waba) || !metaToken) return { ok: false, error: 'meta_webhook_invalid_account' };
  const templates = [];
  let depois = '';
  for (let pagina = 0; pagina < TEMPLATE_MAX_PAGES; pagina += 1) {
    const query = { fields: TEMPLATE_STATUS_FIELDS, limit: String(TEMPLATE_PAGE_SIZE) };
    if (depois) query.after = depois;
    // eslint-disable-next-line no-await-in-loop -- uma página depende da anterior
    const resposta = await graphRequest({ path: `/${waba}/message_templates`, metaToken, query });
    if (!resposta.ok) return { ok: false, error: resposta.error };
    if (!Array.isArray(resposta.data?.data)) {
      return { ok: false, error: graphRefusal(resposta.status, resposta.data) };
    }
    templates.push(...resposta.data.data);
    // Só o cursor da resposta segue adiante, nunca a URL `paging.next`: o
    // endereço continua sendo o nosso, com o token no cabeçalho.
    const cursor = resposta.data.paging?.next ? resposta.data.paging?.cursors?.after : '';
    if (typeof cursor !== 'string' || !cursor) break;
    depois = cursor;
  }
  return { ok: true, templates };
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
