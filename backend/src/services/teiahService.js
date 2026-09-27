import AppState from '../models/AppState.js';
import { createSecretBox } from '../utils/secretBox.js';
import { PinnedTransport, RESPONSE_TOO_LARGE } from '../utils/net/pinnedFetch.js';
import { deploymentIsShared } from './genieacsEgress.js';
import { TenantCache } from '../config/tenantCache.js';

/**
 * TeiaH Valid — a shared base of addresses that left a provider owing money.
 *
 * The panel feeds it: every SGP contract that was cancelled with invoices
 * still open goes to `POST /api/import/addresses` as an `ImportAddressDto`
 * (street, number, district, city, UF, CEP, the amount owed and the start and
 * cancellation months). What goes is the ADDRESS and the debt — never a name,
 * a document or a phone: the DTO has no field for them, and the panel does not
 * add one. `teiahExportService.js` decides what to send; this file only holds
 * the configuration and speaks to the API.
 *
 * The API authenticates with an `x-api-key` header. The key is the provider's
 * own, per tenant, and is stored encrypted like the SGP token.
 */

const CONFIG_KEY = 'teiah_integration_config';
const CONFIG_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export const DEFAULT_BASE_URL = 'https://api.valid.teiah.ai';
export const IMPORT_ONE_PATH = '/api/import/address';
export const IMPORT_MANY_PATH = '/api/import/addresses';

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  baseUrl: DEFAULT_BASE_URL,
  exportEnabled: false,
  exportIntervalHours: 24,
  batchSize: 50
});

const apiKeyBox = createSecretBox('skygenpanel-teiah-apikey-v1');

function encryptApiKey(key) {
  return { v: 1, ...apiKeyBox.encrypt(key) };
}

