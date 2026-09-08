import AppState from '../models/AppState.js';
import CustomerAccount from '../models/CustomerAccount.js';
import SgpLink from '../models/SgpLink.js';
import DeviceService from './deviceService.js';
import { createSecretBox } from '../utils/secretBox.js';

const CONFIG_KEY = 'sgp_integration_config';
const SYNC_STATE_KEY = 'sgp_sync_last_run';
const CONFIG_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
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
  unlock: '/api/ura/liberacao/'
});

export const LINK_MODES = Object.freeze(['pppoe', 'customer_id', 'manual']);

export const CONTRACT_STATES = Object.freeze(['active', 'blocked', 'cancelled', 'unknown']);

const CONTRACT_STATE_PATTERNS = Object.freeze({
  cancelled: /cancelad|encerrad|desativad|inativ/,
  blocked: /bloquead|suspens|inadimplen/,
  active: /ativo/
});

const tokenBox = createSecretBox('skygenpanel-sgp-token-v1');

export class SgpError extends Error {
  constructor(message, { code = 'sgp_error', status = 502, details = null } = {}) {
    super(message);
    this.name = 'SgpError';
    this.code = code;
    this.status = status;
    this.details = details;
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

function firstArray(payload, names) {
  const direct = pick(payload, names);
  if (Array.isArray(direct)) return direct;
  if (direct && typeof direct === 'object') return [direct];
  if (Array.isArray(payload)) return payload;
  return [];
}

function normalizeContract(entry) {
  const contract = asText(pick(entry, ['contrato', 'contratoId', 'idContrato', 'contract']));
  if (!contract) return null;
  return {
    contract,
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

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  baseUrl: '',
  app: '',
  linkMode: 'pppoe',
  portalBilling: true,
  portalUnlock: false,
  invoiceLimit: 6,
  endpoints: DEFAULT_ENDPOINTS
});

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
      throw new SgpError('Informe uma URL válida do SGP (https://provedor.sgp.net.br)', {
        code: 'invalid_base_url',
        status: 400
      });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new SgpError('A URL do SGP deve usar HTTP ou HTTPS', {
        code: 'invalid_base_url',
        status: 400
      });
    }
    if (url.username || url.password) {
      throw new SgpError('A URL do SGP não pode conter usuário ou senha', {
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
      throw new SgpError('Os caminhos da API do SGP devem ser relativos, como /api/ura/titulos/', {
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
      updatedAt: stored.updatedAt || null
    };
    this.configCache = { value: config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
    return config;
  }

  static async getPublicConfig() {
    const config = await this.getConfig();
    const { token, ...rest } = config;
    return {
      ...rest,
      tokenConfigured: Boolean(token),
      ready: this.isReady(config)
    };
  }

  static isReady(config) {
    return Boolean(config.enabled && config.baseUrl && config.app && config.token);
  }

  static requireReady(config) {
    if (!this.isReady(config)) {
      throw new SgpError('Integração com o SGP não está configurada', {
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
      throw new SgpError('Informe URL, app e token do SGP antes de ativar a integração', {
        code: 'incomplete_config',
        status: 400
      });
    }

    await AppState.upsert(CONFIG_KEY, JSON.stringify({
      ...next,
      token: token ? encryptToken(token) : null
    }));
    this.invalidateConfigCache();
    return this.getPublicConfig();
  }

  static async request(endpointKey, payload = {}, configOverride = null) {
    const config = this.requireReady(configOverride || await this.getConfig());

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
        throw new SgpError('O SGP não respondeu dentro do tempo limite', {
          code: 'timeout',
          status: 504
        });
      }
      throw new SgpError('Não foi possível conectar ao SGP', {
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
      throw new SgpError('O SGP recusou as credenciais de integração (app/token)', {
        code: 'unauthorized',
        status: 502
      });
    }
    if (!response.ok) {
      throw new SgpError(`O SGP respondeu com status ${response.status}`, {
        code: 'http_error',
        status: 502,
        details: asText(pick(data || {}, ['msg', 'mensagem', 'message', 'erro'])) || undefined
      });
    }
    if (data === null) {
      throw new SgpError('Resposta inválida do SGP', {
        code: 'invalid_response',
        status: 502
      });
    }

    const statusFlag = pick(data, ['status']);
    const message = asText(pick(data, ['msg', 'mensagem', 'message', 'erro']));
    const failed = statusFlag !== null &&
      ['0', 'erro', 'error', 'false'].includes(String(statusFlag).trim().toLowerCase());
    if (failed) {
      throw new SgpError(message || 'O SGP retornou um erro para esta consulta', {
        code: 'sgp_rejected',
        status: 502
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
      throw new SgpError('Informe CPF/CNPJ, contrato ou login PPPoE para consultar o SGP', {
        code: 'missing_filter',
        status: 400
      });
    }
    return payload;
  }

  static async lookupCustomer(filters, configOverride = null) {
    const data = await this.request(
      'customer',
      this.buildLookupPayload(filters),
      configOverride
    );
    const contracts = firstArray(data, ['contratos', 'contrato', 'dados', 'data', 'clientes'])
      .map((entry) => normalizeContract(entry))
      .filter(Boolean);
    return {
      contracts,
      message: asText(pick(data, ['msg', 'mensagem', 'message']))
    };
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
      throw new SgpError('Contrato do SGP é obrigatório para a liberação', {
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
      state: deriveContractState(contract),
      login: contract.login ? String(contract.login).slice(0, 255) : null,
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
    const config = this.requireReady(await this.getConfig());
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
      throw new SgpError(
        'Este ONT ainda não tem contrato do SGP vinculado. Faça o vínculo manual ou verifique o login PPPoE.',
        { code: 'unlinked', status: 404 }
      );
    }

    const { contracts } = await this.lookupCustomer(filters, config);
    const contract = this.pickContract(contracts, preferredContract);
    if (!contract) {
      if (stored) return { link: stored, account, source: 'cache' };
      throw new SgpError('Nenhum contrato do SGP encontrado para este ONT', {
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
    const config = this.requireReady(await this.getConfig());
    const { contracts } = await this.lookupCustomer({ contract, document }, config);
    const selected = this.pickContract(contracts, contract);
    if (!selected) {
      throw new SgpError('Contrato não encontrado no SGP', { code: 'not_found', status: 404 });
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

  // Fleet-wide refresh of every device that has a customer account.
  // `linked` counts the devices that hold a link once the run is over, so it
  // also covers the ones whose refresh failed but whose cached link survived.
  // `skipped` covers devices with no identifier for the configured link mode
  // and lookups that matched no contract, however SGP phrased that answer;
  // `failed` covers real SGP errors only.
  static async syncFleet() {
    const config = this.requireReady(await this.getConfig());
    const startedAt = new Date();
    const accounts = await CustomerAccount.getSyncTargets();
    const stored = new Map(
      (await SgpLink.getAll()).map((link) => [link.device_id, link])
    );
    const summary = {
      total: accounts.length,
      linked: 0,
      created: 0,
      updated: 0,
      failed: 0,
      skipped: 0
    };

    let cursor = 0;
    const worker = async () => {
      while (cursor < accounts.length) {
        const account = accounts[cursor];
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
      { length: Math.min(SYNC_CONCURRENCY, accounts.length) },
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
      throw new SgpError('Informe URL, app e token do SGP para testar a conexão', {
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
          throw new SgpError('O SGP recusou as credenciais de integração (app/token)', {
            code: 'unauthorized',
            status: 502
          });
        }
        return {
          contracts: 0,
          probe: hasSample ? 'filtered' : 'anonymous',
          message: `Conexão e credenciais aceitas pelo SGP. Resposta: ${error.message}`
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
