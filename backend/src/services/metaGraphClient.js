/**
 * O cliente da Graph API da Meta, um só para tudo o que o painel pede a ela
 * direto: o registro do webhook da conta WABA (`metaWebhookService.js`) e a
 * saúde do número oficial (`metaNumberHealthService.js`).
 *
 * O host é fixo, como o do Telegram (`telegramClient.js`): não passa pela
 * guarda de egresso dos endereços que vêm de dado. O token vai no cabeçalho,
 * nunca na URL, e nada daqui devolve a exceção do `fetch` nem a URL — uma
 * mensagem de erro gravada na linha ou mostrada na tela não pode carregar o
 * token de ninguém.
 */

export const GRAPH_BASE = 'https://graph.facebook.com';
/** A versão da Graph API; `META_GRAPH_VERSION` troca sem novo deploy de código. */
export const META_GRAPH_VERSION = /^v\d{1,3}\.\d{1,2}$/.test(String(process.env.META_GRAPH_VERSION || '').trim())
  ? String(process.env.META_GRAPH_VERSION).trim()
  : 'v21.0';
const GRAPH_TIMEOUT_MS = 10_000;
/** O tamanho das colunas de erro (`meta_webhook_error`, `meta_health_error`). */
export const GRAPH_ERROR_LIMIT = 255;
/** Os ids da Meta (WABA, número): só dígitos. Nada mais entra no caminho. */
export const META_ID = /^\d{5,32}$/;

let fetcher = (...args) => fetch(...args);

/** Para os testes: a Graph falsa entra aqui. */
export function setMetaGraphFetcher(fn) {
  fetcher = fn || ((...args) => fetch(...args));
}

/** A recusa da Graph em texto curto: `(<código>) <mensagem>`, sem o token. */
export function graphRefusal(status, data) {
  const erro = data?.error;
  const mensagem = typeof erro?.message === 'string' ? erro.message : '';
  const codigo = erro?.code ?? status;
  const texto = mensagem ? `(${codigo}) ${mensagem}` : `meta_http_${status}`;
  return texto.slice(0, GRAPH_ERROR_LIMIT);
}

/**
 * Uma chamada à Graph. Nunca lança.
 *
 * @param {{ method?: string, path: string, metaToken: string,
 *   query?: Record<string, string>, body?: object }} p `path` sem a versão,
 *   ex. `/123/subscribed_apps`; quem chama já validou os ids que vão nele
 * @returns {Promise<{ ok: boolean, status: number, data: any, error: string|null }>}
 */
export async function graphRequest({ method = 'GET', path, metaToken, query = null, body = undefined }) {
  const params = query ? new URLSearchParams(query).toString() : '';
  const url = `${GRAPH_BASE}/${META_GRAPH_VERSION}${path}${params ? `?${params}` : ''}`;
  const headers = { Authorization: `Bearer ${metaToken}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let resposta;
  try {
    resposta = await fetcher(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      redirect: 'manual'
    });
  } catch {
    return { ok: false, status: 0, data: null, error: 'meta_unreachable' };
  }
  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }
  if (resposta.ok && !dados?.error) return { ok: true, status: resposta.status, data: dados, error: null };
  return { ok: false, status: resposta.status, data: dados, error: graphRefusal(resposta.status, dados) };
}
