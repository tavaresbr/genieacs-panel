/**
 * A saúde do GenieACS de cada provedor, e a única linha de log que a queda dele
 * merece.
 *
 * Antes disto, um ACS fora do ar (o DNS que não resolve, a porta fechada) virava
 * um stack trace inteiro em CADA leitura — a lista, o painel, a sonda de RX, o
 * prewarm, o SGP —, várias vezes por minuto, e o operador do provedor via só
 * "falha ao carregar". A causa existia, mas só para quem tinha SSH.
 *
 * Três coisas moram aqui:
 *
 * - `classifyAcsFailure`: a falha de transporte num conjunto FECHADO de
 *   códigos. Fechado de propósito: o código vai ao log, à API e à tela, e nada
 *   que venha da rede (mensagem, host) atravessa — só um destes oito.
 * - O estado por provedor, em memória: `ok`/`down`, desde quando, quantas falhas
 *   seguidas. Atualizado por `DirectConnector.request`, que é por onde toda
 *   conversa com a NBI passa (direto, túnel e agente).
 * - O log: uma linha por (provedor, código) a cada 5 min, e uma quando volta.
 *   Só o id numérico do provedor e o código fixo entram na linha — nem host,
 *   nem mensagem de erro, que vêm de URL configurada pelo provedor.
 */

import { tenantInScope } from '../../utils/logger.js';

export const ACS_FAILURE_CODES = Object.freeze([
  'dns', 'refused', 'timeout', 'tls', 'unauthorized', 'http_error', 'blocked', 'unknown'
]);

const CODES = new Set(ACS_FAILURE_CODES);

/** O código da API quando a rota falhou porque o ACS não responde. */
export const ACS_UNREACHABLE_CODE = 'acs_unreachable';

/** Os mesmos valores de `genieacsEgress.js`, repetidos para não criar ciclo de import. */
const EGRESS_REFUSED = 'GENIEACS_EGRESS_REFUSED';
export const GENIEACS_DNS_FAILED = 'GENIEACS_DNS_FAILED';

const LOG_WINDOW_MS = 5 * 60 * 1000;

const DNS_CODES = new Set([GENIEACS_DNS_FAILED, 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_SIGNATURE_FAILURE', 'HOSTNAME_MISMATCH', 'EPROTO'
]);
/** Transporte, mas sem código próprio na lista: `unknown`. */
const OTHER_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET'
]);

function fromHttpStatus(status) {
  const n = Number(status);
  if (n === 401 || n === 403) return 'unauthorized';
  if (n >= 500 && n <= 599) return 'http_error';
  return null;
}

