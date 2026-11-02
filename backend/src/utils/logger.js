import { randomUUID } from 'node:crypto';
import { currentContext, runInTenant } from '../config/tenantContext.js';

/**
 * One line per event, and the provider on every line.
 *
 * On a self-hosted install a log line belongs to the one ISP that owns the
 * box, so nobody had to say so. On a deployment shared by many, a line that
 * does not name its provider is a line nobody can act on: "GenieACS timed out"
 * is a page for somebody, and the somebody is the whole message. The provider
 * is read from the same context the queries read it from, so anything that
 * runs inside a request or a per-provider job carries it without being told.
 *
 * Two formats: `text` (logfmt-shaped, for a terminal and for journald) and
 * `json` (one object per line, for whatever collects the SaaS's logs). Chosen
 * by `LOG_FORMAT`, read per call so a test can flip it. `LOG_LEVEL` drops what
 * is below it; `debug` is off unless asked for.
 */
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function minimumLevel() {
  return LEVELS[String(process.env.LOG_LEVEL || '').toLowerCase()] ?? LEVELS.info;
}

function format() {
  return String(process.env.LOG_FORMAT || '').toLowerCase() === 'json' ? 'json' : 'text';
}

/** The provider in scope, or null. Never throws: a log line must not be what breaks a request. */
export function tenantInScope() {
  const context = currentContext();
  return Number.isInteger(context?.tenantId) ? context.tenantId : null;
}

// Where lines go. A test swaps this to read them back; the default is stdout
// for the quiet levels and stderr for the ones a supervisor should notice.
let sink = null;

export function setLogSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

function emit(level, line) {
  if (sink) return sink(line, level);
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

/**
 * O que nunca sai num log: credenciais e chaves, onde quer que apareçam.
 *
 * Duas frentes. Por NOME de campo — um objeto com `authorization`, `cookie`,
 * `password`, `token`, `apikey`, `secret`, chave Pix… tem o valor trocado por
 * `[REDACTED]` (só valores texto ou estruturas; um `tokenVersion: 3` ou um
 * `webhookSecretConfigured: true` não é segredo e fica). E por FORMA dentro de
 * texto — a mensagem de um erro de biblioteca costuma trazer o cabeçalho ou a
 * query inteira: `Bearer eyJ…`, `?access_token=…`, `"password":"…"`.
 *
 * O erro de um cliente HTTP (axios) é o caso que motivou: o objeto carrega
 * `config.headers.Authorization`, `config.data` com o corpo enviado e
 * `response.data` com o que voltou, e um `console.error(err)` imprimia tudo.
 * Nada é alterado no objeto original — quem loga recebe uma cópia limpa, e o
 * erro segue intacto para quem ainda vai tratá-lo.
 */
export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|apikey|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|auth[-_]?token|bearer|password|passwd|senha|current[-_]?password|new[-_]?password|secret|client[-_]?secret|webhook[-_]?secret|secret[-_]?key|private[-_]?key|access[-_]?key|pix[-_]?key|chave[-_]?pix|chavepix|address[-_]?key|totp[-_]?secret|mfa[-_]?secret|asaas-access-token|x-sgp-signature|x-signature|x-hub-signature-256|x-webhook-signature)$/i;

// `chave=valor` e `"chave": "valor"` dentro de texto. O nome da chave fica;
// só o valor some.
const SENSITIVE_PAIR = /(["']?\b(?:authorization|cookie|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|password|passwd|senha|secret|client[-_]?secret|pix[-_]?key|chave[-_]?pix|addressKey)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,&;}"']+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

export function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key));
}

/** O texto com credenciais visíveis mascaradas. */
export function redactText(text) {
  if (typeof text !== 'string' || text === '') return text;
  return text.replace(BEARER, `$1 ${REDACTED}`).replace(SENSITIVE_PAIR, `$1${REDACTED}`);
}

/** Valor que, sob uma chave sensível, é trocado: texto e estruturas, não flags nem contadores. */
function hidesUnderSensitiveKey(value) {
  return value !== null && value !== undefined && typeof value !== 'boolean' && typeof value !== 'number';
}

const MAX_DEPTH = 6;