function decryptApiKey(box) {
  return box ? (apiKeyBox.decrypt(box) ?? '') : '';
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/** Same contract as `SgpError`: the message is a translation key unless `raw`. */
export class TeiahError extends Error {
  constructor(message, { code = 'teiah_error', status = 502, details = null, vars = null, raw = false } = {}) {
    super(message);
    this.name = 'TeiahError';
    this.code = code;
    this.status = status;
    this.details = details;
    if (!raw) {
      this.translationKey = message;
      this.translationVars = vars;
    }
  }
}

/** The API's own words for a refusal, when it sent any (NestJS: `message`, a string or a list). */
function apiMessage(data) {
  const message = data && typeof data === 'object' ? (data.message ?? data.error ?? data.msg) : null;
  if (Array.isArray(message)) return message.map(String).join('; ').slice(0, 500) || null;
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : null;
}

class TeiahService {
  static configCache = new TenantCache(CONFIG_CACHE_TTL_MS);

  /** Read by `this`, so a test can prove the deadline without waiting for it. */
  static REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

  static invalidateConfigCache() {
    this.configCache.invalidate();
  }

  static normalizeBaseUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) return DEFAULT_BASE_URL;
    let url;
    try {
      url = new URL(text.includes('://') ? text : `https://${text}`);
    } catch {
      throw new TeiahError('teiah.error.urlInvalid', { code: 'invalid_base_url', status: 400 });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new TeiahError('teiah.error.urlInvalid', { code: 'invalid_base_url', status: 400 });
    }
    if (url.username || url.password) {
      throw new TeiahError('teiah.error.urlInvalid', { code: 'invalid_base_url', status: 400 });
    }
    // The paths are the API's, not the operator's: a base pasted with `/api`
    // (or the Swagger's `/api/docs`) at the end is the same server.
    const path = url.pathname.replace(/\/+$/, '').replace(/\/api(\/docs)?$/i, '');
    return `${url.origin}${path}`;
  }

  static async readStoredConfig() {
    const raw = await AppState.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG, apiKey: null };
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_CONFIG, apiKey: null };
    }
  }

  static async getConfig() {
    const cached = this.configCache.get();
    if (cached) return cached;
    const stored = await this.readStoredConfig();
    const config = {
      enabled: stored.enabled === true,
      baseUrl: String(stored.baseUrl || DEFAULT_BASE_URL),
      apiKey: decryptApiKey(stored.apiKey),
      exportEnabled: stored.exportEnabled === true,
      exportIntervalHours: clampNumber(stored.exportIntervalHours, 1, 168, DEFAULT_CONFIG.exportIntervalHours),
      batchSize: clampNumber(stored.batchSize, 1, 500, DEFAULT_CONFIG.batchSize),
      updatedAt: stored.updatedAt || null
    };
    this.configCache.set(config);
    return config;
  }

  static async getPublicConfig() {
    const config = await this.getConfig();
    const { apiKey, ...rest } = config;
    return {
      ...rest,
      apiKeyConfigured: Boolean(apiKey),
      ready: this.isReady(config)
    };
  }

  static isReady(config) {
    return Boolean(config?.enabled && config.baseUrl && config.apiKey);
  }

  static requireReady(config) {
    if (!this.isReady(config)) {
      throw new TeiahError('teiah.error.notConfigured', { code: 'not_configured', status: 409 });
    }
    return config;
  }

  /**
   * An absent field keeps its value; `apiKey: ""` clears the key, which is how
   * an operator revokes the integration without losing the rest of the setup.
   */
  static async saveConfig(patch = {}) {
    const current = await this.getConfig();
    const stored = await this.readStoredConfig();
    const next = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      baseUrl: patch.baseUrl === undefined ? current.baseUrl : this.normalizeBaseUrl(patch.baseUrl),
      exportEnabled: patch.exportEnabled === undefined ? current.exportEnabled : patch.exportEnabled === true,
      exportIntervalHours: patch.exportIntervalHours === undefined
        ? current.exportIntervalHours
        : clampNumber(patch.exportIntervalHours, 1, 168, DEFAULT_CONFIG.exportIntervalHours),
      batchSize: patch.batchSize === undefined
        ? current.batchSize
        : clampNumber(patch.batchSize, 1, 500, DEFAULT_CONFIG.batchSize),
      updatedAt: new Date().toISOString()
    };

    if (patch.apiKey === undefined) {
      next.apiKey = stored.apiKey ?? null;
    } else {
      const key = String(patch.apiKey ?? '').trim();
      if (key.length > 512) {
        throw new TeiahError('teiah.error.apiKeyInvalid', { code: 'invalid_api_key', status: 400 });
      }
      next.apiKey = key ? encryptApiKey(key) : null;
    }

    await AppState.upsert(CONFIG_KEY, JSON.stringify(next));
    this.invalidateConfigCache();
    return this.getPublicConfig();
  }

  /**
   * One call to the API. The egress guard is the SGP's: in a shared deployment
   * the base URL cannot point into the panel's own network, and the refusal
   * names nothing it learned.
   *
   * @returns {Promise<{ status: number, data: any }>}
   */
  static async request(path, body, configOverride = null) {
    const config = this.requireReady(configOverride || await this.getConfig());
    let url;
    try {
      url = new URL(`${config.baseUrl}${path}`);
    } catch {
      throw new TeiahError('teiah.error.urlInvalid', { code: 'invalid_base_url', status: 400 });
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);
    let response;
    try {
      const addresses = await PinnedTransport.vetTarget(hostname, {
        signal: controller.signal,
        allowPrivateAddresses: !deploymentIsShared(),
        refuse: () => new TeiahError('teiah.error.blockedHost', { code: 'blocked_host', status: 400 })
      });
      controller.signal.throwIfAborted();
      if (addresses.length === 0) {
        throw new TeiahError('teiah.error.unreachable', { code: 'unreachable', status: 502 });
      }
      response = await PinnedTransport.request({
        url,
        hostname,
        addresses,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': config.apiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        maxBytes: MAX_RESPONSE_BYTES
      });
    } catch (error) {
      if (error instanceof TeiahError) throw error;
      if (error.name === 'AbortError' || error.name === 'TimeoutError' || controller.signal.aborted) {
        throw new TeiahError('teiah.error.timeout', { code: 'timeout', status: 504 });
      }
      if (error.code === RESPONSE_TOO_LARGE) {
        throw new TeiahError('teiah.error.invalidResponse', { code: 'invalid_response', status: 502 });
      }
      throw new TeiahError('teiah.error.unreachable', { code: 'unreachable', status: 502 });
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
    return { status: response.status, data };
  }

  /** A non-2xx answer as the error it means. */
  static failure(status, data) {
    if (status === 401 || status === 403) {
      return new TeiahError('teiah.error.credentialsRejected', { code: 'unauthorized', status: 502 });
    }
    if (status === 429) {
      return new TeiahError('teiah.error.rateLimited', { code: 'rate_limited', status: 502 });
    }
    return new TeiahError('teiah.error.status', {
      vars: { status },
      code: status >= 400 && status < 500 ? 'rejected' : 'http_error',
      status: 502,
      details: apiMessage(data) || undefined
    });
  }

  static async importOne(item, configOverride = null) {
    const { status, data } = await this.request(IMPORT_ONE_PATH, item, configOverride);
    if (status < 200 || status >= 300) throw this.failure(status, data);
    return data;
  }

  /**
   * A batch, and what to do when the batch is refused.
   *
   * The Swagger documents the batch body as `string[]`, which is almost
   * certainly an annotation slip for `ImportAddressDto[]` — but if a release
   * validates it literally, a batch answers 400 while the same items go
   * through one by one. So a batch refused with a 400/422 is retried item by
   * item, and each item's own outcome is what is recorded. A 401 or a 5xx is
   * not a shape problem, and is raised for the whole batch.
   *
   * @returns {Promise<Array<{ ok: boolean, error?: TeiahError }>>} one entry per item, in order
   */
  static async importMany(items, configOverride = null) {
    if (!items.length) return [];
    const config = configOverride || await this.getConfig();
    const { status, data } = await this.request(IMPORT_MANY_PATH, items, config);
    if (status >= 200 && status < 300) return items.map(() => ({ ok: true }));
    if (status !== 400 && status !== 422) throw this.failure(status, data);

    const outcomes = [];
    for (const item of items) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one at a time, it is the fallback
        await this.importOne(item, config);
        outcomes.push({ ok: true });
      } catch (error) {
        if (!(error instanceof TeiahError) || error.code === 'unauthorized' || error.code === 'timeout') throw error;
        outcomes.push({ ok: false, error });
      }
    }
    return outcomes;
  }

  /**
   * Whether the key is accepted, WITHOUT writing anything to the TeiaH base:
   * an empty batch. A key the API refuses answers 401/403 before the body is
   * looked at; any other answer — 201 for an empty import, or 400 for "empty
   * list not allowed" — means the server is there and the key went through.
   */
  static async testConnection(patch = {}) {
    const current = await this.getConfig();
    const apiKey = patch.apiKey === undefined || patch.apiKey === '' ? current.apiKey : String(patch.apiKey).trim();
    const baseUrl = patch.baseUrl === undefined ? current.baseUrl : this.normalizeBaseUrl(patch.baseUrl);
    if (!apiKey) {
      throw new TeiahError('teiah.error.apiKeyMissing', { code: 'not_configured', status: 400 });
    }
    const config = { ...current, enabled: true, baseUrl, apiKey };
    const started = Date.now();
    const { status } = await this.request(IMPORT_MANY_PATH, [], config);
    // A 404 is a base URL that is not the API's — not a working connection.
    const accepted = (status >= 200 && status < 300) || status === 400 || status === 422;
    if (!accepted) throw this.failure(status, null);
    return { ok: true, status, durationMs: Date.now() - started };
  }
}

export default TeiahService;
