import AppState from '../models/AppState.js';
import crypto from 'node:crypto';
import { createSecretBox } from '../utils/secretBox.js';
import { TenantCache } from '../config/tenantCache.js';
import { ASAAS_WEBHOOK_PATH } from '../config/asaasWebhookPath.js';
import { BASE_URLS, ENVIRONMENTS } from './billing/asaasSettingsService.js';
import { AsaasError, testConnection as asaasTestConnection } from './billing/asaasClient.js';

/**
 * A conta Asaas DO PROVEDOR — a que cobra os assinantes dele.
 *
 * Não é a conta da plataforma (`asaasSettingsService`), que cobra os
 * provedores: são duas contas, duas chaves e dois donos. As duas usam o mesmo
 * cliente HTTP, que recebe a credencial por parâmetro.
 *
 * ## O endereço não é digitado
 *
 * O SGP é um servidor do próprio provedor, e por isso aceita o endereço que ele
 * digita. O Asaas é um serviço único com duas bases fixas; o provedor escolhe
 * o AMBIENTE (`sandbox` ou `production`) e o endereço vem de `BASE_URLS`.
 * Nenhum texto do inquilino vira destino de uma chamada que leva a chave da API.
 *
 * ## Onde mora
 *
 * No `app_state` do próprio provedor (`tdb` já filtra por inquilino), com a
 * chave cifrada no mesmo molde do token do SGP — contexto próprio, para que um
 * texto cifrado de um recurso nunca decifre como outro.
 */

export const CONFIG_KEY = 'asaas_provider_config';
const SECRET_CONTEXT = 'skygenpanel-asaas-provider-key-v1';
const CACHE_TTL_MS = 30_000;

const box = createSecretBox(SECRET_CONTEXT);
// Contexto próprio: o texto cifrado de um segredo nunca decifra como o outro.
const WEBHOOK_SECRET_CONTEXT = 'skygenpanel-asaas-provider-webhook-v1';
const webhookBox = createSecretBox(WEBHOOK_SECRET_CONTEXT);

/** As chaves do Asaas: `$aact_prod_…` em produção, `$aact_hmlg_…` no sandbox. */
const KEY_FAMILY = Object.freeze({ production: '_prod_', sandbox: '_hmlg_' });
const KEY_MAX_LENGTH = 512;

export class AsaasProviderError extends Error {
  constructor(message, { code = 'asaas_provider_error', status = 400, vars = null } = {}) {
    super(message);
    this.name = 'AsaasProviderError';
    this.code = code;
    this.status = status;
    this.translationKey = message;
    this.translationVars = vars;
  }
}

/** De quanto em quanto tempo a importação roda sozinha, em horas. */
export const SYNC_INTERVAL_HOURS = Object.freeze({ min: 1, max: 168, default: 24 });

function clampInterval(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(SYNC_INTERVAL_HOURS.max, Math.max(SYNC_INTERVAL_HOURS.min, Math.round(n)));
}

const DEFAULTS = Object.freeze({
  enabled: false,
  environment: 'sandbox',
  apiKey: null,
  importCustomers: true,
  importCharges: true,
  botLookup: false,
  allowWriteCustomers: false,
  billingEnabled: false,
  webhookEnabled: false,
  webhookToken: null,
  syncEnabled: false,
  syncIntervalHours: SYNC_INTERVAL_HOURS.default,
  accountName: null,
  lastTestAt: null,
  updatedAt: null
});

function encryptWebhook(value) {
  return value ? { v: 1, ...webhookBox.encrypt(value) } : null;
}

function decryptWebhook(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  try {
    const { v, ...payload } = envelope;
    return webhookBox.decrypt(payload) || null;
  } catch {
    return null;
  }
}

function encrypt(value) {
  return value ? { v: 1, ...box.encrypt(value) } : null;
}

function decrypt(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  try {
    const { v, ...payload } = envelope;
    return box.decrypt(payload) || null;
  } catch {
    return null;
  }
}

/** A chave só vale no ambiente da família dela; uma chave sem família conhecida passa. */
function assertKeyMatchesEnvironment(key, environment) {
  const other = environment === 'production' ? 'sandbox' : 'production';
  if (key.includes(KEY_FAMILY[other]) && !key.includes(KEY_FAMILY[environment])) {
    throw new AsaasProviderError('asaas.error.keyEnvironmentMismatch', {
      code: 'key_environment_mismatch',
      vars: { environment }
    });
  }
}

function normalizeEnvironment(value, fallback) {
  if (value === undefined) return fallback;
  if (!ENVIRONMENTS.includes(value)) {
    throw new AsaasProviderError('asaas.error.environmentInvalid', { code: 'invalid_environment' });
  }
  return value;
}