function redactValue(value, depth, seen) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  // Buffers, datas e afins: não há campo a limpar.
  if (Buffer.isBuffer(value) || value instanceof Date || ArrayBuffer.isView(value)) return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Object]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, seen));

    // A cópia mantém o protótipo, para o `console` continuar mostrando
    // `AxiosError`/`AxiosHeaders` e a pilha como sempre mostrou.
    const proto = Object.getPrototypeOf(value);
    const plain = proto === Object.prototype || proto === null || value instanceof Error
      || proto?.constructor?.name === 'AxiosHeaders' || proto?.constructor?.name === 'Headers';
    if (!plain) {
      // Instância de outra classe (o `request` do axios, um socket, um Map):
      // copiar campo a campo é caro e sem sentido. No topo ela passa como
      // veio — é o objeto que alguém pediu para ver —; lá dentro vira
      // etiqueta, que é o que o `console` mostraria pela profundidade.
      return depth === 0 ? value : `[${proto?.constructor?.name || 'Object'}]`;
    }
    const out = Object.create(proto);
    if (value instanceof Error) {
      // `message` e `stack` não são enumeráveis; vão explicitamente.
      const hidden = (v) => ({ value: v, enumerable: false, writable: true, configurable: true });
      Object.defineProperty(out, 'message', hidden(redactText(String(value.message ?? ''))));
      if (value.stack) Object.defineProperty(out, 'stack', hidden(redactText(String(value.stack))));
      if (value.cause !== undefined) Object.defineProperty(out, 'cause', hidden(redactValue(value.cause, depth + 1, seen)));
    }
    for (const key of Object.keys(value)) {
      let item;
      try { item = value[key]; } catch { continue; }
      out[key] = isSensitiveKey(key) && hidesUnderSensitiveKey(item)
        ? REDACTED
        : redactValue(item, depth + 1, seen);
    }
    return out;
  } catch {
    return '[Unloggable]';
  } finally {
    seen.delete(value);
  }
}

/**
 * Uma cópia de `value` sem credenciais, pronta para ir a um log. Nunca lança e
 * nunca mexe no original.
 */
export function redactSecrets(value) {
  try {
    return redactValue(value, 0, new WeakSet());
  } catch {
    return '[Unloggable]';
  }
}

function describeError(error) {
  if (!(error instanceof Error)) return { err: redactText(String(error)) };
  const out = { err: redactText(error.message), errName: error.name };
  if (error.code) out.errCode = error.code;
  if (error.stack) out.stack = redactText(error.stack);
  return out;
}

/** logfmt quoting: bare when it is one safe token, double-quoted otherwise. */
function quote(value) {
  if (value === null || value === undefined) return '-';
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[A-Za-z0-9_./:@+-]*$/.test(text) && text !== '') return text;
  return JSON.stringify(text);
}

function normalizeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value instanceof Error) Object.assign(out, describeError(value));
    else if (value === undefined) continue;
    else if (isSensitiveKey(key) && hidesUnderSensitiveKey(value)) out[key] = REDACTED;
    else out[key] = redactSecrets(value);
  }
  return out;
}

/**
 * Writes one line. `fields` is a flat object; an `Error` anywhere in it is
 * spelled out as `err`, `errName`, `errCode` and, in text, its stack on the
 * following lines — where a person reads it — but inline in JSON, where a
 * machine does.
 */
export function logLine(level, msg, fields = {}) {
  if (!LEVELS[level] || LEVELS[level] < minimumLevel()) return;
  const time = new Date().toISOString();
  const tenant = tenantInScope();
  const data = normalizeFields(fields);

  if (format() === 'json') {
    emit(level, JSON.stringify({ time, level, tenant_id: tenant, msg: redactText(String(msg)), ...data }));
    return;
  }

  const { stack, ...rest } = data;
  const pairs = Object.entries(rest).map(([key, value]) => `${key}=${quote(value)}`);
  const head = `${time} ${level.toUpperCase().padEnd(5)} tenant=${tenant ?? '-'} ${redactText(String(msg))}`;
  const line = pairs.length ? `${head} ${pairs.join(' ')}` : head;
  emit(level, stack ? `${line}\n${stack}` : line);
}

