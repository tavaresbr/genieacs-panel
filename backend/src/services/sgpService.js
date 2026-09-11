import { randomBytes } from 'node:crypto';
import AppState from '../models/AppState.js';
import CustomerAccount from '../models/CustomerAccount.js';
import SgpLink from '../models/SgpLink.js';
import DeviceService from './deviceService.js';
import { createSecretBox } from '../utils/secretBox.js';
import { PinnedTransport, RESPONSE_TOO_LARGE } from '../utils/net/pinnedFetch.js';
import { IS_SAAS } from '../config/edition.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { TenantCache } from '../config/tenantCache.js';

const CONFIG_KEY = 'sgp_integration_config';
const SYNC_STATE_KEY = 'sgp_sync_last_run';
const CONFIG_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * How much of an SGP answer this process will hold in memory.
 *
 * There was no ceiling: `response.text()` on a raw `fetch` reads whatever the
 * far end sends, and the far end is an address the operator typed. The biggest
 * legitimate answer here is a contract's invoice list, which is kilobytes.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// A cached contract keeps plan, status and holder name frozen, so it is only
// trusted for a day before the next read refreshes it from the SGP.
const LINK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// The provider's SGP is a production billing system shared with the call
// centre, so a fleet sync never opens more than a handful of connections.
const SYNC_CONCURRENCY = 5;
// Same freshness rule the customer portal overview uses for "online".
const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const DIVERGENCE_LIMIT = 50;

// SGP exposes the URA (self-service) endpoints below on every provider
// instance. They stay configurable because deployments occasionally publish
// the integration under a custom prefix.
export const DEFAULT_ENDPOINTS = Object.freeze({
  customer: '/api/ura/consultacliente/',
  invoices: '/api/ura/titulos/',
  unlock: '/api/ura/liberacao/',
  ticket: '/api/ura/chamado/'
});

/**
 * The Tipo de Ocorrência a ticket is filed under when the operator has not set
 * one. 5 is the value SGP's own reference gives as the default; every install
 * still has its own catalogue, which is why it is configurable.
 */
export const DEFAULT_TICKET_OCCURRENCE_TYPE = 5;

export const LINK_MODES = Object.freeze(['pppoe', 'customer_id', 'manual']);

/** Public path SGP posts to. Fixed, so the Settings page can show it verbatim. */
export const WEBHOOK_PATH = '/api/sgp/events/webhook';

/** Normalized event vocabulary the dispatcher understands. */
export const EVENT_TYPES = Object.freeze([
  'payment_confirmed', 'unblocked', 'blocked', 'cancelled', 'activated',
  'contract_changed', 'unknown'
]);

/**
 * Maps what SGP calls an event onto that vocabulary. Both sides are compared
 * through `normalizeKey`, so accents, case and separators do not matter, and
 * an operator can extend the map from Settings when their install uses a
 * wording that is not covered here.
 */
export const DEFAULT_EVENT_TYPE_MAP = Object.freeze({
  pagamentoconfirmado: 'payment_confirmed',
  pagamento: 'payment_confirmed',
  pagamentorecebido: 'payment_confirmed',
  pago: 'payment_confirmed',
  baixatitulo: 'payment_confirmed',
  quitado: 'payment_confirmed',
  liberado: 'unblocked',
  liberacao: 'unblocked',
  liberacaoconfianca: 'unblocked',
  desbloqueado: 'unblocked',
  desbloqueio: 'unblocked',
  bloqueado: 'blocked',
  bloqueio: 'blocked',
  suspenso: 'blocked',
  suspensao: 'blocked',
  cancelado: 'cancelled',
  cancelamento: 'cancelled',
  rescindido: 'cancelled',
  rescisao: 'cancelled',
  encerrado: 'cancelled',
  ativado: 'activated',
  ativacao: 'activated',
  habilitado: 'activated',
  instalado: 'activated',
  instalacaoconcluida: 'activated',
  alteracaoplano: 'contract_changed',
  mudancaplano: 'contract_changed',
  planoalterado: 'contract_changed',
  trocaplano: 'contract_changed'
});

export const CONTRACT_STATES = Object.freeze(['active', 'blocked', 'cancelled', 'unknown']);

const CONTRACT_STATE_PATTERNS = Object.freeze({
  cancelled: /cancelad|encerrad|desativad|inativ/,
  blocked: /bloquead|suspens|inadimplen/,
  active: /ativo/
});

const tokenBox = createSecretBox('skygenpanel-sgp-token-v1');
// A separate context, so the webhook secret's ciphertext can never be read
// with the integration token's key.
const webhookSecretBox = createSecretBox('skygenpanel-sgp-webhook-secret-v1');

/**
 * The message is a translation key so the controller can answer in the
 * caller's language. Text SGP itself returned is passed through with
 * `raw: true`, since only the provider can phrase those.
 */
export class SgpError extends Error {
  constructor(message, { code = 'sgp_error', status = 502, details = null, vars = null, raw = false } = {}) {
    super(message);
    this.name = 'SgpError';
    this.code = code;
    this.status = status;
    this.details = details;
    if (!raw) {
      this.translationKey = message;
      this.translationVars = vars;
    }
  }
}

// SGP answers "no such customer" the same way it answers a real failure: a
// rejected status with a message. Telling them apart keeps a fleet sync from
// reporting every unregistered ONT as a provider error.
const NOT_FOUND_PATTERN = /nao encontrad|inexistente|not found|nenhum (cliente|contrato)|sem (cliente|contrato)/;

function isNotFound(error) {
  return error instanceof SgpError
    && error.code === 'sgp_rejected'
    && NOT_FOUND_PATTERN.test(stripAccents(error.message).toLowerCase());
}

function encryptToken(token) {
  return { v: 1, ...tokenBox.encrypt(token) };
}

function decryptToken(box) {
  return box ? (tokenBox.decrypt(box) ?? '') : '';
}

function encryptWebhookSecret(secret) {
  return { v: 1, ...webhookSecretBox.encrypt(secret) };
}

function decryptWebhookSecret(box) {
  return box ? (webhookSecretBox.decrypt(box) ?? '') : '';
}

