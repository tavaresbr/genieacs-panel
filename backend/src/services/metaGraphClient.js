/**
 * O cliente da Graph API da Meta que o próprio painel usa — sem passar pelo
 * servidor Evolution, para o que o Evolution não sabe fazer: registrar o
 * webhook da conta WABA (`metaWebhookService.js`), a saúde do número oficial
 * (`metaNumberHealthService.js`) e editar e apagar modelo.
 *
 * O host é fixo, como o do Telegram (`telegramClient.js`): não passa pela
 * guarda de egresso dos endereços que vêm de dado. O token vai no cabeçalho,
 * nunca na URL, e nada daqui devolve a exceção do `fetch` nem a URL — a
 * recusa sai como `(<código>) <mensagem da Meta>`, que é o que a pessoa
 * precisa para corrigir, e não carrega o token de ninguém.
 */

export const GRAPH_BASE = 'https://graph.facebook.com';
/** A versão da Graph API; `META_GRAPH_VERSION` troca sem novo deploy de código. */
export const META_GRAPH_VERSION = /^v\d{1,3}\.\d{1,2}$/.test(String(process.env.META_GRAPH_VERSION || '').trim())
  ? String(process.env.META_GRAPH_VERSION).trim()
  : 'v21.0';
const GRAPH_TIMEOUT_MS = 10_000;
/** O tamanho das colunas de erro (`meta_webhook_error`, `meta_health_error`, `meta_templates_error`). */
export const GRAPH_ERROR_LIMIT = 255;
/** Os ids da Meta (WABA, número): só dígitos. Nada mais entra no caminho. */
export const META_ID = /^\d{5,32}$/;
/** Qualquer id numérico da Meta (inclusive o de modelo): só dígitos. */
const ANY_META_ID = /^\d{1,32}$/;

let fetcher = (...args) => fetch(...args);

/** Para os testes: a Graph falsa entra aqui. */
export function setMetaGraphFetcher(fn) {
  fetcher = fn || ((...args) => fetch(...args));
}

/** Se o valor serve de segmento de caminho na Graph (id numérico). */
export function isMetaId(value) {
  return ANY_META_ID.test(String(value ?? '').trim());
}

/** A recusa da Graph em texto curto: `(<código>) <mensagem>`, sem o token. */
export function graphRefusal(status, data) {
  const erro = data?.error;
  const mensagem = typeof erro?.error_user_msg === 'string' && erro.error_user_msg
    ? erro.error_user_msg
    : typeof erro?.message === 'string' ? erro.message : '';
  const codigo = erro?.code ?? status;
  const texto = mensagem ? `(${codigo}) ${mensagem}` : `meta_http_${status}`;
  return texto.slice(0, GRAPH_ERROR_LIMIT);
}

/**
 * Uma chamada à Graph. Nunca lança.
 *
 * @param {{ path: string, method?: string, metaToken?: string, token?: string,
 *           query?: Record<string, string>, body?: object }} p
 *   `path` sem a versão (ex. `/123/subscribed_apps`), já com ids conferidos;
 *   o token da Meta em `metaToken` (ou `token`, o mesmo).
 * @returns {Promise<{ ok: boolean, status: number, data: any, error: string|null }>}
 *   `error` é `meta_unreachable` quando a Meta nem respondeu; senão a recusa
 *   dela em texto curto. `data` é o JSON da resposta (ou `null`).
 */
export async function graphRequest({ path, method = 'GET', metaToken, token, query = null, body = undefined }) {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  let resposta;
  try {
    resposta = await fetcher(`${GRAPH_BASE}/${META_GRAPH_VERSION}${path}${qs}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${metaToken ?? token}`
      },
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
  if (resposta.ok && dados?.success !== false && !dados?.error) {
    return { ok: true, status: resposta.status, data: dados, error: null };
  }
  return { ok: false, status: resposta.status, data: dados, error: graphRefusal(resposta.status, dados) };
}

/**
 * Apaga um modelo na conta WABA: `DELETE /{waba}/message_templates?name=&hsm_id=`.
 * Com `hsm_id` a Meta apaga só aquele idioma; sem, todos os idiomas do nome —
 * por isso aqui ele é obrigatório.
 */
export async function deleteMetaTemplate({ wabaId, token, name, hsmId }) {
  if (!isMetaId(wabaId) || !isMetaId(hsmId) || !token || !name) {
    return { ok: false, status: 0, data: null, error: 'meta_invalid_request' };
  }
  return graphRequest({
    path: `/${String(wabaId).trim()}/message_templates`,
    method: 'DELETE',
    token,
    query: { name: String(name), hsm_id: String(hsmId).trim() }
  });
}

/**
 * Edita um modelo: `POST /{template_id}` com `components` e, quando cabe,
 * `category`. A Meta devolve `{ success: true }` e o modelo volta a PENDING.
 */
export async function editMetaTemplate({ templateId, token, components, category = null }) {
  if (!isMetaId(templateId) || !token) {
    return { ok: false, status: 0, data: null, error: 'meta_invalid_request' };
  }
  return graphRequest({
    path: `/${String(templateId).trim()}`,
    method: 'POST',
    token,
    body: { ...(category ? { category } : {}), components }
  });
}