export const log = Object.freeze({
  debug: (msg, fields) => logLine('debug', msg, fields),
  info: (msg, fields) => logLine('info', msg, fields),
  warn: (msg, fields) => logLine('warn', msg, fields),
  error: (msg, fields) => logLine('error', msg, fields)
});

/**
 * Tags the global `console` with the provider in scope.
 *
 * The codebase has a few hundred `console.*` calls that predate the log
 * module, and every one of them is right about what it says and silent about
 * whom it says it for. Rewriting them all would be a diff nobody could
 * review; wrapping the four methods once gives each existing line the same
 * `[tenant=N]` the structured lines carry, from the same context. Idempotent:
 * the second call finds the mark and leaves the wrap alone. Nothing is tagged
 * outside a context, so boot lines and tests look as they did.
 */
const WRAPPED = Symbol.for('skygenpanel.console.tenantTagged');

export function installTenantTaggedConsole(target = console) {
  if (target[WRAPPED]) return target;
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = target[method].bind(target);
    target[method] = (...args) => {
      // Cada argumento passa pela redação: é por aqui que sai o
      // `console.error('…', error)` das centenas de rotas, e o erro de um
      // cliente HTTP leva o cabeçalho `Authorization` e o corpo enviado.
      const limpos = args.map(redactSecrets);
      const tenant = tenantInScope();
      return tenant === null ? original(...limpos) : original(`[tenant=${tenant}]`, ...limpos);
    };
  }
  Object.defineProperty(target, WRAPPED, { value: true, enumerable: false });
  return target;
}

/**
 * Os caminhos que levam uma credencial num segmento — o link antigo do recibo
 * (`/api/public/receipt/<token>`), que o bot mandou antes de o token ir para
 * o fragmento. Enquanto esses links ainda abrem, o segmento sai do log como
 * `:token`: quem lê o log não ganha o recibo de ninguém.
 */
const CREDENTIAL_PATHS = [/^(\/api\/public\/receipt\/)[^/]+/];

/** O caminho com os segmentos de credencial trocados por `:token`. */
export function redactPath(path) {
  let limpo = String(path ?? '');
  for (const re of CREDENTIAL_PATHS) limpo = limpo.replace(re, '$1:token');
  return limpo;
}

/**
 * Express middleware: one `http` line per request, when the response ends.
 *
 * `path` is the URL without its query string, because a query is where a
 * caller puts a token when a header is inconvenient — and a path segment that
 * is a credential is masked too (`redactPath`). The provider is whatever
 * the request ended up scoped to — the host's answer, or the token's after
 * `authenticateToken` re-scoped it — and `-` when it was refused before
 * either. `host` rides along on the SaaS because it is how a person maps a
 * line back to a customer without looking the id up.
 *
 * Every request gets an id, echoed in `X-Request-Id`, so a screenshot of an
 * error and the line that produced it can be matched. Ours, never the
 * caller's: an id a client can choose is an id a client can collide.
 *
 * `/api/health` is skipped while it answers 200: a probe every thirty seconds
 * is not an event, but a probe that fails is.
 */
export function requestLogger({ skipPath = '/api/health' } = {}) {
  return function httpLog(req, res, next) {
    const started = process.hrtime.bigint();
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);

    res.on('finish', () => {
      const path = redactPath(String(req.originalUrl || req.url || '').split('?')[0]);
      if (path === skipPath && res.statusCode < 400) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const fields = {
        req: req.id,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        ip: req.ip ?? null,
        host: String(req.headers.host ?? '').split(':')[0] || null
      };
      // `finish` usually fires inside the context the route opened, because
      // the store follows the async chain that called `end()`. Usually is not
      // always — a response drained by the socket later ends elsewhere — so
      // the provider is taken off the request and the line written inside it,
      // the same `tenant=` every other line of that request carries.
      const level = res.statusCode >= 500 ? 'error' : 'info';
      const write = () => logLine(level, 'http', fields);
      if (Number.isInteger(req.tenantId)) runInTenant(req.tenantId, write);
      else write();
    });

    next();
  };
}
