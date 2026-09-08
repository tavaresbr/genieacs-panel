import crypto from 'node:crypto';
import AppState from '../models/AppState.js';
import { createSecretBox } from '../utils/secretBox.js';
import { normalizeEvoUrl, parseAllowedHosts, isHostAllowed } from '../utils/wa/evolutionPolicy.js';
import { assertPublicUrl, SsrfBlockedError } from '../utils/wa/ssrfGuard.js';

const CONFIG_KEY = 'whatsapp_evolution_config';
const CONFIG_CACHE_TTL_MS = 30_000;

/** What kind of traffic a connected number carries. */
export const PURPOSES = Object.freeze(['general', 'billing', 'support', 'sales', 'alerts']);

/** The lifecycle of a connected number, as the panel sees it. */
export const ACCOUNT_STATUSES = Object.freeze(['pending', 'connecting', 'connected', 'disconnected', 'expired']);

/**
 * Two independent secret boxes.
 *
 * They are separate because the two secrets have different blast radii: the
 * webhook token travels in a URL and is stored on the Evolution server, so it
 * appears in logs on both ends; the instance token sends messages as the
 * provider and reads its contacts. A ciphertext from one context can never be
 * decrypted as the other.
 */
const instanceTokenBox = createSecretBox('skygenpanel-evolution-instance-token-v1');
const webhookTokenBox = createSecretBox('skygenpanel-evolution-webhook-token-v1');
const adminKeyBox = createSecretBox('skygenpanel-evolution-admin-key-v1');

/**
 * The panel's own error shape for everything WhatsApp, mirroring SgpError so the
 * controllers can translate it the same way.
 *
 * `code` is a machine string the frontend switches on to show an actionable
 * message; dumping the server's response body at the operator is what the
 * source system did before, and it sent people to check a URL and a key that
 * were already correct.
 */
export class WaError extends Error {
  constructor(message, { code = 'wa_error', status = 502, details = null } = {}) {
    super(message);
    this.name = 'WaError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  // Empty allowlist = any public host. The SSRF guard still blocks internal
  // networks, so this is "any server the provider chose", not "anything".
  allowedHosts: [],
  // The public HTTPS URL where the Evolution server reaches this panel. The
  // panel cannot guess it: it sits behind a tunnel or a reverse proxy whose
  // external hostname is nowhere in the process.
  webhookBaseUrl: '',
  rejectCallMessage: 'Este número não recebe chamadas. Envie sua mensagem por escrito.',
  // Per-minute ceiling for outbound messages, shared by the outbox worker and
  // any campaign that does not set its own.
  rateLimitPerMin: 20,
  managedUrl: '',
  updatedAt: null
});

function encryptSecret(box, value) {
  return { v: 1, ...box.encrypt(value) };
}

function decryptSecret(box, stored) {
  return stored ? (box.decrypt(stored) ?? '') : '';
}

/** 32 bytes of CSPRNG, hex. Used for both the instance and the webhook token. */
export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

class WhatsAppConfigService {
  static configCache = { value: null, expiresAt: 0 };

  static invalidateConfigCache() {
    this.configCache = { value: null, expiresAt: 0 };
  }