function normalizeKey(key) {
  return String(key)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * A PPPoE login as something to compare, not to display.
 *
 * The two sides are written by different systems — one is what the ONT
 * reports, the other what the ERP stored — so case and stray spacing differ
 * between them routinely and mean nothing.
 */
function normalizeLogin(value) {
  return String(value ?? '').trim().toLowerCase();
}

// SGP field names differ between releases and between provider setups
// (`linhadigitavel`, `linha_digitavel`, `linhaDigitavel`), so every read goes
// through a normalized lookup instead of a fixed key.
function pick(source, names) {
  if (!source || typeof source !== 'object') return null;
  const index = new Map();
  for (const [key, value] of Object.entries(source)) {
    index.set(normalizeKey(key), value);
  }
  for (const name of names) {
    const value = index.get(normalizeKey(name));
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function asText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function asAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().replace(/[^\d,.-]/g, '');
  // Brazilian formatting arrives as 1.234,56 while the JSON API may send 1234.56.
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function asDate(value) {
  const text = asText(value);
  if (!text) return null;
  const brazilian = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brazilian) return `${brazilian[3]}-${brazilian[2]}-${brazilian[1]}`;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

/**
 * Like `asDate`, but keeps the time of day. Event payloads carry a moment, not
 * a due date, and SGP writes it as `DD/MM/YYYY HH:mm:ss`, as ISO, or as an
 * epoch, depending on where in the system it came from.
 */
function asDateTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epoch = value > 1e11 ? value : value * 1000;
    const parsed = new Date(epoch);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const text = asText(value);
  if (!text) return null;
  if (/^\d{9,13}$/.test(text)) return asDateTime(Number(text));
  const brazilian = text.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (brazilian) {
    const [, day, month, year, hour = '00', minute = '00', second = '00'] = brazilian;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function firstArray(payload, names) {
  const direct = pick(payload, names);
  if (Array.isArray(direct)) return direct;
  if (direct && typeof direct === 'object') return [direct];
  if (Array.isArray(payload)) return payload;
  return [];
}

// The PPPoE password is the one field of a contract that must never reach a
// browser: `normalizeContract` output is returned verbatim by the operator
// lookup endpoint. Reading it is therefore opt-in, and only provisioning asks.
/**
 * Where SGP keeps a subscriber's mobile number.
 *
 * Every install spells it differently and several return more than one, so the
 * read goes through the same normalized lookup as everything else. WhatsApp is
 * the only reason the panel wants this: it had no phone number anywhere before.
 */
const PHONE_NAMES = Object.freeze([
  'celular', 'telefonecelular', 'telefone_celular', 'fonecelular',
  'telefone', 'fone', 'telefone1', 'telefoneprincipal', 'telefonecontato',
  'whatsapp', 'celular1', 'phone', 'mobile'
]);

const PPPOE_PASSWORD_NAMES = Object.freeze([
  'senha', 'senhaPppoe', 'senha_pppoe', 'senhaPPPoE', 'senhaLogin', 'senhaAcesso',
  'senhaConexao', 'senhaUsuario', 'senhaRadius', 'password', 'pppoePassword',
  'pppoe_password', 'passwordPppoe', 'clave'
]);

function normalizeContract(entry, { includeSecrets = false } = {}) {
  const contract = asText(pick(entry, ['contrato', 'contratoId', 'idContrato', 'contract']));
  if (!contract) return null;
  return {
    contract,
    ...(includeSecrets
      ? { loginPassword: asText(pick(entry, PPPOE_PASSWORD_NAMES)) }
      : {}),
    status: asText(pick(entry, ['contratoStatus', 'status', 'situacao'])),
    statusLabel: asText(pick(entry, [
      'contratoStatusDisplay', 'statusDisplay', 'situacaoDisplay', 'statusDescricao'
    ])),
    plan: asText(pick(entry, ['planoInternet', 'plano', 'planoDescricao', 'servico'])),
    name: asText(pick(entry, ['razaoSocial', 'nome', 'nomeCliente', 'cliente'])),
    document: asText(pick(entry, ['cpfcnpj', 'cpfCnpj', 'documento'])),
    address: asText(pick(entry, ['endereco', 'enderecoCompleto', 'contratoEndereco'])),
    login: asText(pick(entry, ['login', 'usuario', 'pppoe', 'loginPppoe'])),
    // Normalized to sendable digits here rather than at send time, so a cadastre
    // that stores "(93) 98111-0449" and one that stores "5593981110449" reach
    // the outbox as the same value. The ninth digit is never invented — see
    // utils/wa/waDestino.js for why guessing it addresses a stranger.
    phone: normalizarTelefoneBr(pick(entry, PHONE_NAMES)) || null,
    blocked: (() => {
      const value = pick(entry, ['bloqueado', 'contratoBloqueado', 'bloqueio']);
      if (value === null) return null;
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'sim', 's'].includes(String(value).trim().toLowerCase());
    })()
  };
}

function stripAccents(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Every install words its contract statuses differently, so the panel derives a
// stable state instead of grouping by the label itself. The order of the checks
// is the whole point: a cancellation is matched first because "Inativo" and
// "Desativado" contain "ativo", and an explicit `bloqueado` flag outranks a
// label that still reads "Ativo". The two fields are matched separately, never
// concatenated, so no pattern can straddle the boundary between them.
function deriveContractState(contract) {
  const labels = [contract?.statusLabel, contract?.status].map(stripAccents);
  const matches = (pattern) => labels.some((label) => pattern.test(label));
  if (matches(CONTRACT_STATE_PATTERNS.cancelled)) return 'cancelled';
  if (contract?.blocked === true || matches(CONTRACT_STATE_PATTERNS.blocked)) return 'blocked';
  if (matches(CONTRACT_STATE_PATTERNS.active)) return 'active';
  return 'unknown';
}

function normalizeInvoice(entry) {
  const dueDate = asDate(pick(entry, ['vencimento', 'dataVencimento', 'datavencimento', 'dueDate']));
  const paidAt = asDate(pick(entry, ['dataPagamento', 'datapagamento', 'pagamento']));
  return {
    id: asText(pick(entry, ['numerodocumento', 'numeroDocumento', 'id', 'titulo', 'documento'])),
    description: asText(pick(entry, ['descricaomodelo', 'descricao', 'observacao', 'modelo'])),
    amount: asAmount(pick(entry, ['valor', 'valordocumento', 'valorDocumento', 'valorTotal'])),
    dueDate,
    paidAt,
    status: asText(pick(entry, ['status', 'situacao', 'statusDisplay'])),
    digitableLine: asText(pick(entry, ['linhadigitavel', 'linhaDigitavel', 'linha'])),
    barcode: asText(pick(entry, ['codigodebarras', 'codigoBarras', 'barras'])),
    link: asText(pick(entry, ['link', 'linkboleto', 'linkBoleto', 'url', 'urlBoleto'])),
    pix: asText(pick(entry, ['pix', 'pixCopiaECola', 'pixcopiaecola', 'qrcodePix', 'qrcode'])),
    paid: (() => {
      const status = asText(pick(entry, ['status', 'situacao', 'statusDisplay']));
      if (paidAt) return true;
      return status ? /pago|quitad|liquidad/i.test(status) : false;
    })()
  };
}

function maskDocument(document) {
  const digits = String(document ?? '').replace(/\D/g, '');
  if (digits.length < 5) return null;
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * Operator-supplied additions to the event vocabulary. Keys are normalized the
 * same way the payload's type is, so `Pagamento Confirmado` and
 * `pagamento_confirmado` are one entry, and an unknown target type is dropped
 * rather than silently routing an event to a handler that does not exist.
 */
function normalizeEventTypeMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const map = {};
  for (const [key, target] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key);
    const normalizedTarget = String(target ?? '').trim();
    if (!normalizedKey || !EVENT_TYPES.includes(normalizedTarget)) continue;
    map[normalizedKey] = normalizedTarget;
  }
  return map;
}

/**
 * Event payloads may put the interesting fields at the top level or nest them
 * under a wrapper. Every lookup walks these scopes in order, so one shape does
 * not have to be guessed correctly up front.
 */
function candidateScopes(body) {
  if (!body || typeof body !== 'object') return [];
  const scopes = [body];
  for (const key of ['dados', 'data', 'payload', 'evento', 'contrato', 'contract', 'cliente', 'customer']) {
    const nested = body[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) scopes.push(nested);
  }
  return scopes;
}

function pickScoped(scopes, names) {
  for (const scope of scopes) {
    const value = pick(scope, names);
    if (value !== null) return value;
  }
  return null;
}

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  baseUrl: '',
  app: '',
  linkMode: 'pppoe',
  portalBilling: true,
  portalUnlock: false,
  invoiceLimit: 6,
  ticketEnabled: false,
  ticketOccurrenceType: DEFAULT_TICKET_OCCURRENCE_TYPE,
  endpoints: DEFAULT_ENDPOINTS,
  webhookEnabled: false,
  webhookRequireTimestamp: false,
  webhookToleranceSeconds: 300,
  reconcileEnabled: false,
  reconcileIntervalMinutes: 15,
  reconcileBatchSize: 25,
  eventRetentionDays: 90,
  eventTypeMap: {}
});

/**
 * The one way this module reaches the SGP.
 *
 * `baseUrl` is request data: it arrives in the body of `POST /api/sgp/test`,
 * behind the `sgp.config` permission that every provider admin holds — and on
 * a multi-provider deployment that admin is a TENANT, not the host operator.
 * It used to go straight into a bare `fetch` with no address check, no
 * redirect policy and no ceiling on the body, and `SgpController.testConnection`
 * hands the far end's own message back to the caller. Pointed at an internal
 * service, the probe answered with that service's response body.
 *
 * So it goes through the shared transport instead, which resolves with the
 * resolver the socket will use, refuses the address classes in
 * `utils/net/blockedRanges.js`, connects only to the address it vetted, and
 * stops reading at `MAX_RESPONSE_BYTES`. Nothing follows a redirect: a 3xx
 * arrives as an ordinary not-ok answer, so an SGP that answers 302 towards
 * somewhere else cannot move the request there.
 *
 * The address classes are refused on the SaaS edition only, for the same reason
 * `genieacsEgress` does the same: a self-hosted install runs its SGP on the
 * operator's own LAN, a private address is the normal case there, and the
 * person who typed the URL owns the box. The pinning and the ceiling apply in
 * both editions — one transport that behaves the same everywhere.
 *
 * Used by every SGP call, not just the probe: the portal's billing lookups and
 * the reconcile job go through `SgpService.request` too.
 */
async function sgpFetch(url, { headers, body, signal }) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    throw new SgpError('sgp.error.urlInvalid', { code: 'invalid_base_url', status: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SgpError('sgp.error.urlScheme', { code: 'invalid_base_url', status: 400 });
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  // The refusal names nothing it learned. `genieacsEgress` quotes the address
  // it refused because its reader is the operator of the whole deployment;
  // here the reader is one tenant of it, and "resolves to 10.0.0.5" would be
  // the panel mapping its own private network on request.
  // O `signal` vale para a RESOLUÇÃO também, e não só para a requisição abaixo.
  // O prazo de 15 s é armado em `request` com um AbortController, mas ele só
  // alcança o que já começou: um resolvedor que aceita a consulta e nunca
  // responde prende quem chamou antes de existir socket para abortar, e a
  // chamada passa dos 15 s sem que nada a encerre. É o mesmo prazo que o
  // `safeFetch` já estende à resolução, pelo mesmo motivo — aqui pesa mais,
  // porque na edição SaaS o `baseUrl` é escolhido pelo administrador do
  // provedor, e as consultas de fatura do portal e o job de reconciliação
  // passam por aqui.
  //
  // Ele limita a ESPERA, não a consulta: `getaddrinfo` não tem `cancel()`, então
  // o aborto solta quem chamou e deixa a consulta terminar no vazio. Prender
  // quem chamou é o dano que o prazo existe para evitar.
  const addresses = await PinnedTransport.vetTarget(hostname, {
    signal,
    allowPrivateAddresses: !IS_SAAS,
    refuse: () => new SgpError('sgp.error.blockedHost', { code: 'blocked_host', status: 400 })
  });
  // O prazo pode ter vencido DENTRO da resolução acima, e aí o motivo de parar é
  // ele: sem esta linha um nome que não respondeu a tempo sairia daqui como
  // `unreachable`, que é uma frase sobre a rede para um problema de relógio.
  signal?.throwIfAborted();
  if (addresses.length === 0) {
    throw new SgpError('sgp.error.unreachable', { code: 'unreachable', status: 502 });
  }

  return PinnedTransport.request({
    url: parsed,
    hostname,
    addresses,
    method: 'POST',
    headers,
    body,
    signal,
    maxBytes: MAX_RESPONSE_BYTES
  });
}

const MIN_RECONCILE_INTERVAL_MINUTES = 5;

class SgpService {
  static configCache = new TenantCache(CONFIG_CACHE_TTL_MS);

  /**
   * Quanto uma chamada ao SGP pode levar, da resolução do nome ao último byte.
   *
   * Campo de classe, e lido por `this`, pelo mesmo motivo que `ALLOWED_PORTS`
   * em `genieacsEgress`: o limite que a classe anuncia é o limite que ela
   * aplica, e um teste consegue provar o prazo sem esperar quinze segundos.
   */
  static REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

  /**
   * Forget the provider in scope — its own configuration changed.
   * To forget every provider's, reach for `configCache.clear()`; that is a
   * reset, not a save, and the two must not share a name.
   */
  static invalidateConfigCache() {
    this.configCache.invalidate();
  }

  static normalizeBaseUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    let url;
    try {
      url = new URL(text.includes('://') ? text : `https://${text}`);
    } catch {
      throw new SgpError('sgp.error.urlInvalid', {
        code: 'invalid_base_url',
        status: 400
      });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new SgpError('sgp.error.urlScheme', {
        code: 'invalid_base_url',
        status: 400
      });
    }
    if (url.username || url.password) {
      throw new SgpError('sgp.error.urlCredentials', {
        code: 'invalid_base_url',
        status: 400
      });
    }
    url.search = '';
    url.hash = '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }

  static normalizeEndpoint(value, fallback) {
    const text = String(value ?? '').trim();
    if (!text) return fallback;
    if (/^https?:\/\//i.test(text) || text.includes('..')) {
      throw new SgpError('sgp.error.pathsRelative', {
        code: 'invalid_endpoint',
        status: 400
      });
    }
    return text.startsWith('/') ? text : `/${text}`;
  }

  static async readStoredConfig() {
    const raw = await AppState.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG, token: null };
    try {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        endpoints: { ...DEFAULT_ENDPOINTS, ...(parsed.endpoints || {}) }
      };
    } catch {
      return { ...DEFAULT_CONFIG, token: null };
    }
  }

  static async getConfig() {
    const cached = this.configCache.get();
    if (cached) return cached;
    const stored = await this.readStoredConfig();
    const config = {
      enabled: stored.enabled === true,
      baseUrl: String(stored.baseUrl || ''),
      app: String(stored.app || ''),
      token: decryptToken(stored.token),
      linkMode: LINK_MODES.includes(stored.linkMode) ? stored.linkMode : 'pppoe',
      portalBilling: stored.portalBilling !== false,
      portalUnlock: stored.portalUnlock === true,
      invoiceLimit: Number(stored.invoiceLimit) > 0 ? Math.min(Number(stored.invoiceLimit), 24) : 6,
      endpoints: { ...DEFAULT_ENDPOINTS, ...(stored.endpoints || {}) },
      webhookSecret: decryptWebhookSecret(stored.webhookSecret),
      webhookEnabled: stored.webhookEnabled === true,
      webhookRequireTimestamp: stored.webhookRequireTimestamp === true,
      webhookToleranceSeconds: clampNumber(stored.webhookToleranceSeconds, 30, 3600, 300),
      reconcileEnabled: stored.reconcileEnabled === true,
      reconcileIntervalMinutes: clampNumber(
        stored.reconcileIntervalMinutes, MIN_RECONCILE_INTERVAL_MINUTES, 1440, 15
      ),
      reconcileBatchSize: clampNumber(stored.reconcileBatchSize, 1, 200, 25),
      eventRetentionDays: clampNumber(stored.eventRetentionDays, 1, 365, 90),
      eventTypeMap: normalizeEventTypeMap(stored.eventTypeMap),
      ticketEnabled: stored.ticketEnabled === true,
      ticketOccurrenceType: clampNumber(
        stored.ticketOccurrenceType, 1, 999999, DEFAULT_TICKET_OCCURRENCE_TYPE
      ),
      updatedAt: stored.updatedAt || null
    };
    this.configCache.set(config);
    return config;
  }

  static async getPublicConfig() {
    const config = await this.getConfig();
    const { token, webhookSecret, ...rest } = config;
    return {
      ...rest,
      tokenConfigured: Boolean(token),
      webhookSecretConfigured: Boolean(webhookSecret),
      webhookPath: WEBHOOK_PATH,
      ready: this.isReady(config)
    };
  }

  static isReady(config) {
    return Boolean(config.enabled && config.baseUrl && config.app && config.token);
  }

  static requireReady(config) {
    if (!this.isReady(config)) {
      throw new SgpError('sgp.error.notConfigured', {
        code: 'not_configured',
        status: 409
      });
    }
    return config;
  }

  static async saveConfig(patch = {}) {
    const current = await this.getConfig();
    const next = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      baseUrl: patch.baseUrl === undefined
        ? current.baseUrl
        : this.normalizeBaseUrl(patch.baseUrl),
      app: patch.app === undefined ? current.app : String(patch.app).trim().slice(0, 128),
      linkMode: LINK_MODES.includes(patch.linkMode) ? patch.linkMode : current.linkMode,
      portalBilling: patch.portalBilling === undefined
        ? current.portalBilling
        : patch.portalBilling === true,
      portalUnlock: patch.portalUnlock === undefined
        ? current.portalUnlock
        : patch.portalUnlock === true,
      invoiceLimit: patch.invoiceLimit === undefined
        ? current.invoiceLimit
        : Math.min(Math.max(Number(patch.invoiceLimit) || 6, 1), 24),
      webhookEnabled: patch.webhookEnabled === undefined
        ? current.webhookEnabled
        : patch.webhookEnabled === true,
      webhookRequireTimestamp: patch.webhookRequireTimestamp === undefined
        ? current.webhookRequireTimestamp
        : patch.webhookRequireTimestamp === true,
      webhookToleranceSeconds: patch.webhookToleranceSeconds === undefined
        ? current.webhookToleranceSeconds
        : clampNumber(patch.webhookToleranceSeconds, 30, 3600, 300),
      reconcileEnabled: patch.reconcileEnabled === undefined
        ? current.reconcileEnabled
        : patch.reconcileEnabled === true,
      reconcileIntervalMinutes: patch.reconcileIntervalMinutes === undefined
        ? current.reconcileIntervalMinutes
        : clampNumber(patch.reconcileIntervalMinutes, MIN_RECONCILE_INTERVAL_MINUTES, 1440, 15),
      reconcileBatchSize: patch.reconcileBatchSize === undefined
        ? current.reconcileBatchSize
        : clampNumber(patch.reconcileBatchSize, 1, 200, 25),
      eventRetentionDays: patch.eventRetentionDays === undefined
        ? current.eventRetentionDays
        : clampNumber(patch.eventRetentionDays, 1, 365, 90),
      eventTypeMap: patch.eventTypeMap === undefined
        ? current.eventTypeMap
        : normalizeEventTypeMap(patch.eventTypeMap),
      ticketEnabled: patch.ticketEnabled === undefined
        ? current.ticketEnabled
        : patch.ticketEnabled === true,
      // The upper bound is generous on purpose: this is an id in the install's
      // own catalogue, not an enum we get to define.
      ticketOccurrenceType: patch.ticketOccurrenceType === undefined
        ? current.ticketOccurrenceType
        : clampNumber(patch.ticketOccurrenceType, 1, 999999, DEFAULT_TICKET_OCCURRENCE_TYPE),
      endpoints: {
        customer: this.normalizeEndpoint(
          patch.endpoints?.customer ?? current.endpoints.customer, DEFAULT_ENDPOINTS.customer
        ),
        invoices: this.normalizeEndpoint(
          patch.endpoints?.invoices ?? current.endpoints.invoices, DEFAULT_ENDPOINTS.invoices
        ),
        unlock: this.normalizeEndpoint(
          patch.endpoints?.unlock ?? current.endpoints.unlock, DEFAULT_ENDPOINTS.unlock
        ),
        ticket: this.normalizeEndpoint(
          patch.endpoints?.ticket ?? current.endpoints.ticket, DEFAULT_ENDPOINTS.ticket
        )
      },
      updatedAt: new Date().toISOString()
    };

    // An omitted token keeps the stored secret; an explicit empty string clears
    // it so an operator can revoke the integration without wiping the setup.
    let token = current.token;
    if (patch.token !== undefined) {
      token = String(patch.token).trim();
    }

    if (next.enabled && (!next.baseUrl || !next.app || !token)) {
      throw new SgpError('sgp.error.configIncomplete', {
        code: 'incomplete_config',
        status: 400
      });
    }

    // Same semantics as the token: omitted keeps the stored secret, an empty
    // string clears it. The secret is only ever set through the rotate action.
    let webhookSecret = current.webhookSecret;
    if (patch.webhookSecret !== undefined) {
      webhookSecret = String(patch.webhookSecret).trim();
    }

    if (next.webhookEnabled && !webhookSecret) {
      throw new SgpError('sgp.error.webhookSecretRequired', {
        code: 'webhook_secret_required',
        status: 400
      });
    }

    await AppState.upsert(CONFIG_KEY, JSON.stringify({
      ...next,
      token: token ? encryptToken(token) : null,
      webhookSecret: webhookSecret ? encryptWebhookSecret(webhookSecret) : null
    }));
    this.invalidateConfigCache();
    return this.getPublicConfig();
  }

  /**
   * Maps an arbitrary SGP event body onto the internal vocabulary. Nothing
   * about the payload shape is assumed: the type may be called `evento`,
   * `tipo`, `acao` or `status`, and the fields may be nested one level down.
   * An unrecognised event is deliberately returned as `unknown` rather than
   * dropped, so an operator can read the stored body and add a mapping.
   */
  static normalizeEvent(body, typeMap = {}) {
    const scopes = candidateScopes(body);
    const rawType = asText(pickScoped(scopes, [
      'evento', 'event', 'eventType', 'tipo', 'tipoEvento', 'type',
      'acao', 'action', 'ocorrencia', 'status', 'situacao'
    ]));
    const merged = { ...DEFAULT_EVENT_TYPE_MAP, ...normalizeEventTypeMap(typeMap) };
    const type = rawType ? (merged[normalizeKey(rawType)] ?? 'unknown') : 'unknown';
    const document = asText(pickScoped(scopes, ['cpfcnpj', 'cpfCnpj', 'documento', 'document']));
    return {
      type,
      rawType,
      contract: asText(pickScoped(scopes, ['contrato', 'contratoId', 'idContrato', 'contract'])),
      document: document ? document.replace(/\D/g, '').slice(0, 32) || null : null,
      login: asText(pickScoped(scopes, ['login', 'usuario', 'pppoe', 'loginPppoe'])),
      occurredAt: asDateTime(pickScoped(scopes, [
        'data', 'dataEvento', 'dataHora', 'datahora', 'timestamp', 'occurredAt', 'criadoEm'
      ])),
      eventId: asText(pickScoped(scopes, [
        'id', 'eventoId', 'evento_id', 'eventId', 'uuid', 'notificacaoId', 'protocolo'
      ]))
    };
  }

  /**
   * Generates a new webhook secret and returns it once. Nothing else ever
   * hands the plaintext back, so an operator who loses it must rotate again.
   */
  static async rotateWebhookSecret() {
    const secret = randomBytes(32).toString('hex');
    await this.saveConfig({ webhookSecret: secret });
    return secret;
  }

  static async request(endpointKey, payload = {}, configOverride = null) {
    const config = this.requireReady(configOverride || await this.getConfig());

    const endpoint = config.endpoints[endpointKey] || DEFAULT_ENDPOINTS[endpointKey];
    const url = `${config.baseUrl}${endpoint}`;
    const body = { app: config.app, token: config.token, ...payload };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await sgpFetch(url, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      // A refusal `sgpFetch` raised is already the right answer, and it is
      // deliberately vague. Falling through to `unreachable` below would
      // relabel it AND copy its text into `details`, which the controller
      // reflects — the exact shape this guard exists to close.
      if (error instanceof SgpError) throw error;
      if (error.name === 'AbortError' || controller.signal.aborted) {
        throw new SgpError('sgp.error.timeout', {
          code: 'timeout',
          status: 504
        });
      }
      if (error.code === RESPONSE_TOO_LARGE) {
        throw new SgpError('sgp.error.invalidResponse', {
          code: 'invalid_response',
          status: 502
        });
      }
      throw new SgpError('sgp.error.unreachable', {
        code: 'unreachable',
        status: 502,
        details: error.message
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const text = await response.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (response.status === 401 || response.status === 403) {
      throw new SgpError('sgp.error.credentialsRejected', {
        code: 'unauthorized',
        status: 502
      });
    }
    if (!response.ok) {
      throw new SgpError('sgp.error.status', {
        vars: { status: response.status },
        code: 'http_error',
        status: 502,
        details: asText(pick(data || {}, ['msg', 'mensagem', 'message', 'erro'])) || undefined
      });
    }
    if (data === null) {
      throw new SgpError('sgp.error.invalidResponse', {
        code: 'invalid_response',
        status: 502
      });
    }

    const statusFlag = pick(data, ['status']);
    const message = asText(pick(data, ['msg', 'mensagem', 'message', 'erro']));
    const failed = statusFlag !== null &&
      ['0', 'erro', 'error', 'false'].includes(String(statusFlag).trim().toLowerCase());
    if (failed) {
      throw new SgpError(message || 'sgp.error.queryFailed', {
        code: 'sgp_rejected',
        status: 502,
        raw: Boolean(message)
      });
    }

    return data;
  }

  static buildLookupPayload({ document, contract, login } = {}) {
    const payload = {};
    const cleanDocument = String(document ?? '').replace(/\D/g, '');
    if (cleanDocument) payload.cpfcnpj = cleanDocument;
    const cleanContract = asText(contract);
    if (cleanContract) payload.contrato = cleanContract;
    const cleanLogin = asText(login);
    if (cleanLogin) payload.login = cleanLogin;
    if (Object.keys(payload).length === 0) {
      throw new SgpError('sgp.error.identifierRequired', {
        code: 'missing_filter',
        status: 400
      });
    }
    return payload;
  }

  static async lookupCustomer(filters, configOverride = null, { includeSecrets = false } = {}) {
    const data = await this.request(
      'customer',
      this.buildLookupPayload(filters),
      configOverride
    );
    const contracts = firstArray(data, ['contratos', 'contrato', 'dados', 'data', 'clientes'])
      .map((entry) => normalizeContract(entry, { includeSecrets }))
      .filter(Boolean);
    return {
      contracts,
      message: asText(pick(data, ['msg', 'mensagem', 'message']))
    };
  }

  /**
   * A contract without its secret, for anything that leaves the process.
   * `lookupContractForProvisioning` is the only source of a contract that
   * carries `loginPassword`, and this is how that value is dropped again.
   */
  static publicContract(contract) {
    if (!contract) return null;
    const { loginPassword, ...rest } = contract;
    return rest;
  }

  /**
   * Contract lookup for the provisioning path, which is the only caller allowed
   * to read the PPPoE password. The result must never be returned by a route,
   * written to `sgp_links`, or logged.
   */
  static async lookupContractForProvisioning(filters, configOverride = null) {
    const { contracts } = await this.lookupCustomer(filters, configOverride, { includeSecrets: true });
    return this.pickContract(contracts, filters?.contract ?? null);
  }

  static async listInvoices({ contract, document, onlyOpen = true, limit } = {}) {
    const config = await this.getConfig();
    const payload = this.buildLookupPayload({ contract, document });
    payload.limit = Math.min(Math.max(Number(limit) || config.invoiceLimit, 1), 24);
    if (onlyOpen) {
      payload.apenas_titulos_em_aberto = true;
    }
    const data = await this.request('invoices', payload, config);
    const invoices = firstArray(data, ['titulos', 'titulo', 'faturas', 'dados', 'data'])
      .map((entry) => normalizeInvoice(entry))
      .filter((invoice) => invoice.amount !== null || invoice.dueDate || invoice.id)
      // Not every SGP install honours the "open only" flag, so settled
      // invoices are dropped here as well.
      .filter((invoice) => !onlyOpen || !invoice.paid);
    invoices.sort((left, right) => String(left.dueDate || '').localeCompare(String(right.dueDate || '')));
    return {
      invoices,
      message: asText(pick(data, ['msg', 'mensagem', 'message']))
    };
  }

  static async requestTrustUnlock({ contract }) {
    const cleanContract = asText(contract);
    if (!cleanContract) {
      throw new SgpError('sgp.error.contractRequired', {
        code: 'missing_contract',
        status: 400
      });
    }
    const data = await this.request('unlock', { contrato: cleanContract });
    return {
      message: asText(pick(data, ['msg', 'mensagem', 'message']))
        || 'Liberação em confiança solicitada ao SGP'
    };
  }

  /**
   * Opens a support ticket (a "chamado", and the occurrence plus service order
   * behind it) against a contract.
   *
   * The body carries only the fields SGP's own reference documents for this
   * route: `contrato`, `conteudo`, `observacao` and `ocorrenciatipo`, with
   * `app` and `token` added by `request`. Two nearby fields are deliberately
   * absent. `setor` belongs to `/api/ura/central/chamado/`, the subscriber's
   * self-service variant that authenticates with cpfcnpj+senha rather than
   * app+token, so sending it here is at best a field the server ignores.
   * `conteudolimpo` only suppresses SGP's default opening line, and the two
   * references disagree on its spelling — a cosmetic field whose name cannot be
   * settled is not worth the chance of being wrong.
   *
   * The response shape is the half that is not documented anywhere, which is
   * exactly the half tolerant reading covers: whatever the install calls the
   * protocol number, `pick` looks for it under the spellings the other three
   * routes already use, and an unrecognised body is a success with a generic
   * message rather than an error.
   */
  static async openTicket({ contract, content, note = null, occurrenceType = null }) {
    const cleanContract = asText(contract);
    if (!cleanContract) {
      throw new SgpError('sgp.error.contractRequired', {
        code: 'missing_contract',
        status: 400
      });
    }

    const cleanContent = asText(content);
    if (!cleanContent) {
      throw new SgpError('sgp.error.ticketContentRequired', {
        code: 'missing_content',
        status: 400
      });
    }

    const config = this.requireReady(await this.getConfig());
    if (!config.ticketEnabled) {
      throw new SgpError('sgp.error.ticketDisabled', {
        code: 'ticket_disabled',
        status: 409
      });
    }

    const payload = {
      contrato: cleanContract,
      // Trimmed rather than rejected: a technician's note running long is not a
      // reason to refuse to open the ticket.
      conteudo: cleanContent.slice(0, 4000),
      ocorrenciatipo: Number(occurrenceType) > 0
        ? Number(occurrenceType)
        : config.ticketOccurrenceType
    };
    const cleanNote = asText(note);
    if (cleanNote) payload.observacao = cleanNote.slice(0, 2000);

    const data = await this.request('ticket', payload);
    return {
      contract: cleanContract,
      ticket: asText(pick(data, [
        'chamado', 'protocolo', 'ocorrencia', 'os', 'ordemservico', 'id', 'numero'
      ])),
      // Null rather than a hardcoded sentence when the ERP says nothing: the
      // panel speaks eleven languages and the service has no request to
      // translate against, so the caller supplies the wording.
      message: asText(pick(data, ['msg', 'mensagem', 'message']))
    };
  }

  static contractToLinkRow(contract, { deviceId, accountId, linkMode }) {
    return {
      device_id: deviceId,
      account_id: accountId ?? null,
      contract: contract.contract,
      document: contract.document ? String(contract.document).replace(/\D/g, '').slice(0, 32) : null,
      client_name: contract.name ? String(contract.name).slice(0, 255) : null,
      plan: contract.plan ? String(contract.plan).slice(0, 255) : null,
      status: contract.status ? String(contract.status).slice(0, 64) : null,
      status_label: contract.statusLabel ? String(contract.statusLabel).slice(0, 128) : null,
      state: deriveContractState(contract),
      login: contract.login ? String(contract.login).slice(0, 255) : null,
      // `phone_manual` is deliberately absent from this row: a sync must never
      // overwrite the correction an operator made by hand. The reader prefers
      // the manual value; this only refreshes what the ERP believes.
      phone_e164: contract.phone || null,
      link_mode: linkMode,
      last_synced_at: new Date()
    };
  }

  /**
   * O contrato que uma PESSOA escolheu, ou nada.
   *
   * `pickContract` existe para responder "qual destes serve", e ali um palpite
   * — o primeiro não bloqueado — é a resposta certa. Quando o número veio de
   * alguém, o palpite é a pior resposta possível: o vínculo governa VLAN e
   * PPPoE no provisionamento, e a troca não aparece em canto nenhum. A tela diz
   * "contrato vinculado", e o número que ela mostra é outro.
   *
   * A regra não é nova neste arquivo: `syncAccount` já a aplica no vínculo
   * manual, com o comentário que a explica — "o operador escolheu aquele
   * contrato". O que faltava era aplicá-la nos dois outros lugares em que um
   * número escolhido a mão passa por `pickContract`.
   */
  static exactContract(contracts, wanted) {
    return contracts.find((entry) => entry.contract === String(wanted)) || null;
  }

  static pickContract(contracts, preferredContract = null) {
    if (contracts.length === 0) return null;
    if (preferredContract) {
      const exact = contracts.find((entry) => entry.contract === String(preferredContract));
      if (exact) return exact;
    }
    return contracts.find((entry) => entry.blocked === false)
      || contracts.find((entry) => /ativo/i.test(entry.statusLabel || ''))
      || contracts[0];
  }

  static isLinkExpired(link, now = Date.now()) {
    const syncedAt = link?.last_synced_at ? new Date(link.last_synced_at).getTime() : Number.NaN;
    if (!Number.isFinite(syncedAt)) return true;
    return now - syncedAt >= LINK_CACHE_TTL_MS;
  }

  /**
   * The login the ONT reports, or null — never an error.
   *
   * A GenieACS that is unreachable must not turn "this ONT has no contract
   * yet" into a failed page: the caller falls back to having no identifier,
   * which is the state it was already handling.
   */
  static async reportedPppoeLogin(deviceId) {
    try {
      return await DeviceService.getReportedPppoe(deviceId);
    } catch (error) {
      console.warn(`Unable to read the reported PPPoE login of ${deviceId}: ${error.message}`);
      return null;
    }
  }

  // Resolves the SGP contract bound to a panel device. A stored link always
  // wins; otherwise the configured link mode decides which identifier is sent
  // to the SGP lookup, and a successful match is cached in sgp_links.
  static async resolveDeviceContract(deviceId, { refresh = false } = {}) {
    const config = this.requireReady(await this.getConfig());
    const stored = await SgpLink.getByDeviceId(deviceId);
    const account = await CustomerAccount.getByDeviceId(deviceId);

    // A link recorded for a different account belongs to the previous
    // subscriber of this ONT. Never serve it: drop it and look the contract up
    // again for whoever holds the device now.
    const staleOwner = Boolean(
      stored && stored.account_id !== null && account && stored.account_id !== account.id
    );
    if (staleOwner) {
      await SgpLink.deleteByDeviceId(deviceId);
    }

    const usable = staleOwner ? null : stored;
    // Read off `usable`, not `stored`: a manual pin that belonged to the
    // previous subscriber died with the link above, and this ONT is to be
    // resolved afresh rather than reported as having no contract.
    const manual = usable?.link_mode === 'manual' || config.linkMode === 'manual';

    // The login the ONT itself reports, read only when it is the only
    // identifier there is. The mode is called "the ONT's PPPoE login" and the
    // panel has had it since the device listing learned to read it; making it
    // wait for a customer account tied the SGP link to whether the operator
    // wants generated Customer IDs, which is an unrelated decision about the
    // subscriber portal. An account-backed device already carries a login, so
    // this costs nothing there — and the portal, the one caller on a
    // subscriber's critical path, always has an account.
    const reportedLogin = !manual
      && config.linkMode === 'pppoe'
      && !normalizeLogin(account?.pppoe_username)
      ? await this.reportedPppoeLogin(deviceId)
      : null;

    // The same protection where there is no account to compare. An ONT whose
    // reported login no longer matches the contract on file is an ONT that
    // changed hands, and the cached contract — with the invoices hanging off
    // it — is the previous subscriber's. The row is left alone rather than
    // deleted, so an operator's corrected phone survives being overwritten by
    // the next successful lookup; it simply stops being an answer.
    const staleLogin = Boolean(
      usable
      && !manual
      && usable.account_id === null
      && reportedLogin
      && usable.login
      && normalizeLogin(usable.login) !== normalizeLogin(reportedLogin)
    );
    const cacheable = Boolean(usable) && !staleLogin;

    if (cacheable && !refresh && !this.isLinkExpired(usable)) {
      return { link: usable, account, source: 'cache' };
    }

    const preferredContract = cacheable ? usable.contract || null : null;
    const filters = manual
      ? { contract: preferredContract }
      : config.linkMode === 'customer_id'
        ? { contract: account?.customer_id }
        : { login: account?.pppoe_username || reportedLogin };

    if (!filters.contract && !filters.login) {
      if (cacheable) return { link: usable, account, source: 'cache' };
      throw new SgpError('sgp.error.deviceUnlinked', { code: 'unlinked', status: 404 });
    }

    const { contracts } = await this.lookupCustomer(filters, config);
    // A consulta manual é FILTRADA pelo contrato, e o ERP responde com o
    // cliente inteiro — todos os contratos dele. Deixar `pickContract` escolher
    // aí re-aponta o vínculo que alguém fixou a mão para outro contrato do
    // mesmo cliente, silenciosamente e a cada refresh, que é exatamente o que
    // `syncAccount` se recusa a fazer três métodos abaixo.
    const contract = manual
      ? this.exactContract(contracts, preferredContract)
      : this.pickContract(contracts, preferredContract);
    if (!contract) {
      // A stale cache is better than no answer, but only while it still
      // belongs to the subscriber holding the device.
      if (cacheable) return { link: usable, account, source: 'cache' };
      throw new SgpError('sgp.error.noContractForDevice', {
        code: 'not_found',
        status: 404
      });
    }

    const link = await SgpLink.upsert(this.contractToLinkRow(contract, {
      deviceId,
      accountId: account?.id ?? null,
      linkMode: usable?.link_mode === 'manual' ? 'manual' : 'auto'
    }));
    return { link, account, contract, source: 'sgp' };
  }

  static async linkDevice(deviceId, { contract, document }) {
    const config = this.requireReady(await this.getConfig());
    const { contracts } = await this.lookupCustomer({ contract, document }, config);
    // Com um contrato nas mãos, só ele serve. Sem ele — a busca foi por
    // documento — a escolha é do painel, e aí `pickContract` é quem responde.
    const selected = contract
      ? this.exactContract(contracts, contract)
      : this.pickContract(contracts);
    if (!selected) {
      throw new SgpError('sgp.error.contractNotFound', { code: 'not_found', status: 404 });
    }
    const account = await CustomerAccount.getByDeviceId(deviceId);
    return SgpLink.upsert(this.contractToLinkRow(selected, {
      deviceId,
      accountId: account?.id ?? null,
      linkMode: 'manual'
    }));
  }

  static async unlinkDevice(deviceId) {
    return SgpLink.deleteByDeviceId(deviceId);
  }

  // Rows written before the `state` column existed carry no value at all, so the
  // reader always falls back instead of trusting what is stored.
  static linkState(link) {
    return CONTRACT_STATES.includes(link?.state) ? link.state : 'unknown';
  }

  static publicLink(link) {
    if (!link) return null;
    return {
      contract: link.contract,
      clientName: link.client_name,
      document: link.document,
      plan: link.plan,
      status: link.status,
      statusLabel: link.status_label,
      state: this.linkState(link),
      login: link.login,
      linkMode: link.link_mode,
      lastSyncedAt: link.last_synced_at
        ? new Date(link.last_synced_at).toISOString()
        : null
    };
  }

  // The customer portal must never expose the full document of an account.
  static portalLink(link) {
    const base = this.publicLink(link);
    if (!base) return null;
    return { ...base, document: maskDocument(base.document) };
  }

  static async listLinks() {
    this.requireReady(await this.getConfig());
    const links = await SgpLink.getAll();
    return links.map((link) => ({
      deviceId: link.device_id,
      contract: link.contract,
      clientName: link.client_name,
      plan: link.plan,
      status: link.status,
      statusLabel: link.status_label,
      state: this.linkState(link),
      linkMode: link.link_mode,
      lastSyncedAt: link.last_synced_at
        ? new Date(link.last_synced_at).toISOString()
        : null
    }));
  }

  // Refreshes one account during a fleet sync. A manual link is never
  // re-pointed: the operator chose that contract, so only its cached fields are
  // refreshed even when SGP would now answer with a different one.
  static async syncAccount(account, stored, config) {
    const manual = stored?.link_mode === 'manual';
    const filters = manual || config.linkMode === 'manual'
      ? { contract: stored?.contract }
      : config.linkMode === 'customer_id'
        ? { contract: account.customer_id }
        : { login: account.pppoe_username };
    if (!filters.contract && !filters.login) return 'skipped';

    const { contracts } = await this.lookupCustomer(filters, config);
    const contract = manual
      ? contracts.find((entry) => entry.contract === stored.contract) || null
      : this.pickContract(contracts, stored?.contract || null);
    if (!contract) return 'skipped';

    await SgpLink.upsert(this.contractToLinkRow(contract, {
      deviceId: account.device_id,
      accountId: account.id,
      linkMode: manual ? 'manual' : 'auto'
    }));
    return stored ? 'updated' : 'created';
  }

  /**
   * Every device this run should try to link.
   *
   * The accounts, plus — in the mode that matches on the ONT's own login —
   * the devices that have none. Without those the sweep only ever reaches
   * devices some other feature happened to create an account for, and an
   * operator who does not generate Customer IDs would see the contract column
   * fill one ONT at a time, as someone opened each page.
   *
   * Shaped like accounts because that is all `syncAccount` reads: a device
   * with no account carries a null id, which `contractToLinkRow` already
   * stores — `sgp_links.account_id` has been nullable since the table existed.
   */
  static async syncTargets(config) {
    const accounts = await CustomerAccount.getSyncTargets();
    if (config.linkMode !== 'pppoe') return accounts;

    let devices;
    try {
      devices = await DeviceService.getCustomerIdentityDevices();
    } catch (error) {
      // A sweep that reaches the accounts is worth more than no sweep.
      console.warn(`SGP fleet sync could not read the ONT fleet: ${error.message}`);
      return accounts;
    }

    const covered = new Set(accounts.map((account) => String(account.device_id)));
    const extra = devices
      .filter((device) => device._id
        && !covered.has(String(device._id))
        && normalizeLogin(device.pppoe))
      .map((device) => ({
        id: null,
        device_id: device._id,
        customer_id: null,
        pppoe_username: device.pppoe
      }));
    return [...accounts, ...extra];
  }

  // Fleet-wide refresh of every device this install can identify — see
  // `syncTargets` for which those are.
  // `linked` counts the devices that hold a link once the run is over, so it
  // also covers the ones whose refresh failed but whose cached link survived.
  // `skipped` covers devices with no identifier for the configured link mode
  // and lookups that matched no contract, however SGP phrased that answer;
  // `failed` covers real SGP errors only.
  static async syncFleet() {
    const config = this.requireReady(await this.getConfig());
    const startedAt = new Date();
    const targets = await this.syncTargets(config);
    const stored = new Map(
      (await SgpLink.getAll()).map((link) => [link.device_id, link])
    );
    const summary = {
      total: targets.length,
      linked: 0,
      created: 0,
      updated: 0,
      failed: 0,
      skipped: 0
    };

    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const account = targets[cursor];
        cursor += 1;
        const link = stored.get(account.device_id) || null;
        let outcome;
        try {
          outcome = await this.syncAccount(account, link, config);
        } catch (error) {
          // One unreachable contract must never cost the operator the run.
          outcome = isNotFound(error) ? 'skipped' : 'failed';
          if (!(error instanceof SgpError)) {
            console.error(`SGP fleet sync failed for ${account.device_id}:`, error);
          }
        }
        summary[outcome] += 1;
        if (outcome === 'created' || outcome === 'updated' || link) summary.linked += 1;
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(SYNC_CONCURRENCY, targets.length) },
      () => worker()
    ));

    const finishedAt = new Date();
    const result = {
      ...summary,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString()
    };
    await AppState.upsert(SYNC_STATE_KEY, JSON.stringify(result));
    return result;
  }

  static async getLastSync() {
    const raw = await AppState.get(SYNC_STATE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // Cross-references what GenieACS knows (is the ONT informing?) with what SGP
  // knows (is the contract payable?). Neither system can see these two on its
  // own: an ONT online on a blocked contract is a possible unauthorised
  // reconnection, and an active contract with a silent ONT is a customer with a
  // problem who has not called yet.
  static async getFleetOverview() {
    this.requireReady(await this.getConfig());
    const devices = await DeviceService.getCustomerIdentityDevices();
    const links = new Map(
      (await SgpLink.getAll()).map((link) => [link.device_id, link])
    );
    const deviceIds = devices.map((device) => String(device._id || '')).filter(Boolean);
    const customerIds = new Map(
      (await CustomerAccount.getIdsByDeviceIds(deviceIds))
        .map((row) => [row.device_id, row.customer_id])
    );

    const now = Date.now();
    const byState = { active: 0, blocked: 0, cancelled: 0, unknown: 0 };
    const onlineBlocked = [];
    const offlineActive = [];
    const unlinked = [];
    let linked = 0;

    for (const device of devices) {
      const deviceId = String(device._id || '');
      if (!deviceId) continue;
      const link = links.get(deviceId);
      if (!link) {
        unlinked.push({
          deviceId,
          customerId: customerIds.get(deviceId) || null,
          pppoe: device.pppoe || null
        });
        continue;
      }

      linked += 1;
      const state = this.linkState(link);
      byState[state] += 1;
      const lastInform = device._lastInform || null;
      const age = lastInform ? now - new Date(lastInform).getTime() : Number.NaN;
      const online = Number.isFinite(age) && age >= 0 && age < ONLINE_WINDOW_MS;
      const entry = {
        deviceId,
        contract: link.contract,
        clientName: link.client_name,
        statusLabel: link.status_label,
        state,
        lastInform
      };
      if (online && (state === 'blocked' || state === 'cancelled')) {
        onlineBlocked.push(entry);
      } else if (!online && state === 'active') {
        offlineActive.push(entry);
      }
    }

    // GenieACS timestamps are ISO strings, so they order lexicographically.
    // The most recent reconnection and the longest silence come first.
    const informOrder = (left, right) => String(left.lastInform || '')
      .localeCompare(String(right.lastInform || ''));
    onlineBlocked.sort((left, right) => informOrder(right, left));
    offlineActive.sort(informOrder);

    return {
      enabled: true,
      totals: {
        devices: deviceIds.length,
        linked,
        unlinked: unlinked.length,
        onlineBlocked: onlineBlocked.length,
        offlineActive: offlineActive.length
      },
      byState,
      // The lists are samples capped at DIVERGENCE_LIMIT; `totals` always
      // carries the full counts.
      divergences: {
        onlineBlocked: onlineBlocked.slice(0, DIVERGENCE_LIMIT),
        offlineActive: offlineActive.slice(0, DIVERGENCE_LIMIT),
        unlinked: unlinked.slice(0, DIVERGENCE_LIMIT)
      },
      lastSync: await this.getLastSync(),
      generatedAt: new Date().toISOString()
    };
  }

  static async testConnection(overrides = {}) {
    const current = await this.getConfig();
    const config = {
      ...current,
      baseUrl: overrides.baseUrl === undefined
        ? current.baseUrl
        : this.normalizeBaseUrl(overrides.baseUrl),
      app: overrides.app === undefined ? current.app : String(overrides.app).trim(),
      token: overrides.token ? String(overrides.token).trim() : current.token,
      // A connectivity probe must run even before the integration is switched on.
      enabled: true,
      endpoints: { ...current.endpoints, ...(overrides.endpoints || {}) }
    };
    if (!config.baseUrl || !config.app || !config.token) {
      throw new SgpError('sgp.error.testCredentialsRequired', {
        code: 'incomplete_config',
        status: 400
      });
    }
    // SGP requires at least one filter, so a probe without a sample customer
    // asks for a document that cannot exist. A "customer not found" answer
    // still proves the URL, app and token are valid.
    const hasSample = Boolean(overrides.document || overrides.contract || overrides.login);
    const filters = hasSample
      ? this.buildLookupPayload({
        document: overrides.document,
        contract: overrides.contract,
        login: overrides.login
      })
      : { cpfcnpj: '00000000000' };

    let data;
    try {
      data = await this.request('customer', filters, config);
    } catch (error) {
      if (error instanceof SgpError && error.code === 'sgp_rejected') {
        if (/token|app|autoriza|credenc|permiss/i.test(error.message)) {
          throw new SgpError('sgp.error.credentialsRejected', {
            code: 'unauthorized',
            status: 502
          });
        }
        return {
          contracts: 0,
          probe: hasSample ? 'filtered' : 'anonymous',
          messageKey: 'sgp.testAccepted',
          // A rejection SGP itself phrased is quoted; our own errors are
          // identified by code so no untranslated key reaches the operator.
          messageVars: { error: error.translationKey ? error.code : error.message }
        };
      }
      throw error;
    }

    const contracts = firstArray(data, ['contratos', 'contrato', 'dados', 'data', 'clientes'])
      .map((entry) => normalizeContract(entry))
      .filter(Boolean);
    return {
      contracts: contracts.length,
      probe: hasSample ? 'filtered' : 'anonymous',
      message: asText(pick(data, ['msg', 'mensagem', 'message']))
    };
  }
}

export { deriveContractState, maskDocument, normalizeContract, normalizeInvoice };
export default SgpService;
