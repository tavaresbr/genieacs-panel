import { randomBytes } from 'node:crypto';
import AppState from '../models/AppState.js';
import CustomerAccount from '../models/CustomerAccount.js';
import SgpLink from '../models/SgpLink.js';
import { createSecretBox } from '../utils/secretBox.js';

const CONFIG_KEY = 'sgp_integration_config';
const CONFIG_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

// SGP exposes the URA (self-service) endpoints below on every provider
// instance. They stay configurable because deployments occasionally publish
// the integration under a custom prefix.
export const DEFAULT_ENDPOINTS = Object.freeze({
  customer: '/api/ura/consultacliente/',
  invoices: '/api/ura/titulos/',
  unlock: '/api/ura/liberacao/'
});

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
    blocked: (() => {
      const value = pick(entry, ['bloqueado', 'contratoBloqueado', 'bloqueio']);
      if (value === null) return null;
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'sim', 's'].includes(String(value).trim().toLowerCase());
    })()
  };
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

const MIN_RECONCILE_INTERVAL_MINUTES = 5;

class SgpService {
  static configCache = { value: null, expiresAt: 0 };

  static invalidateConfigCache() {
    this.configCache = { value: null, expiresAt: 0 };
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
    if (this.configCache.value && this.configCache.expiresAt > Date.now()) {
      return this.configCache.value;
    }
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
      updatedAt: stored.updatedAt || null
    };
    this.configCache = { value: config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
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
      endpoints: {
        customer: this.normalizeEndpoint(
          patch.endpoints?.customer ?? current.endpoints.customer, DEFAULT_ENDPOINTS.customer
        ),
        invoices: this.normalizeEndpoint(
          patch.endpoints?.invoices ?? current.endpoints.invoices, DEFAULT_ENDPOINTS.invoices
        ),
        unlock: this.normalizeEndpoint(
          patch.endpoints?.unlock ?? current.endpoints.unlock, DEFAULT_ENDPOINTS.unlock
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
    const config = configOverride || await this.getConfig();
    if (!this.isReady(config)) {
      throw new SgpError('sgp.error.notConfigured', {
        code: 'not_configured',
        status: 409
      });
    }

    const endpoint = config.endpoints[endpointKey] || DEFAULT_ENDPOINTS[endpointKey];
    const url = `${config.baseUrl}${endpoint}`;
    const body = { app: config.app, token: config.token, ...payload };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new SgpError('sgp.error.timeout', {
          code: 'timeout',
          status: 504
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
      login: contract.login ? String(contract.login).slice(0, 255) : null,
      blocked: contract.blocked === null || contract.blocked === undefined
        ? null
        : Boolean(contract.blocked),
      link_mode: linkMode,
      last_synced_at: new Date()
    };
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

  // Resolves the SGP contract bound to a panel device. A stored link always
  // wins; otherwise the configured link mode decides which identifier is sent
  // to the SGP lookup, and a successful match is cached in sgp_links.
  static async resolveDeviceContract(deviceId, { refresh = false } = {}) {
    const config = await this.getConfig();
    if (!this.isReady(config)) {
      throw new SgpError('sgp.error.notConfigured', {
        code: 'not_configured',
        status: 409
      });
    }

    const stored = await SgpLink.getByDeviceId(deviceId);
    const account = await CustomerAccount.getByDeviceId(deviceId);

    if (stored && !refresh) {
      return { link: stored, account, source: 'cache' };
    }

    const preferredContract = stored?.contract || null;
    const filters = stored?.link_mode === 'manual' || config.linkMode === 'manual'
      ? { contract: preferredContract }
      : config.linkMode === 'customer_id'
        ? { contract: account?.customer_id }
        : { login: account?.pppoe_username };

    if (!filters.contract && !filters.login) {
      if (stored) return { link: stored, account, source: 'cache' };
      throw new SgpError('sgp.error.deviceUnlinked', { code: 'unlinked', status: 404 });
    }

    const { contracts } = await this.lookupCustomer(filters, config);
    const contract = this.pickContract(contracts, preferredContract);
    if (!contract) {
      if (stored) return { link: stored, account, source: 'cache' };
      throw new SgpError('sgp.error.noContractForDevice', {
        code: 'not_found',
        status: 404
      });
    }

    const link = await SgpLink.upsert(this.contractToLinkRow(contract, {
      deviceId,
      accountId: account?.id ?? null,
      linkMode: stored?.link_mode === 'manual' ? 'manual' : 'auto'
    }));
    return { link, account, contract, source: 'sgp' };
  }

  static async linkDevice(deviceId, { contract, document }) {
    const config = await this.getConfig();
    if (!this.isReady(config)) {
      throw new SgpError('sgp.error.notConfigured', {
        code: 'not_configured',
        status: 409
      });
    }
    const { contracts } = await this.lookupCustomer({ contract, document }, config);
    const selected = this.pickContract(contracts, contract);
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

  static publicLink(link) {
    if (!link) return null;
    return {
      contract: link.contract,
      clientName: link.client_name,
      document: link.document,
      plan: link.plan,
      status: link.status,
      statusLabel: link.status_label,
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

export { maskDocument, normalizeContract, normalizeInvoice };
export default SgpService;