function normalizeKey(value) {
  const key = String(value ?? '').trim();
  if (key.length > KEY_MAX_LENGTH || /\s/.test(key)) {
    throw new AsaasProviderError('asaas.error.keyInvalid', { code: 'invalid_key' });
  }
  return key;
}

class AsaasProviderService {
  static configCache = new TenantCache(CACHE_TTL_MS);

  static invalidateConfigCache() {
    this.configCache.invalidate();
  }

  static async getConfig() {
    const cached = this.configCache.get();
    if (cached) return cached;
    const raw = await AppState.get(CONFIG_KEY);
    let stored = {};
    if (raw) {
      try { stored = JSON.parse(raw) || {}; } catch { stored = {}; }
    }
    const config = {
      enabled: stored.enabled === true,
      environment: ENVIRONMENTS.includes(stored.environment) ? stored.environment : DEFAULTS.environment,
      apiKey: decrypt(stored.apiKey),
      importCustomers: stored.importCustomers !== false,
      importCharges: stored.importCharges !== false,
      // Desligado por padrão: ligar muda o que o bot responde aos assinantes.
      botLookup: stored.botLookup === true,
      // Escrever na conta do provedor é opt-in, como o chamado do SGP: desligado.
      allowWriteCustomers: stored.allowWriteCustomers === true,
      // A régua e as campanhas cobrarem o Asaas manda mensagem a mais gente: desligado.
      billingEnabled: stored.billingEnabled === true,
      webhookEnabled: stored.webhookEnabled === true,
      webhookToken: decryptWebhook(stored.webhookToken),
      syncEnabled: stored.syncEnabled === true,
      syncIntervalHours: clampInterval(stored.syncIntervalHours, SYNC_INTERVAL_HOURS.default),
      accountName: stored.accountName ? String(stored.accountName) : null,
      lastTestAt: stored.lastTestAt || null,
      updatedAt: stored.updatedAt || null
    };
    return this.configCache.set(config);
  }

  /** O que o navegador recebe: nunca a chave, só se ela existe. */
  static async getPublicConfig() {
    const config = await this.getConfig();
    const { apiKey, webhookToken, ...rest } = config;
    return {
      ...rest,
      apiKeyConfigured: Boolean(apiKey),
      webhookTokenConfigured: Boolean(webhookToken),
      webhookPath: ASAAS_WEBHOOK_PATH,
      ready: this.isReady(config)
    };
  }

  static isReady(config) {
    return Boolean(config.enabled && config.apiKey);
  }

  static credentialOf(config) {
    return { apiKey: config.apiKey, baseUrl: BASE_URLS[config.environment] };
  }

  /**
   * Grava. Chave omitida mantém a guardada; `''` apaga (e desliga) — o mesmo
   * contrato do token do SGP, para o provedor revogar sem perder o resto.
   *
   * Trocar de ambiente exige a chave nova: a guardada é da família do ambiente
   * antigo, e mantê-la mandaria uma chave de produção ao sandbox (ou o
   * contrário) na chamada seguinte.
   */
  static async saveConfig(patch = {}) {
    const current = await this.getConfig();
    const environment = normalizeEnvironment(patch.environment, current.environment);

    let apiKey = current.apiKey;
    if (patch.apiKey !== undefined) {
      apiKey = normalizeKey(patch.apiKey);
    } else if (apiKey && environment !== current.environment) {
      throw new AsaasProviderError('asaas.error.keyRequiredForEnvironment', {
        code: 'key_required', vars: { environment }
      });
    }
    if (apiKey) assertKeyMatchesEnvironment(apiKey, environment);

    let enabled = patch.enabled === undefined ? current.enabled : patch.enabled === true;
    if (patch.apiKey === '') enabled = false;
    if (enabled && !apiKey) {
      throw new AsaasProviderError('asaas.error.configIncomplete', { code: 'incomplete_config' });
    }

    const webhookEnabled = patch.webhookEnabled === undefined ? current.webhookEnabled : patch.webhookEnabled === true;
    if (webhookEnabled && !current.webhookToken) {
      throw new AsaasProviderError('asaas.error.webhookTokenRequired', { code: 'webhook_token_required' });
    }

    const keyChanged = apiKey !== current.apiKey || environment !== current.environment;
    await AppState.upsert(CONFIG_KEY, JSON.stringify({
      enabled,
      environment,
      apiKey: encrypt(apiKey),
      importCustomers: patch.importCustomers === undefined ? current.importCustomers : patch.importCustomers === true,
      importCharges: patch.importCharges === undefined ? current.importCharges : patch.importCharges === true,
      botLookup: patch.botLookup === undefined ? current.botLookup : patch.botLookup === true,
      allowWriteCustomers: patch.allowWriteCustomers === undefined ? current.allowWriteCustomers : patch.allowWriteCustomers === true,
      billingEnabled: patch.billingEnabled === undefined ? current.billingEnabled : patch.billingEnabled === true,
      webhookEnabled,
      // O token só muda pelo `rotateWebhookToken`; aqui ele é preservado.
      webhookToken: encryptWebhook(current.webhookToken),
      syncEnabled: patch.syncEnabled === undefined ? current.syncEnabled : patch.syncEnabled === true,
      syncIntervalHours: patch.syncIntervalHours === undefined
        ? current.syncIntervalHours
        : clampInterval(patch.syncIntervalHours, current.syncIntervalHours),
      // O nome da conta é o do ÚLTIMO teste com esta chave; outra chave, outro nome.
      accountName: keyChanged ? null : current.accountName,
      lastTestAt: keyChanged ? null : current.lastTestAt,
      updatedAt: new Date().toISOString()
    }));
    this.invalidateConfigCache();
    return this.getPublicConfig();
  }