function fromCode(code) {
  if (typeof code !== 'string' || !code) return null;
  if (code === EGRESS_REFUSED) return 'blocked';
  if (DNS_CODES.has(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (TLS_CODES.has(code) || /^ERR_(TLS|SSL)_/.test(code) || /^CERT_/.test(code)) return 'tls';
  if (OTHER_TRANSPORT_CODES.has(code)) return 'unknown';
  return null;
}

/** A última chance, para o erro que chegou sem código: a mensagem, mas só para escolher o código. */
function fromMessage(message) {
  const text = String(message ?? '');
  if (!text) return null;
  if (/did not resolve to any address|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'dns';
  if (/ECONNREFUSED|connection refused/i.test(text)) return 'refused';
  if (/ETIMEDOUT|timed out|timeout/i.test(text)) return 'timeout';
  if (/certificate|self[- ]signed|\bSSL\b|\bTLS\b/i.test(text)) return 'tls';
  const status = /GenieACS .*responded with status: (\d{3})/.exec(text);
  if (status) return fromHttpStatus(status[1]);
  if (/ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up/i.test(text)) return 'unknown';
  return null;
}

function classifyOne(error) {
  if (!error || typeof error !== 'object') return null;
  if (CODES.has(error.acsFailure)) return error.acsFailure;
  if (error.acsHttpStatus !== undefined) return fromHttpStatus(error.acsHttpStatus);
  const byCode = fromCode(error.code);
  if (byCode) return byCode;
  // O prazo nosso (`controller.abort()`) chega como `AbortError`; o
  // `AbortSignal.timeout` e o prazo do agente, como `TimeoutError`.
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout';
  if (error.name === 'AgentRequestError') return 'unknown';
  return null;
}

/**
 * A falha de transporte ou HTTP do ACS, num dos códigos de `ACS_FAILURE_CODES`;
 * `null` para o que não é isso — um erro de programação, um "não encontrado",
 * o agente desconectado (que tem código e tela próprios). É `null` que mantém
 * o stack trace nos chamadores: só a falha classificada vira linha curta.
 */
export function classifyAcsFailure(error) {
  if (!error || typeof error !== 'object') return null;
  // Os erros traduzíveis são respostas decididas pelo painel ("não é seu",
  // "agente desconectado"), não o ACS caindo.
  if (error.name === 'TranslatableError' || error.translationKey) {
    return CODES.has(error.acsFailure) ? error.acsFailure : null;
  }
  let atual = error;
  for (let i = 0; i < 4 && atual && typeof atual === 'object'; i += 1) {
    const code = classifyOne(atual);
    if (code) return code;
    atual = atual.cause;
  }
  return fromMessage(error.message);
}

/**
 * O código da falha do ACS que ESTE erro carrega — só se ele veio do ACS.
 *
 * `classifyAcsFailure` olha qualquer erro e reconhece um `ECONNREFUSED` venha
 * de onde vier; é o que o conector usa, porque lá se sabe que o pedido era ao
 * ACS. Quem está longe dele — o `catch` de um controlador, o tratador de erro
 * do app — não sabe: um `ECONNREFUSED` do SGP ou do SMTP não é o GenieACS fora.
 * Esta só aceita o erro marcado na origem: `acsFailure` (posto pelo egresso e
 * pelo conector, em todo modo) ou `acsHttpStatus` (posto por
 * `DeviceService.genieAcsError`), nele ou na sua `cause`.
 */
export function acsFailureOf(error) {
  let atual = error;
  for (let i = 0; i < 4 && atual && typeof atual === 'object'; i += 1) {
    if (CODES.has(atual.acsFailure)) return atual.acsFailure;
    if (atual.acsHttpStatus !== undefined) {
      const code = fromHttpStatus(atual.acsHttpStatus);
      if (code) return code;
    }
    atual = atual.cause;
  }
  return null;
}

/** A falha é do ACS (e já foi contada e logada pelo conector)? */
export function isAcsFailure(error) {
  return acsFailureOf(error) !== null;
}

// ---------------------------------------------------------------------------
// O estado por provedor.

/** `tenantId` → `{ key, status, code, since, lastCheckedAt, consecutiveFailures, announced }`. */
const health = new Map();
/** `<tenantId>|<code>` → quando a linha de queda saiu pela última vez. */
const lastLogged = new Map();

let clock = () => Date.now();
/** Trocado pelos testes para ler as linhas de volta; `null` é o `console.warn`. */
let logger = null;

/**
 * Uma linha, sempre com `[tenant=N]` na frente.
 *
 * O `console` do processo já põe esse prefixo sozinho quando há provedor em
 * escopo (`installTenantTaggedConsole`), e o conector chama isto DENTRO do
 * escopo — escrever o prefixo aqui também daria `[tenant=2] [tenant=2] …`.
 * Então ele só é escrito quando o console não vai escrever.
 */
function emit(tenantId, body) {
  const id = tenantLabel(tenantId);
  if (logger) {
    logger(`[tenant=${id}] ${body}`);
    return;
  }
  const consoleTagged = Boolean(console[Symbol.for('skygenpanel.console.tenantTagged')])
    && String(tenantInScope()) === id;
  console.warn(consoleTagged ? body : `[tenant=${id}] ${body}`);
}

function tenantLabel(tenantId) {
  const n = Number(tenantId);
  return Number.isSafeInteger(n) ? String(n) : '?';
}

function fresh(key) {
  return {
    key,
    status: 'ok',
    code: null,
    since: null,
    lastCheckedAt: null,
    consecutiveFailures: 0,
    announced: false
  };
}

/**
 * O estado do provedor PARA aquele endereço. Trocar a URL do ACS começa do
 * zero: a queda do endereço antigo não diz nada do novo.
 */
function stateFor(tenantId, key) {
  const id = Number(tenantId);
  let state = health.get(id);
  if (!state || state.key !== key) {
    state = fresh(key);
    health.set(id, state);
  }
  return state;
}

export function recordAcsSuccess(tenantId, key = '') {
  const id = Number(tenantId);
  if (!Number.isSafeInteger(id)) return;
  const state = stateFor(id, key);
  const agora = clock();
  if (state.status === 'down' && state.announced) {
    emit(id, 'GenieACS reachable again');
  }
  if (state.status !== 'ok' || state.since === null) state.since = agora;
  state.status = 'ok';
  state.code = null;
  state.lastCheckedAt = agora;
  state.consecutiveFailures = 0;
  state.announced = false;
}

export function recordAcsFailure(tenantId, key = '', code = 'unknown') {
  const id = Number(tenantId);
  if (!Number.isSafeInteger(id)) return;
  const codigo = CODES.has(code) ? code : 'unknown';
  const state = stateFor(id, key);
  const agora = clock();
  if (state.status !== 'down') {
    state.status = 'down';
    state.since = agora;
    state.consecutiveFailures = 0;
  }
  state.code = codigo;
  state.lastCheckedAt = agora;
  state.consecutiveFailures += 1;

  const chave = `${id}|${codigo}`;
  const ultima = lastLogged.get(chave);
  if (ultima === undefined || agora - ultima >= LOG_WINDOW_MS) {
    lastLogged.set(chave, agora);
    state.announced = true;
    emit(id, `GenieACS unreachable (${codigo}); further failures suppressed for 5 min`);
  }
}

/**
 * O que o conector chama ao fim de cada pedido à NBI. Uma resposta 401/403 ou
 * 5xx é o ACS respondendo mal; qualquer outra é o ACS alcançável.
 */
export function noteAcsResponse(tenantId, key, status) {
  const code = fromHttpStatus(status);
  if (code) recordAcsFailure(tenantId, key, code);
  else recordAcsSuccess(tenantId, key);
}

/** Idem, para o pedido que lançou. Erro que não é do ACS não muda a saúde. */
export function noteAcsError(tenantId, key, error) {
  const code = classifyAcsFailure(error);
  if (!code) return null;
  recordAcsFailure(tenantId, key, code);
  // A marca que os chamadores lá em cima reconhecem (`acsFailureOf`): o
  // agente, por exemplo, não passa pelo egresso que marcaria.
  if (error && typeof error === 'object' && !CODES.has(error.acsFailure)) {
    try { error.acsFailure = code; } catch { /* objeto congelado: fica sem a marca */ }
  }
  return code;
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/**
 * A saúde do ACS do provedor, para a API. Sem pedido nenhum ainda, `ok` com
 * `lastCheckedAt` nulo: não se sabe de queda nenhuma.
 *
 * `downForMs` vai junto porque quem decide "fora há mais de um minuto" é o
 * relógio do servidor — o do navegador pode estar adiantado.
 */
export function getAcsHealth(tenantId) {
  const state = health.get(Number(tenantId));
  if (!state) {
    return { status: 'ok', code: null, since: null, lastCheckedAt: null, consecutiveFailures: 0, downForMs: 0 };
  }
  const down = state.status === 'down';
  return {
    status: state.status,
    code: down ? state.code : null,
    since: iso(state.since),
    lastCheckedAt: iso(state.lastCheckedAt),
    consecutiveFailures: state.consecutiveFailures,
    downForMs: down && state.since !== null ? Math.max(0, clock() - state.since) : 0
  };
}

/**
 * O log de quem chamou o ACS e recebeu a falha de volta.
 *
 * A falha classificada já foi contada e logada — uma linha, espaçada — pelo
 * conector; repeti-la aqui, com stack, é o que enchia o journal. Tudo o que
 * NÃO é falha do ACS continua saindo como sempre (`console[level](label,
 * error)`, com stack), porque aí é bug nosso e o stack é o que resolve.
 *
 * Devolve o código quando calou, `null` quando logou.
 */
export function logUnlessAcsFailure(label, error, { level = 'error', messageOnly = false } = {}) {
  const code = acsFailureOf(error);
  if (code) return code;
  const write = level === 'warn' ? console.warn : console.error;
  if (messageOnly) write(`${label}: ${error?.message ?? error}`);
  else write(`${label}:`, error);
  return null;
}

/**
 * O corpo da resposta de uma rota que falhou porque o ACS não responde:
 * `acs_unreachable`, o sub-código em `reason` (o mesmo campo que o cliente já
 * repassa à tela) e a frase traduzida dele. Nada do erro original vai junto.
 */
export function acsUnreachableBody(t, code) {
  const reason = CODES.has(code) ? code : 'unknown';
  return {
    success: false,
    message: t(`device.acsUnreachable.${reason}`),
    code: ACS_UNREACHABLE_CODE,
    reason
  };
}

/**
 * O status HTTP dessa resposta: 502, o "o servidor de trás falhou". Os
 * chamadores antigos respondiam 500 ou 400 para a mesma queda, e a tela não
 * distingue um do outro — lê `code` e `message`.
 */
export const ACS_UNREACHABLE_STATUS = 502;

/** Só para os testes. */
export function resetAcsHealth({ now, log } = {}) {
  health.clear();
  lastLogged.clear();
  clock = now || (() => Date.now());
  logger = typeof log === 'function' ? log : null;
}