  static async readStoredConfig() {
    const raw = await AppState.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG, managedAdminKey: null };
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_CONFIG, managedAdminKey: null };
    }
  }

  static async getConfig() {
    if (this.configCache.value && this.configCache.expiresAt > Date.now()) {
      return this.configCache.value;
    }
    const stored = await this.readStoredConfig();
    const config = {
      enabled: stored.enabled === true,
      allowedHosts: parseAllowedHosts(stored.allowedHosts),
      webhookBaseUrl: String(stored.webhookBaseUrl || ''),
      rejectCallMessage: String(stored.rejectCallMessage || DEFAULT_CONFIG.rejectCallMessage),
      rateLimitPerMin: Number(stored.rateLimitPerMin) > 0
        ? Math.min(Number(stored.rateLimitPerMin), 120)
        : DEFAULT_CONFIG.rateLimitPerMin,
      managedUrl: normalizeEvoUrl(stored.managedUrl || ''),
      managedAdminKey: decryptSecret(adminKeyBox, stored.managedAdminKey),
      updatedAt: stored.updatedAt || null
    };
    this.configCache = { value: config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
    return config;
  }

  /** The shape the browser is allowed to see: no secret, ever. */
  static async getPublicConfig() {
    const config = await this.getConfig();
    const { managedAdminKey, ...rest } = config;
    return {
      ...rest,
      managed: Boolean(config.managedUrl),
      managedAdminKeyConfigured: Boolean(managedAdminKey),
      ready: this.isReady(config)
    };
  }

  static isReady(config) {
    return Boolean(config.enabled && config.webhookBaseUrl);
  }

  static async saveConfig(patch = {}) {
    const current = await this.getConfig();
    const next = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      allowedHosts: patch.allowedHosts === undefined
        ? current.allowedHosts
        : parseAllowedHosts(patch.allowedHosts),
      webhookBaseUrl: patch.webhookBaseUrl === undefined
        ? current.webhookBaseUrl
        : this.normalizeWebhookBaseUrl(patch.webhookBaseUrl),
      rejectCallMessage: patch.rejectCallMessage === undefined
        ? current.rejectCallMessage
        : String(patch.rejectCallMessage).trim().slice(0, 300),
      rateLimitPerMin: patch.rateLimitPerMin === undefined
        ? current.rateLimitPerMin
        : Math.min(Math.max(Number(patch.rateLimitPerMin) || DEFAULT_CONFIG.rateLimitPerMin, 1), 120),
      managedUrl: patch.managedUrl === undefined
        ? current.managedUrl
        : normalizeEvoUrl(patch.managedUrl),
      updatedAt: new Date().toISOString()
    };

    // An omitted key keeps the stored secret; an explicit empty string clears
    // it, so the integration can be revoked without wiping the setup.
    let managedAdminKey = current.managedAdminKey;
    if (patch.managedAdminKey !== undefined) managedAdminKey = String(patch.managedAdminKey).trim();

    if (next.enabled && !next.webhookBaseUrl) {
      throw new WaError(
        'Informe a URL pública do webhook antes de ativar a integração: é por ela que o servidor Evolution devolve QR, mensagens e recibos.',
        { code: 'incomplete_config', status: 400 }
      );
    }

    await AppState.upsert(CONFIG_KEY, JSON.stringify({
      ...next,
      managedAdminKey: managedAdminKey ? encryptSecret(adminKeyBox, managedAdminKey) : null
    }));
    this.invalidateConfigCache();
    return this.getPublicConfig();
  }

  /**
   * The webhook URL has to be absolute and reachable from outside — it is
   * written into the Evolution server, not into a browser.
   *
   * Plain http is accepted because a lab Evolution on the same LAN is a real
   * setup, but the host still goes through the SSRF literal check at use time.
   */
  static normalizeWebhookBaseUrl(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new WaError('URL do webhook inválida', { code: 'invalid_webhook_url', status: 400 });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new WaError('A URL do webhook precisa ser http ou https', {
        code: 'invalid_webhook_url',
        status: 400
      });
    }
    if (url.username || url.password) {
      throw new WaError('A URL do webhook não pode conter usuário e senha', {
        code: 'invalid_webhook_url',
        status: 400
      });
    }
    // Query and hash are stripped because the secret is appended as `?t=` later;
    // an existing query would make the token stop parsing as one.
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  }

  /**
   * Validates a target Evolution server: allowed by the operator, and public.
   *
   * Called at the POINT OF USE, not only when an account is created. In the
   * source system the allowlist was checked at creation and the row was
   * writable afterwards, which made the check decorative.
   */
  static async assertTarget(baseUrl, config) {
    const url = normalizeEvoUrl(baseUrl);
    if (!url) {
      throw new WaError('URL do servidor Evolution não configurada', {
        code: 'invalid_base_url',
        status: 400
      });
    }
    if (!isHostAllowed(url, config.allowedHosts)) {
      throw new WaError('Servidor Evolution fora da lista autorizada', {
        code: 'host_not_allowed',
        status: 400
      });
    }
    try {
      await assertPublicUrl(url);
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        throw new WaError(`Servidor Evolution recusado: ${error.message}`, {
          code: 'blocked_host',
          status: 400
        });
      }
      throw error;
    }
    return url;
  }

  // ── Per-account secrets ────────────────────────────────────────────

  static encryptInstanceToken(token) {
    const box = encryptSecret(instanceTokenBox, token);
    return { token_ciphertext: box.password_ciphertext, token_iv: box.password_iv, token_tag: box.password_tag };
  }

  static decryptInstanceToken(row) {
    return instanceTokenBox.decrypt({
      password_ciphertext: row?.token_ciphertext,
      password_iv: row?.token_iv,
      password_tag: row?.token_tag
    }) ?? '';
  }

  static encryptWebhookToken(token) {
    const box = encryptSecret(webhookTokenBox, token);
    return {
      webhook_token_ciphertext: box.password_ciphertext,
      webhook_token_iv: box.password_iv,
      webhook_token_tag: box.password_tag
    };
  }

  static decryptWebhookToken(row) {
    return webhookTokenBox.decrypt({
      password_ciphertext: row?.webhook_token_ciphertext,
      password_iv: row?.webhook_token_iv,
      password_tag: row?.webhook_token_tag
    }) ?? '';
  }

  /**
   * The account shape the browser may see.
   *
   * Built field by field rather than by deleting keys from the row — the same
   * reason `evolutionApi.readInstances()` does it, and the reason is that a
   * column added later would otherwise leak by default.
   */
  static publicAccount(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      label: row.label || null,
      purpose: row.purpose,
      flavor: row.flavor,
      baseUrl: row.base_url,
      status: row.status,
      qrCode: row.qr_code || null,
      qrUpdatedAt: row.qr_updated_at || null,
      phoneE164: row.phone_e164 || null,
      isDefault: Boolean(row.is_default),
      lastSeenAt: row.last_seen_at || null,
      lastError: row.last_error || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };
  }
}

export { CONFIG_KEY, DEFAULT_CONFIG };
export default WhatsAppConfigService;