  /**
   * Testa a chave — a digitada ainda não salva, ou a guardada. O resultado do
   * teste da chave guardada é gravado (nome da conta e hora), para a tela
   * dizer de quem é a conta sem outro clique.
   */
  static async testConnection({ apiKey, environment } = {}) {
    const current = await this.getConfig();
    const typed = apiKey !== undefined && String(apiKey).trim() !== '';
    const env = normalizeEnvironment(environment, current.environment);
    const key = typed ? normalizeKey(apiKey) : current.apiKey;
    if (!key) throw new AsaasProviderError('asaas.error.keyMissing', { code: 'not_configured', status: 409 });
    if (!typed && env !== current.environment) {
      throw new AsaasProviderError('asaas.error.keyRequiredForEnvironment', {
        code: 'key_required', vars: { environment: env }
      });
    }
    assertKeyMatchesEnvironment(key, env);

    let result;
    try {
      result = await asaasTestConnection({ apiKey: key, baseUrl: BASE_URLS[env] });
    } catch (error) {
      throw this.translateGatewayError(error);
    }

    if (!typed) {
      const stored = await AppState.get(CONFIG_KEY);
      let parsed = {};
      try { parsed = JSON.parse(stored || '{}') || {}; } catch { parsed = {}; }
      await AppState.upsert(CONFIG_KEY, JSON.stringify({
        ...parsed,
        accountName: result.accountName,
        lastTestAt: new Date().toISOString()
      }));
      this.invalidateConfigCache();
    }
    return { accountName: result.accountName, environment: env };
  }

  /**
   * Gera um token novo para a entrega do webhook e o devolve — a ÚNICA vez que
   * ele sai do servidor. O anterior deixa de valer na hora: quem girou precisa
   * colar o novo no painel do Asaas, e é por isso que a tela o mostra uma vez só.
   */
  static async rotateWebhookToken() {
    const current = await this.getConfig();
    const token = crypto.randomBytes(32).toString('hex');
    const raw = await AppState.get(CONFIG_KEY);
    let stored = {};
    if (raw) {
      try { stored = JSON.parse(raw) || {}; } catch { stored = {}; }
    }
    await AppState.upsert(CONFIG_KEY, JSON.stringify({
      ...stored,
      webhookToken: encryptWebhook(token),
      // Girar não liga sozinho: ligar é decisão do provedor, depois de colar o token lá.
      webhookEnabled: current.webhookEnabled,
      updatedAt: new Date().toISOString()
    }));
    this.invalidateConfigCache();
    return { token, config: await this.getPublicConfig() };
  }

  /**
   * O erro do gateway em chave de tradução. O corpo do erro do Asaas não vai
   * para o navegador: o que ele diz é diagnóstico, e a tela precisa de uma
   * frase que diga o que o provedor faz em seguida.
   */
  static translateGatewayError(error) {
    if (error instanceof AsaasProviderError) return error;
    if (!(error instanceof AsaasError)) return error;
    const byCode = {
      unauthorized: ['asaas.error.unauthorized', 401],
      unreachable: ['asaas.error.unreachable', 502],
      blocked_host: ['asaas.error.unreachable', 502],
      gateway_error: ['asaas.error.gatewayDown', 502]
    };
    // O motivo que o próprio Asaas deu (em português: "CPF/CNPJ inválido") vale
    // mais que "recusou o pedido" — é o que o operador precisa para corrigir.
    const reason = error.code === 'refused' ? error.errors?.[0]?.description : null;
    if (reason) {
      return new AsaasProviderError('asaas.error.refusedWith', { code: error.code, status: 400, vars: { reason } });
    }
    const [key, status] = byCode[error.code] || ['asaas.error.refused', 502];
    // 401 do Asaas não é "sessão do painel expirada": o painel usa o status
    // para isso, então a recusa da chave sobe como 400.
    return new AsaasProviderError(key, {
      code: error.code,
      status: error.code === 'unauthorized' ? 400 : status
    });
  }
}

export default AsaasProviderService;
