import Setting from '../models/Setting.js';
import CustomerAccount from '../models/CustomerAccount.js';
import VendorService from './vendorService.js';
import {
  PPPOE_FALLBACK_PATHS,
  RX_POWER_FALLBACK_PATHS,
  findPppoeUsername,
  findRxPowerReading,
  normalizeRxPowerReading
} from './deviceParameterFallbacks.js';
import Vendor from '../models/Vendor.js';
import WifiSecurityConfig from '../models/WifiSecurityConfig.js';
import AppState from '../models/AppState.js';
import { DEFAULT_SETTINGS } from '../config/seed.js';
import { TranslatableError } from '../i18n/index.js';
import { currentTenantId } from '../config/tenantContext.js';
import GenieAcsEgress from './genieacsEgress.js';
import GenieAcsAuthService from './genieacsAuthService.js';

const WAN_PARAMETER_CANDIDATES = Object.freeze({
  vlan: [
    'X_ZTE-COM_VLANID',
    'X_HW_VLAN',
    'X_CMCC_VLANIDMark',
    'VLANID',
    'X_CT-COM_WANEponLinkConfig.VLANIDMark'
  ],
  serviceList: [
    'X_ZTE-COM_ServiceList',
    'X_HW_SERVICELIST',
    'X_FH_ServiceList',
    'ServiceList'
  ],
  bindings: [
    'X_HW_LANBIND'
  ]
});

class DeviceService {
  /**
   * One dashboard cache per provider.
   *
   * The shape is unchanged; what changed is that there is no longer a single
   * one. It holds device and fault counts — a provider's own subscribers — and
   * `promise` collapses concurrent refreshes onto one. Shared, the second
   * provider to ask did not merely read stale numbers: it awaited the first
   * provider's in-flight refresh and was handed that result.
   */
  static dashboardCaches = new Map();

  static dashboardCacheFor() {
    const id = currentTenantId();
    let cache = this.dashboardCaches.get(id);
    if (!cache) {
      cache = { data: null, expiresAt: 0, promise: null, hydrated: false };
      this.dashboardCaches.set(id, cache);
    }
    return cache;
  }

  /** This provider's dashboard is stale — something it owns just changed. */
  static invalidateDashboard() {
    this.dashboardCacheFor().expiresAt = 0;
  }

  /** Every provider's. For a reset between tests. */
  static forgetDashboards() {
    this.dashboardCaches.clear();
  }

  static dashboardCacheTtlMs = 60_000;

  static getParameterNode(obj, parameterPath) {
    if (!obj || !parameterPath) return null;
    let current = obj;
    for (const part of String(parameterPath).split('.')) {
      if (!current || typeof current !== 'object') return null;
      current = current[part];
    }
    return current ?? null;
  }

  static getParameterValue(obj, parameterPath) {
    return this.readNodeValue(this.getParameterNode(obj, parameterPath));
  }

  /** The display value of a node the caller already holds. */
  static readNodeValue(node) {
    if (node && typeof node === 'object' && '_value' in node) {
      return this.normalizeParameterValue(node._value);
    }
    return this.normalizeParameterValue(node);
  }

  /** A parameter GenieACS answers with an empty string has told us nothing. */
  static hasReportedValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
  }

  /**
   * The subscriber login, and where it was read.
   *
   * The operator's VirtualParameter is authoritative and is tried first; the
   * ONT's own WAN tree is consulted only when it answered with nothing, which
   * is what a GenieACS without the panel's VirtualParameter scripts does for
   * every device in the fleet.
   */
  static resolvePppoeUsername(item, virtualParams) {
    const configured = this.getParameterValue(item, virtualParams.vpPppoeUsername);
    if (this.hasReportedValue(configured)) {
      return { value: configured, path: virtualParams.vpPppoeUsername };
    }
    const found = findPppoeUsername(item, (node) => this.readNodeValue(node));
    return found || { value: null, path: virtualParams.vpPppoeUsername };
  }

  /**
   * The optical RX power in dBm, and where it was read. Same order as the
   * login: the configured VirtualParameter first, and its value untouched —
   * only a vendor reading has to be normalized, because only there does the
   * panel not know what unit it asked for.
   *
   * `learnedPaths` are the paths this installation was seen to publish the
   * reading at (see `ensureRxPowerPaths`). They are tried before the
   * catalogue because they are known to be right for this fleet rather than
   * for some fleet.
   */
  static resolveRxPower(item, virtualParams, learnedPaths = []) {
    const configured = this.getParameterValue(item, virtualParams.vpRxPower);
    if (this.hasReportedValue(configured)) {
      return { value: configured, path: virtualParams.vpRxPower };
    }
    for (const path of [...learnedPaths, ...RX_POWER_FALLBACK_PATHS]) {
      if (!path) continue;
      const normalized = normalizeRxPowerReading(this.getParameterValue(item, path));
      if (normalized !== null) return { value: normalized, path };
    }
    // Nothing the panel could name; fall back to reading the document for
    // anything that calls itself an RX power. Only the detail page and the
    // discovery probe project enough of the tree for this to find something.
    const scanned = findRxPowerReading(item, (node) => this.readNodeValue(node));
    if (scanned) return scanned;
    return { value: null, path: virtualParams.vpRxPower };
  }

  static normalizeParameterValue(value) {
    if (value === null || value === undefined) return null;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[1] === 'string' &&
      /^(?:xsd:|xs:)/i.test(value[1])
    ) {
      return this.normalizeParameterValue(value[0]);
    }
    // GenieACS returns metadata-only nodes such as {_object, _writable} when a
    // projected parameter has no current value. These are not display values.
    if (typeof value === 'object') return null;
    return value;
  }

  static isEnabledValue(value) {
    const normalized = this.normalizeParameterValue(value);
    if (normalized === true || normalized === 1) return true;
    if (typeof normalized !== 'string') return false;
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(
      normalized.trim().toLowerCase()
    );
  }

  static resolveParameterPath(basePath, configuredPath) {
    if (!configuredPath) return null;
    if (
      configuredPath.startsWith('InternetGatewayDevice.') ||
      configuredPath.startsWith('Device.') ||
      configuredPath.startsWith('VirtualParameters.')
    ) {
      return configuredPath;
    }
    return `${basePath}.${configuredPath.replace(/^\.+/, '')}`;
  }

  static findWanParameter(item, basePath, configuredPath, candidates = []) {
    const requested = [configuredPath, ...candidates].filter(Boolean);
    const unique = [...new Set(requested)];
    for (const parameterPath of unique) {
      const fullPath = this.resolveParameterPath(basePath, parameterPath);
      const node = this.getParameterNode(item, fullPath);
      if (node === null) continue;
      const writableValue = node && typeof node === 'object'
        ? this.normalizeParameterValue(node._writable)
        : null;
      return {
        path: fullPath,
        node,
        value: this.getParameterValue(item, fullPath),
        writable: writableValue !== false && writableValue !== 0
      };
    }
    return null;
  }

  static async getGenieAcsUrl() {
    const settings = await Setting.getAll();
    return settings.genieAcsUrl;
  }

  static async getGenieAcsRootUrl() {
    const baseUrl = await this.getGenieAcsUrl();
    if (!baseUrl) {
      throw new Error('GenieACS URL not configured');
    }
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('GenieACS URL must use HTTP or HTTPS');
    }
    if (url.username || url.password) {
      throw new Error('Credentials in the GenieACS URL are not supported');
    }
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  }

  static async getVirtualParameters() {
    const settings = await Setting.getAll();

    return Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS)
        .filter((key) => key.startsWith('vp'))
        .map((key) => [key, settings[key] ?? DEFAULT_SETTINGS[key]])
    );
  }

  static async getDevicesBaseUrl() {
    return `${await this.getGenieAcsRootUrl()}/devices`;
  }

  /**
   * The failure a GenieACS response should be reported as.
   *
   * The upstream body never reaches the caller. It is written by whatever host
   * answers at the configured URL, so relaying it turns any failed request into
   * a read oracle: point the base URL at an internal service and the panel
   * hands its response straight back over the API. The status stays, because an
   * operator has to tell a misconfiguration from an outage, and the body is
   * logged here, truncated, where only the server can see it.
   *
   * A 3xx is called out on its own: `GenieAcsEgress` never follows a redirect,
   * which is what `redirect: 'manual'` at the call sites asks for, so one
   * arrives as a not-ok response and would otherwise read as an upstream bug
   * rather than as what it is — an allowed host trying to walk the request
   * somewhere we never agreed to reach.
   *
   * `knownBody` is for the one caller that already consumed the body; a second
   * read of it yields nothing.
   */
  static async genieAcsError(label, response, knownBody = undefined) {
    const body = knownBody === undefined
      ? await response.text().catch(() => '')
      : knownBody;
    if (body) {
      console.error(`${label} failed with status ${response.status}: ${String(body).slice(0, 200)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      return new Error(
        `${label} answered with a redirect (status: ${response.status}); the configured GenieACS URL must serve the request itself`
      );
    }
    return new Error(`${label} responded with status: ${response.status}`);
  }

  static async fetchGenieAcsCollection(collection, query = {}, method = 'GET', body = null, timeoutMs = 15_000) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(collection))) {
      throw new Error('Invalid GenieACS collection name');
    }
    const root = await this.getGenieAcsRootUrl();
    const url = new URL(`${root}/${collection}`);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const options = {
        method,
        headers: await GenieAcsAuthService.nbiHeaders(),
        signal: controller.signal,
        redirect: 'manual'
      };
      if (body !== null && body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const response = await GenieAcsEgress.fetch(url, options);
      if (!response.ok) {
        throw await this.genieAcsError(`GenieACS ${collection} API`, response);
      }
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Every request is built from the configured base, never from the endpoint.
   * The endpoint used to be allowed to be an absolute URL, which meant any
   * caller that let one through reached a host the operator never configured —
   * and the base URL becomes provider-supplied data, so the endpoint is the
   * side of this that must not be able to choose the destination.
   */
  static async buildGenieAcsUrl(endpoint = '', query = {}) {
    const base = await this.getDevicesBaseUrl();

    let urlStr;
    if (!endpoint) {
      urlStr = base;
    } else if (endpoint.startsWith('?')) {
      urlStr = `${base}${endpoint}`;
    } else {
      urlStr = `${base}/${endpoint.replace(/^\/+/, '')}`;
    }

    const url = new URL(urlStr);
    Object.keys(query || {}).forEach(key => {
      if (query[key] !== undefined && query[key] !== null) {
        url.searchParams.append(key, query[key]);
      }
    });
    return url;
  }

  static async fetchFromGenieAcs(endpoint, query = {}, method = 'GET', body = null) {
    try {
      const url = await this.buildGenieAcsUrl(endpoint, query);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const options = {
          method,
          headers: await GenieAcsAuthService.nbiHeaders(),
          signal: controller.signal,
          redirect: 'manual'
        };
        if (body !== null && body !== undefined) {
          options.headers['Content-Type'] = 'application/json';
          options.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        const response = await GenieAcsEgress.fetch(url, options);

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw await this.genieAcsError('GenieACS API', response);
        }

        const text = await response.text();
        return text ? JSON.parse(text) : null;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } catch (error) {
      console.error('Error fetching from GenieACS:', error);
      throw error;
    }
  }

  /** Full device document, the shape the vendor-aware writers need. */
  static async fetchDeviceDocument(deviceId) {
    const rawDeviceData = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId })
    });
    if (!Array.isArray(rawDeviceData) || rawDeviceData.length === 0) {
      throw new TranslatableError('device.notFound', null, { status: 404 });
    }
    return rawDeviceData[0];
  }

  static ONLINE_WINDOW_MS = 10 * 60 * 1000;

  static DEVICE_PAGE_SIZE_DEFAULT = 25;

  static DEVICE_PAGE_SIZE_MAX = 100;

  static DEVICE_SEARCH_MAX_LENGTH = 128;

  /**
   * Every listing parameter arrives from the browser, so each one is coerced and
   * clamped here instead of being trusted. `page` is only bounded from below:
   * the real upper bound depends on the total, which is known further down.
   */
  static normalizeDeviceListQuery(query = {}) {
    const rawPage = Number.parseInt(String(query.page ?? ''), 10);
    const rawPageSize = Number.parseInt(String(query.pageSize ?? ''), 10);
    const rawStatus = String(query.status ?? 'all').trim().toLowerCase();

    return {
      page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
      pageSize: Number.isFinite(rawPageSize) && rawPageSize > 0
        ? Math.min(rawPageSize, this.DEVICE_PAGE_SIZE_MAX)
        : this.DEVICE_PAGE_SIZE_DEFAULT,
      search: String(query.search ?? '').trim().slice(0, this.DEVICE_SEARCH_MAX_LENGTH),
      status: ['online', 'offline'].includes(rawStatus) ? rawStatus : 'all'
    };
  }

  static buildDeviceListProjection(virtualParams, learnedRxPaths = []) {
    return [
      '_id',
      '_deviceId._ProductClass',
      '_deviceId._SerialNumber',
      '_deviceId._Manufacturer',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      virtualParams.vpPppoeUsername,
      virtualParams.vpWanBridge,
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      virtualParams.vpActiveDevices,
      // GenieACS returns only what a projection names, so the fallbacks have
      // to be asked for even when the VirtualParameters do answer — whether
      // they did is only known once the response is in hand.
      ...PPPOE_FALLBACK_PATHS,
      ...RX_POWER_FALLBACK_PATHS,
      ...learnedRxPaths,
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.SSID',
      '_lastInform',
      '_registered'
    ].filter(Boolean);
  }

  /**
   * Online/offline is purely a `_lastInform` comparison, and GenieACS owns that
   * field, so the whole status filter can be evaluated by the NBI. The window
   * moves with wall-clock time, hence the cutoff is recomputed per request.
   */
  static buildDeviceStatusQuery(status, now = Date.now()) {
    if (status !== 'online' && status !== 'offline') return null;
    const cutoff = new Date(now - this.ONLINE_WINDOW_MS).toISOString();
    return status === 'online'
      ? { _lastInform: { $gte: cutoff } }
      : { _lastInform: { $lt: cutoff } };
  }

  static isDeviceOnline(device, now = Date.now()) {
    const lastInform = device?._lastInform ? new Date(device._lastInform).getTime() : Number.NaN;
    const ageMs = now - lastInform;
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < this.ONLINE_WINDOW_MS;
  }

  static async fetchGenieAcsWithHeaders(query = {}) {
    const url = await this.buildGenieAcsUrl('', query);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await GenieAcsEgress.fetch(url, {
        method: 'GET',
        headers: await GenieAcsAuthService.nbiHeaders(),
        signal: controller.signal,
        redirect: 'manual'
      });
      if (!response.ok) {
        throw await this.genieAcsError('GenieACS API', response);
      }
      const text = await response.text();
      return { response, data: text ? JSON.parse(text) : null };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * The NBI reports the unpaged match count in a `total` response header. Older
   * or proxied deployments may drop it, so fall back to an `_id`-only scan,
   * which still keeps the payload tiny compared with a full projection.
   */
  static async countDevicesFromGenieAcs(queryParam) {
    const baseQuery = queryParam ? { query: queryParam } : {};
    const { response, data } = await this.fetchGenieAcsWithHeaders({
      ...baseQuery,
      projection: '_id',
      limit: 1
    });
    const rawTotal = response.headers.get('total');
    const reported = rawTotal === null || rawTotal.trim() === '' ? Number.NaN : Number(rawTotal);
    if (Number.isInteger(reported) && reported >= 0) return reported;
    if (Array.isArray(data) && data.length === 0) return 0;

    const all = await this.fetchFromGenieAcs('', { ...baseQuery, projection: '_id' });
    return Array.isArray(all) ? all.length : 0;
  }

  /**
   * Where this GenieACS was seen to publish optical RX, kept per provider
   * because two providers run two fleets.
   *
   * Stored as `{ paths, checkedAt }`. A set rather than one path because an
   * ISP's fleet is rarely one vendor, and each vendor named its own object;
   * `checkedAt` with an empty set records a probe that found nothing, so a
   * fleet that reports no optical at all is not probed again on every page.
   */
  static RX_POWER_PATH_KEY = 'rx_power_path';

  /** How long a fruitless probe is trusted before the fleet is asked again. */
  static RX_POWER_REPROBE_MS = 30 * 60 * 1000;

  /** Device documents to sample when probing. Offline ONTs report nothing. */
  static RX_POWER_PROBE_SAMPLE = 5;

  /**
   * Enough for a mixed fleet, few enough that a GenieACS that renames the
   * object every firmware cannot grow the listing's projection without end.
   */
  static RX_POWER_PATH_LIMIT = 4;

  static async readRxPowerState() {
    try {
      const raw = await AppState.get(this.RX_POWER_PATH_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      const paths = Array.isArray(state?.paths)
        ? state.paths.filter((path) => typeof path === 'string' && path)
        : [];
      return {
        paths,
        checkedAt: Number(state?.checkedAt) || 0,
        eagerUntil: Number(state?.eagerUntil) || 0
      };
    } catch {
      return null;
    }
  }

  static async writeRxPowerState(paths, extra = {}) {
    try {
      await AppState.upsert(
        this.RX_POWER_PATH_KEY,
        JSON.stringify({ paths, checkedAt: Date.now(), ...extra })
      );
    } catch (error) {
      // Losing the note only costs another probe later; it must never cost
      // the operator the page they asked for.
      console.warn(`Unable to record the optical RX paths: ${error.message}`);
    }
  }

  /** Files a newly seen path, newest first, without growing without bound. */
  static async rememberRxPowerPath(path, state = null) {
    const known = (state ?? await this.readRxPowerState())?.paths ?? [];
    if (known.includes(path)) return known;
    const paths = [path, ...known].slice(0, this.RX_POWER_PATH_LIMIT);
    await this.writeRxPowerState(paths);
    return paths;
  }

  /**
   * The paths this installation publishes optical RX at, probing for them
   * once if the panel does not know yet.
   *
   * The listing cannot simply scan for the reading the way the detail page
   * does: GenieACS returns only what a projection names, and projecting whole
   * WAN subtrees for every row of every page to find one number is not a
   * trade worth making. So the shape of the fleet is learned from a handful
   * of documents, once, and from then on the listing asks for those paths by
   * name and pays nothing.
   *
   * Never throws. A fleet whose optical path cannot be discovered is a column
   * reading N/A, which is what it already reads; it is not a broken listing.
   */
  static async ensureRxPowerPaths() {
    const state = await this.readRxPowerState();
    if (state?.paths.length) return state.paths;
    const eager = state ? Date.now() < state.eagerUntil : false;
    if (state && !eager && Date.now() - state.checkedAt < this.RX_POWER_REPROBE_MS) return [];

    const found = [];
    try {
      const rows = await this.fetchDeviceListPage(
        null,
        ['_id', 'InternetGatewayDevice.WANDevice', 'Device.Optical'],
        { limit: this.RX_POWER_PROBE_SAMPLE }
      );
      for (const row of rows) {
        const reading = findRxPowerReading(row, (node) => this.readNodeValue(node));
        if (reading && !found.includes(reading.path)) found.push(reading.path);
      }
      await this.writeRxPowerState(
        found.slice(0, this.RX_POWER_PATH_LIMIT),
        // A summon's refresh only lands when the ONT next informs, which is
        // usually after the page the operator is looking at has already
        // loaded. Dropping the window on the first probe that came back empty
        // would put the answer back behind the half-hour cooldown.
        found.length === 0 && state?.eagerUntil ? { eagerUntil: state.eagerUntil } : {}
      );
    } catch (error) {
      console.warn(`Unable to probe for the optical RX paths: ${error.message}`);
    }
    return found;
  }

  static async fetchDeviceListPage(queryParam, projection, { skip, limit } = {}) {
    const data = await this.fetchFromGenieAcs('', {
      ...(queryParam ? { query: queryParam } : {}),
      projection: projection.join(','),
      ...(Number.isInteger(skip) ? { skip } : {}),
      ...(Number.isInteger(limit) ? { limit } : {})
    });
    if (!Array.isArray(data)) {
      throw new Error('Invalid API response');
    }
    return data;
  }

  static deviceMatchesSearch(device, needle) {
    if (!needle) return true;
    return [
      device._id,
      device.SerialNumber,
      device.productclass,
      device.manufacturer,
      device.pppoe,
      device.customerId
    ].some((field) => String(field ?? '').toLowerCase().includes(needle));
  }

  /**
   * Returns one page of the inventory plus the paging metadata the UI needs.
   * Paging is pushed to GenieACS whenever nothing has to be filtered locally;
   * a free-text search always matches against the panel's own Customer IDs, so
   * that path fetches the (status-filtered) match set and pages it here.
   */
  static async getDevicesPage(options = {}) {
    const { page, pageSize, search, status } = this.normalizeDeviceListQuery(options);
    const virtualParams = await this.getVirtualParameters();
    const learnedRxPaths = await this.ensureRxPowerPaths();
    const projection = this.buildDeviceListProjection(virtualParams, learnedRxPaths);
    const statusQuery = this.buildDeviceStatusQuery(status);
    const queryParam = statusQuery ? JSON.stringify(statusQuery) : null;

    if (!search) {
      const total = await this.countDevicesFromGenieAcs(queryParam);
      const totalPages = Math.ceil(total / pageSize);
      const currentPage = totalPages > 0 ? Math.min(page, totalPages) : 1;
      // The listing has always been shown newest-first, i.e. the natural
      // GenieACS order reversed. Mapping the page onto a skip/limit taken from
      // the tail keeps that order without asking the NBI to sort.
      const end = total - (currentPage - 1) * pageSize;
      const skip = Math.max(0, end - pageSize);
      const limit = Math.max(0, end - skip);
      const rows = limit > 0
        ? await this.fetchDeviceListPage(queryParam, projection, { skip, limit })
        : [];
      return {
        devices: rows
          .map((item) => this.processDeviceData(item, virtualParams, learnedRxPaths))
          .reverse(),
        page: currentPage,
        pageSize,
        total,
        totalPages
      };
    }

    const rows = await this.fetchDeviceListPage(queryParam, projection);
    const candidates = rows
      .map((item) => this.processDeviceData(item, virtualParams, learnedRxPaths))
      .reverse();
    const customerIds = await this.lookupCustomerIds(candidates.map((device) => device._id));
    const needle = search.toLowerCase();
    const matches = candidates.filter((device) => this.deviceMatchesSearch(
      { ...device, customerId: customerIds.get(String(device._id)) || null },
      needle
    ));

    const total = matches.length;
    const totalPages = Math.ceil(total / pageSize);
    const currentPage = totalPages > 0 ? Math.min(page, totalPages) : 1;
    const offset = (currentPage - 1) * pageSize;
    return {
      devices: matches.slice(offset, offset + pageSize),
      page: currentPage,
      pageSize,
      total,
      totalPages
    };
  }

  /**
   * Read-only Customer ID lookup used while matching a search term. Account
   * creation stays in CustomerService and is only run over the returned page.
   */
  static async lookupCustomerIds(deviceIds) {
    const ids = deviceIds.map((id) => String(id ?? '')).filter(Boolean);
    const found = new Map();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const rows = await CustomerAccount.getIdsByDeviceIds(ids.slice(offset, offset + 500));
      for (const row of rows) found.set(row.device_id, row.customer_id);
    }
    return found;
  }

  static async getDashboardDevices() {
    const virtualParams = await this.getVirtualParameters();
    const projection = [
      '_id',
      '_deviceId._ProductClass',
      '_deviceId._Manufacturer',
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      virtualParams.vpActiveDevices,
      ...RX_POWER_FALLBACK_PATHS,
      '_lastInform',
      '_registered'
    ].filter(Boolean);
    const data = await this.fetchFromGenieAcs(
      `?projection=${encodeURIComponent(projection.join(','))}`
    );
    if (!Array.isArray(data)) {
      throw new Error('Invalid GenieACS dashboard response');
    }
    return data.map((item) => this.processDeviceData(item, virtualParams));
  }

  /**
   * The cheapest whole-fleet telemetry read: four parameters, one request.
   *
   * Deliberately not `fetchGenieAcsWithHeaders` — that exists to read the
   * `total` header for paging, and there is no paging here.
   *
   * `_lastInform` is part of the projection because it is the sample's time
   * axis: GenieACS only refreshes a parameter when the device informs, so the
   * inform is when the reading was actually taken.
   */
  static async getTelemetryFleet() {
    const virtualParams = await this.getVirtualParameters();
    const projection = [
      '_id',
      '_lastInform',
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      ...RX_POWER_FALLBACK_PATHS,
      'InternetGatewayDevice.DeviceInfo.UpTime'
    ].filter(Boolean);
    const data = await this.fetchFromGenieAcs(
      `?projection=${encodeURIComponent(projection.join(','))}`
    );
    if (!Array.isArray(data)) {
      throw new Error('Invalid GenieACS telemetry response');
    }
    return data.map((item) => ({
      deviceId: item._id || null,
      lastInform: item._lastInform ?? null,
      rxPower: this.resolveRxPower(item, virtualParams).value,
      temperature: this.getParameterValue(item, virtualParams.vpTemperature),
      uptime: this.getParameterValue(item, 'InternetGatewayDevice.DeviceInfo.UpTime')
    }));
  }

  static processDeviceData(item, virtualParams, learnedRxPaths = []) {
    const pppsecret = this.resolvePppoeUsername(item, virtualParams).value;
    const wanbridge = this.getParameterValue(item, virtualParams.vpWanBridge);
    const rxpower = this.resolveRxPower(item, virtualParams, learnedRxPaths).value;
    const gettemp = this.getParameterValue(item, virtualParams.vpTemperature);
    const activedevices = this.getParameterValue(item, virtualParams.vpActiveDevices);

    const deviceId = item._id || null;
    const serialNumber = item._deviceId?._SerialNumber || null;
    const typeont = item._deviceId?._ProductClass || null;
    const manufacturer = item._deviceId?._Manufacturer || null;
    const softwareId = this.getParameterValue(
      item,
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion'
    );

    const wlan = item.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
    const ssid1 = wlan['1']?.SSID?._value ?? null;
    const ssid2 = wlan['2']?.SSID?._value ?? null;
    const ssid3 = wlan['3']?.SSID?._value ?? null;
    const ssid4 = wlan['4']?.SSID?._value ?? null;
    const ssid5 = wlan['5']?.SSID?._value ?? null;
    const ssid6 = wlan['6']?.SSID?._value ?? null;
    const ssid7 = wlan['7']?.SSID?._value ?? null;
    const ssid8 = wlan['8']?.SSID?._value ?? null;

    return {
      _id: deviceId,
      SerialNumber: serialNumber,
      productclass: typeont,
      manufacturer,
      softwareId,
      pppoe: pppsecret,
      wanbridge: wanbridge,
      rxpower: rxpower,
      temperature: gettemp,
      activedevices: activedevices,
      ssid1: ssid1,
      ssid2: ssid2,
      ssid3: ssid3,
      ssid4: ssid4,
      ssid5: ssid5,
      ssid6: ssid6,
      ssid7: ssid7,
      ssid8: ssid8,
      _lastInform: item._lastInform || null,
      _registered: item._registered || null
    };
  }

  static async getDetailDevice(deviceId) {
    if (!deviceId) {
      throw new Error('Device ID is required');
    }

    const virtualParams = await this.getVirtualParameters();
    const vendorConfigurations = await Vendor.getEnabled();

    const projection = [
      '_id',
      '_deviceId._ProductClass',
      '_deviceId._SerialNumber',
      '_deviceId._Manufacturer',
      '_deviceId._OUI',
      virtualParams.vpPppoeUsername,
      virtualParams.vpWanBridge,
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      virtualParams.vpActiveDevices,
      virtualParams.vpSuperAdmin,
      virtualParams.vpSuperPassword,
      virtualParams.vpUserAdmin,
      virtualParams.vpUserPassword,
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.TotalAssociations',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.Channel',
        'VirtualParameters.SSID1-Name',
        'VirtualParameters.SSID1-Password',
        'VirtualParameters.SSID1-Security',
        'VirtualParameters.SSID5-Name',
        'VirtualParameters.SSID5-Password',
        'VirtualParameters.SSID5-Security',
        'InternetGatewayDevice.DeviceInfo.HardwareVersion',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      'InternetGatewayDevice.DeviceInfo.UpTime',
      'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress',
      'InternetGatewayDevice.LANDevice.1.Hosts.Host',
      'Device.Hosts.Host',
      'InternetGatewayDevice.WANDevice.1.WANEthernetInterfaceConfig.MACAddress',
      'InternetGatewayDevice.WANDevice',
      // `InternetGatewayDevice.WANDevice` above already carries the TR-098
      // fallbacks; these are the TR-181 ones, which sit outside it.
      ...PPPOE_FALLBACK_PATHS.filter((path) => path.startsWith('Device.')),
      ...RX_POWER_FALLBACK_PATHS.filter((path) => path.startsWith('Device.')),
      '_lastInform',
      '_lastBoot',
      '_registered'
    ];

    vendorConfigurations.forEach(vendor => {
      if (vendor.http_wan_enable_path) {
        projection.push(vendor.http_wan_enable_path);
      }
      if (vendor.firewall_level_path) {
        projection.push(vendor.firewall_level_path);
      }
    });

    const data = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId }),
      projection: projection.filter(Boolean).join(',')
    });

    if (!Array.isArray(data) || data.length === 0) {
      throw new TranslatableError('device.notFound', null, { status: 404 });
    }

    const detail = await this.processDetailDeviceData(data[0], virtualParams);
    // This page projects the whole WAN subtree, so it can find the reading by
    // scanning where the listing can only ask for paths by name. When it does,
    // the listing gets told: opening one ONT teaches the panel the fleet's
    // optical path, which is the fallback for a probe that sampled five
    // devices that happened to have nothing to report.
    await this.noteRxPowerPath(detail.virtualParameters?.rxpower);
    return detail;
  }

  /**
   * Records the path a resolved reading came from, when it is a path the
   * listing could ask GenieACS for. A VirtualParameter is not one of those —
   * the listing already projects it — and neither is a reading that never
   * resolved.
   */
  static async noteRxPowerPath(resolved) {
    const path = resolved?.value === null || resolved?.value === undefined
      ? null
      : resolved?.path;
    if (!path || path.startsWith('VirtualParameters.')) return;
    const state = await this.readRxPowerState();
    if (state?.paths.includes(path)) return;
    await this.rememberRxPowerPath(path, state);
  }

  static async processDetailDeviceData(item, virtualParams) {
    const getValue = (path) => {
      return this.getParameterValue(item, path);
    };

    const getVPValue = getValue;

    const getRelativeNode = (obj, path) => {
      if (!path || !obj) return null;
      const parts = path.split('.');
      let current = obj;
      for (const part of parts) {
        if (current && typeof current === 'object') {
          current = current[part];
        } else {
          return null;
        }
      }
      return current ?? null;
    };

    const getRelativeValue = (obj, path) => {
      const current = getRelativeNode(obj, path);
      if (current && typeof current === 'object' && '_value' in current) {
        return this.normalizeParameterValue(current._value);
      }
      return this.normalizeParameterValue(current);
    };

    const manufacturer = item._deviceId?._Manufacturer || null;
    const productClass = item._deviceId?._ProductClass || null;
    
    const vendorObj = await VendorService.detectVendor(manufacturer, productClass, item);
    const vendor = vendorObj ? vendorObj.name.toLowerCase() : 'unknown';
    const vendorId = vendorObj ? vendorObj.id : null;

    const deviceInfo = {
      productclass: productClass,
      serialNumber: item._deviceId?._SerialNumber || null,
      manufacturer: manufacturer,
      oui: item._deviceId?._OUI || null,
      hardwareVersion: getValue('InternetGatewayDevice.DeviceInfo.HardwareVersion'),
      softwareVersion: getValue('InternetGatewayDevice.DeviceInfo.SoftwareVersion'),
      upTime: getValue('InternetGatewayDevice.DeviceInfo.UpTime'),
      macAddress: 
        getValue('InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress') ||
        getValue('InternetGatewayDevice.WANDevice.1.WANEthernetInterfaceConfig.MACAddress') ||
        null
    };

    const virtualParameters = {
      // The path is the one the value was actually read at, not always the
      // configured VirtualParameter: when a fallback answered, this is what
      // tells support where the panel got it.
      pppoeUsername: this.resolvePppoeUsername(item, virtualParams),
      wanBridge: {
        path: virtualParams.vpWanBridge,
        value: getVPValue(virtualParams.vpWanBridge)
      },
      rxpower: this.resolveRxPower(item, virtualParams),
      temperature: {
        path: virtualParams.vpTemperature,
        value: getVPValue(virtualParams.vpTemperature)
      },
      activedevices: {
        path: virtualParams.vpActiveDevices,
        value: getVPValue(virtualParams.vpActiveDevices)
      },
      superAdmin: {
        path: virtualParams.vpSuperAdmin,
        value: getVPValue(virtualParams.vpSuperAdmin)
      },
      superPassword: {
        path: virtualParams.vpSuperPassword,
        value: getVPValue(virtualParams.vpSuperPassword)
      },
      userAdmin: {
        path: virtualParams.vpUserAdmin,
        value: getVPValue(virtualParams.vpUserAdmin)
      },
      userPassword: {
        path: virtualParams.vpUserPassword,
        value: getVPValue(virtualParams.vpUserPassword)
      }
    };

    const wifi = [];
    const wlanConfig = item.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration;

    if (wlanConfig) {
      for (let i = 1; i <= 8; i++) {
        const ssidData = wlanConfig[i];
        if (ssidData && typeof ssidData === 'object' && !String(i).startsWith('_')) {
          const virtualPrefix = i === 1 ? 'SSID1' : i === 5 ? 'SSID5' : null;
          const virtualNamePath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Name` : null;
          const virtualPasswordPath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Password` : null;
          const virtualSecurityPath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Security` : null;
          const hasVirtualMapping = Boolean(
            virtualNamePath && this.getParameterNode(item, virtualNamePath)
          );
          const enableValue = getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Enable`);
          wifi.push({
            index: i,
            enable: enableValue === null ? null : this.isEnabledValue(enableValue),
            ssid: (virtualNamePath ? getValue(virtualNamePath) : null) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.SSID`),
            password: (virtualPasswordPath ? getValue(virtualPasswordPath) : null) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.PreSharedKey.1.KeyPassphrase`) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.KeyPassphrase`) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.PreSharedKey.1.PreSharedKey`),
            security: (virtualSecurityPath ? getValue(virtualSecurityPath) : null) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.BeaconType`),
            channel: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Channel`),
            totalAssociations: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.TotalAssociations`),
            usesVirtualParameters: hasVirtualMapping
          });
        }
      }
    }
    
    const wan = [];
    const wanContainers = [];
    const wanDevice = item.InternetGatewayDevice?.WANDevice;

    if (wanDevice) {
      for (const devKey in wanDevice) {
        if (devKey.startsWith('_')) continue;
        if (!wanDevice[devKey] || !wanDevice[devKey].WANConnectionDevice) continue;
        
        for (const connKey in wanDevice[devKey].WANConnectionDevice) {
          if (connKey.startsWith('_')) continue;
          const connDev = wanDevice[devKey].WANConnectionDevice[connKey];
          if (!connDev) continue;
          wanContainers.push({
            path: `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}`,
            label: `WAN ${devKey} / connection device ${connKey}`
          });

          const connections = [];
          for (const [collection, connType, indexType] of [
            ['WANIPConnection', 'IP', 'ip'],
            ['WANPPPConnection', 'PPPoE', 'ppp']
          ]) {
            const connectionCollection = connDev[collection];
            if (!connectionCollection) continue;
            for (const instanceKey in connectionCollection) {
              if (instanceKey.startsWith('_') || !connectionCollection[instanceKey]) continue;
              connections.push({
                connection: connectionCollection[instanceKey],
                connType,
                index: `${devKey}.${connKey}.${indexType}.${instanceKey}`,
                connPath: `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.${collection}.${instanceKey}`
              });
            }
          }

          for (const { connection, connType, connPath, index } of connections) {
            
            const vlanParameter = this.findWanParameter(
              item,
              connPath,
              vendorObj?.vlan_id_path,
              WAN_PARAMETER_CANDIDATES.vlan
            );
            const serviceParameter = this.findWanParameter(
              item,
              connPath,
              vendorObj?.service_list_path,
              WAN_PARAMETER_CANDIDATES.serviceList
            );
            const nameParameter = this.findWanParameter(item, connPath, 'Name');
            const usernameParameter = this.findWanParameter(item, connPath, 'Username');
            const passwordParameter = this.findWanParameter(item, connPath, 'Password');
            const connectionTypeParameter = this.findWanParameter(item, connPath, 'ConnectionType');
            const natParameter = this.findWanParameter(item, connPath, 'NATEnabled');

            let bindings = null;
            const bindingParameter = this.findWanParameter(
              item,
              connPath,
              vendorObj?.lan_binding_path,
              WAN_PARAMETER_CANDIDATES.bindings
            );
            if (bindingParameter) {
              const bindingObj = bindingParameter.node;
              if (bindingObj && typeof bindingObj === 'object') {
                bindings = { lan: [], ssid: [] };
                for (let i = 1; i <= 4; i++) {
                  if (this.isEnabledValue(getRelativeValue(bindingObj, `Lan${i}Enable`))) {
                    bindings.lan.push(`LAN${i}`);
                  }
                }
                for (let i = 1; i <= 8; i++) {
                  if (this.isEnabledValue(getRelativeValue(bindingObj, `SSID${i}Enable`))) {
                    bindings.ssid.push(`SSID${i}`);
                  }
                }
              }
            }
            const bindingConfigurable = bindingParameter
              ? [...Array(4)].some((_, offset) => Boolean(
                  this.findWanParameter(item, bindingParameter.path, `Lan${offset + 1}Enable`)?.writable
                )) || [...Array(8)].some((_, offset) => Boolean(
                  this.findWanParameter(item, bindingParameter.path, `SSID${offset + 1}Enable`)?.writable
                ))
              : false;

            wan.push({
              index,
              connType: connType,
              name: nameParameter?.value ?? null,
              status: getValue(`${connPath}.ConnectionStatus`),
              ipAddress: getValue(`${connPath}.ExternalIPAddress`),
              macAddress: getValue(`InternetGatewayDevice.WANDevice.${devKey}.WANEthernetInterfaceConfig.MACAddress`),
              vlanId: vlanParameter?.value ?? null,
              username: usernameParameter?.value ?? null,
              serviceList: serviceParameter?.value ?? null,
              connectionType: connectionTypeParameter?.value ?? null,
              natEnabled: natParameter?.value ?? null,
              bindings,
              editable: connType === 'PPPoE',
              nameConfigurable: Boolean(nameParameter?.writable),
              usernameConfigurable: Boolean(usernameParameter?.writable),
              passwordConfigurable: Boolean(passwordParameter?.writable),
              vlanConfigurable: Boolean(vlanParameter?.writable),
              serviceListConfigurable: Boolean(serviceParameter?.writable),
              connectionTypeConfigurable: Boolean(connectionTypeParameter?.writable),
              natConfigurable: Boolean(natParameter?.writable),
              bindingsConfigurable: bindingConfigurable
            });
          }
        }
      }
    }

    const clients = [];
    const seenClients = new Set();
    const collectHosts = (hostCollection, dataModel) => {
      if (!hostCollection || typeof hostCollection !== 'object') return;
      for (const [instance, host] of Object.entries(hostCollection)) {
        if (instance.startsWith('_') || !host || typeof host !== 'object') continue;
        const value = (key) => getRelativeValue(host, key);
        const macAddress = value('MACAddress') || value('PhysAddress');
        const ipAddress = value('IPAddress');
        const hostName = value('HostName');
        const identity = String(macAddress || `${dataModel}:${instance}:${ipAddress || hostName || ''}`).toUpperCase();
        if (seenClients.has(identity)) continue;
        seenClients.add(identity);
        const activeValue = value('Active');
        clients.push({
          instance: String(instance),
          dataModel,
          hostName,
          ipAddress,
          macAddress,
          interfaceType: value('InterfaceType') || value('Layer2Interface'),
          addressSource: value('AddressSource'),
          leaseTimeRemaining: value('LeaseTimeRemaining'),
          active: activeValue === null ? null : this.isEnabledValue(activeValue)
        });
      }
    };
    collectHosts(item.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host, 'TR-098');
    collectHosts(item.Device?.Hosts?.Host, 'TR-181');
    clients.sort((left, right) => Number(right.active === true) - Number(left.active === true));

    return {
      _id: item._id,
      _lastInform: item._lastInform,
      _lastBoot: item._lastBoot,
      _registered: item._registered,
      vendor: vendor,
      deviceInfo,
      virtualParameters,
      wifi, 
      wan,
      wanContainers,
      clients,
      vendorDetection: {
        vendor: vendor,
        vendorId: vendorId,
        vendorName: vendorObj?.name || 'Unknown',
        parameterPrefix: vendorObj?.parameter_prefix || null
      }
    };
  }

  static async getCustomerIdentityDevices() {
    const virtualParams = await this.getVirtualParameters();
    const projection = [
      '_id',
      '_lastInform',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      virtualParams.vpPppoeUsername
    ].filter(Boolean);
    const data = await this.fetchFromGenieAcs(
      `?projection=${encodeURIComponent(projection.join(','))}`
    );
    if (!Array.isArray(data)) {
      throw new Error('Invalid GenieACS customer identity response');
    }
    return data.map((item) => ({
      _id: item._id || null,
      _lastInform: item._lastInform || null,
      softwareId: this.getParameterValue(
        item,
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion'
      ),
      pppoe: this.getParameterValue(item, virtualParams.vpPppoeUsername)
    }));
  }

  static async getCustomerPortalOverview(deviceId) {
    if (!deviceId) throw new Error('Device ID is required');

    const virtualParams = await this.getVirtualParameters();
    const projection = [
      '_id',
      '_deviceId._ProductClass',
      '_deviceId._SerialNumber',
      '_deviceId._Manufacturer',
      'InternetGatewayDevice.DeviceInfo.HardwareVersion',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      'InternetGatewayDevice.DeviceInfo.UpTime',
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      virtualParams.vpActiveDevices,
      '_lastInform',
      '_lastBoot',
      '_registered'
    ];
    for (let index = 1; index <= 8; index += 1) {
      projection.push(
        `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.Enable`,
        `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.SSID`,
        `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.TotalAssociations`
      );
    }

    const data = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId }),
      projection: projection.filter(Boolean).join(',')
    });
    if (!Array.isArray(data) || data.length === 0) {
      throw new TranslatableError('device.notFound', null, { status: 404 });
    }

    const item = data[0];
    const getValue = (parameterPath) => this.getParameterValue(item, parameterPath);
    const wifi = [];
    for (let index = 1; index <= 8; index += 1) {
      const ssid = getValue(
        `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.SSID`
      );
      if (ssid === null || ssid === '') continue;
      const enabled = getValue(
        `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.Enable`
      );
      wifi.push({
        index,
        ssid,
        enabled: enabled === null ? null : this.isEnabledValue(enabled),
        connectedDevices: getValue(
          `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.TotalAssociations`
        )
      });
    }

    const lastInform = item._lastInform || null;
    const lastInformMs = lastInform ? new Date(lastInform).getTime() : Number.NaN;
    const ageMs = Date.now() - lastInformMs;
    return {
      status: Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 10 * 60 * 1000
        ? 'online'
        : 'offline',
      lastInform,
      lastBoot: item._lastBoot || null,
      registered: item._registered || null,
      ont: {
        manufacturer: item._deviceId?._Manufacturer || null,
        model: item._deviceId?._ProductClass || null,
        serialNumber: item._deviceId?._SerialNumber || null,
        hardwareVersion: getValue('InternetGatewayDevice.DeviceInfo.HardwareVersion'),
        softwareVersion: getValue('InternetGatewayDevice.DeviceInfo.SoftwareVersion'),
        uptimeSeconds: getValue('InternetGatewayDevice.DeviceInfo.UpTime')
      },
      optical: {
        rxPower: getValue(virtualParams.vpRxPower),
        temperature: getValue(virtualParams.vpTemperature)
      },
      connectedDevices: getValue(virtualParams.vpActiveDevices),
      wifi,
      generatedAt: new Date().toISOString()
    };
  }

  static async postTask(deviceId, task) {
    const endpoint = `${encodeURIComponent(deviceId)}/tasks`;
    return this.fetchFromGenieAcs(endpoint, { connection_request: 1 }, 'POST', task);
  }

  /**
   * Posts a task and reports how GenieACS took it. `fetchFromGenieAcs`
   * discards the status code, but provisioning has to tell the two cases
   * apart: 200 means the connection request reached the CPE and the task ran,
   * 202 means it was only queued for some later inform. Recording a 202 as
   * "applied" would mark a device provisioned that never received anything.
   */
  static async postProvisioningTask(deviceId, task) {
    const url = await this.buildGenieAcsUrl(
      `${encodeURIComponent(deviceId)}/tasks`,
      { connection_request: 1 }
    );
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await GenieAcsEgress.fetch(url, {
        method: 'POST',
        headers: await GenieAcsAuthService.nbiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(task),
        signal: controller.signal,
        redirect: 'manual'
      });
      const text = await response.text().catch(() => '');
      if (!response.ok) {
        throw await this.genieAcsError('GenieACS API', response, text);
      }
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (body?.fault?.faultString) {
        throw new Error(`GenieACS reported a fault: ${body.fault.faultString}`);
      }
      return { status: response.status, applied: response.status === 200, body };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * The WAN index provisioning should write to, in the `dev.conn.ppp.instance`
   * form `updateWanConfig` expects. An instance that already carries a PPPoE
   * username wins, since that is the one the CPE is actually dialling with.
   */
  static findPppoeWanIndex(item) {
    const wanDevice = item?.InternetGatewayDevice?.WANDevice;
    if (!wanDevice || typeof wanDevice !== 'object') return null;
    let fallback = null;
    for (const devKey of Object.keys(wanDevice)) {
      if (devKey.startsWith('_')) continue;
      const connectionDevices = wanDevice[devKey]?.WANConnectionDevice;
      if (!connectionDevices || typeof connectionDevices !== 'object') continue;
      for (const connKey of Object.keys(connectionDevices)) {
        if (connKey.startsWith('_')) continue;
        const pppConnections = connectionDevices[connKey]?.WANPPPConnection;
        if (!pppConnections || typeof pppConnections !== 'object') continue;
        for (const instanceKey of Object.keys(pppConnections)) {
          if (instanceKey.startsWith('_') || !pppConnections[instanceKey]) continue;
          const index = `${devKey}.${connKey}.ppp.${instanceKey}`;
          const basePath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANPPPConnection.${instanceKey}`;
          const username = this.findWanParameter(item, basePath, 'Username')?.value;
          if (username) return index;
          if (!fallback) fallback = index;
        }
      }
    }
    return fallback;
  }

  static installationTag(installationDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(installationDate))) {
      throw new Error('Invalid installation date');
    }
    return `Installed_${String(installationDate).replaceAll('-', '')}`;
  }

  static async mutateDeviceTag(deviceId, tag, method) {
    if (!deviceId || !/^[A-Za-z0-9_]+$/.test(String(tag))) {
      throw new Error('Invalid device tag');
    }
    const root = await this.getGenieAcsRootUrl();
    const url = `${root}/devices/${encodeURIComponent(String(deviceId))}/tags/${encodeURIComponent(String(tag))}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await GenieAcsEgress.fetch(url, {
        method,
        headers: await GenieAcsAuthService.nbiHeaders(),
        signal: controller.signal,
        redirect: 'manual'
      });
      if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
        throw await this.genieAcsError('GenieACS tag API', response);
      }
      return true;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  static async syncInstallationTag(deviceId, installationDate, previousTag = null) {
    const nextTag = this.installationTag(installationDate);
    await this.mutateDeviceTag(deviceId, nextTag, 'POST');
    if (previousTag && previousTag !== nextTag && /^[A-Za-z0-9_]+$/.test(String(previousTag))) {
      await this.mutateDeviceTag(deviceId, previousTag, 'DELETE');
    }
    return nextTag;
  }

  static discoverWanContainers(item) {
    const containers = [];
    const wanDevices = item?.InternetGatewayDevice?.WANDevice;
    if (!wanDevices || typeof wanDevices !== 'object') return containers;
    for (const [wanIndex, wanDevice] of Object.entries(wanDevices)) {
      if (wanIndex.startsWith('_') || !wanDevice || typeof wanDevice !== 'object') continue;
      const connectionDevices = wanDevice.WANConnectionDevice;
      if (!connectionDevices || typeof connectionDevices !== 'object') continue;
      for (const [connectionIndex, connectionDevice] of Object.entries(connectionDevices)) {
        if (connectionIndex.startsWith('_') || !connectionDevice || typeof connectionDevice !== 'object') continue;
        containers.push(`InternetGatewayDevice.WANDevice.${wanIndex}.WANConnectionDevice.${connectionIndex}`);
      }
    }
    return containers;
  }

  static async addWanConnection(deviceId, containerPath, type) {
    if (!['ppp', 'ip'].includes(type)) {
      throw new Error('Invalid WAN connection type');
    }
    const rawDeviceData = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId }),
      projection: '_id,InternetGatewayDevice.WANDevice'
    });
    if (!Array.isArray(rawDeviceData) || rawDeviceData.length === 0) {
      throw new TranslatableError('device.notFound', null, { status: 404 });
    }
    const allowedContainers = this.discoverWanContainers(rawDeviceData[0]);
    if (!allowedContainers.includes(containerPath)) {
      throw new Error('Invalid WAN connection container');
    }
    const objectName = `${containerPath}.${type === 'ppp' ? 'WANPPPConnection' : 'WANIPConnection'}`;
    const task = await this.postTask(deviceId, { name: 'addObject', objectName });
    return {
      task,
      objectName,
      messageKey: 'device.service.wanCreateQueued',
      messageVars: { type: type === 'ppp' ? 'PPPoE' : 'IP' }
    };
  }

  static async deleteDevice(deviceId) {
    const base = await this.getDevicesBaseUrl();
    const url = `${base}/${encodeURIComponent(deviceId)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await GenieAcsEgress.fetch(url, {
        method: 'DELETE',
        headers: await GenieAcsAuthService.nbiHeaders(),
        signal: controller.signal,
        redirect: 'manual'
      });

      if (!response.ok) {
        throw await this.genieAcsError('GenieACS delete API', response);
      }
    } finally {
      clearTimeout(timeoutId);
    }

    return true;
  }

  static async rebootDevice(deviceId) {
    return this.postTask(deviceId, { name: 'reboot' });
  }

  /**
   * Objects a summon asks the ONT to re-report.
   *
   * GenieACS only stores parameters it has been told to fetch, so a fleet
   * whose provision script never asked for the GPON diagnostics has no
   * optical reading in any document — and no amount of reading the document
   * more cleverly will produce one. `refreshObject` on the parent is what
   * makes the ONT enumerate its own children, vendor extensions included, so
   * the reading is there from the next inform on.
   */
  static SUMMON_REFRESH_OBJECTS = Object.freeze({
    InternetGatewayDevice: ['InternetGatewayDevice.WANDevice'],
    Device: ['Device.Optical']
  });

  /** How long after a summon every listing looks again for the reading. */
  static RX_POWER_EAGER_MS = 15 * 60 * 1000;

  /**
   * Which data model this device answers on, so a summon asks it only for
   * objects its own tree could hold.
   *
   * Worth the extra read: nearly every ONT here speaks TR-098, and posting
   * the TR-181 refresh to all of them would have each one refuse a task it
   * was never going to accept. A refused task is a fault recorded against
   * the device, and in GenieACS a device's faults are in the way of the
   * tasks queued behind them — an operator's problem, days later, with no
   * obvious connection to a bell someone pressed.
   *
   * A read that fails falls back to TR-098 alone rather than to asking for
   * everything: guessing wide is what this exists to avoid.
   */
  static async detectSummonRoots(deviceId) {
    try {
      const rows = await this.fetchDeviceListPage(
        JSON.stringify({ _id: deviceId }),
        ['_id', 'InternetGatewayDevice.DeviceInfo', 'Device.DeviceInfo']
      );
      const roots = Object.keys(this.SUMMON_REFRESH_OBJECTS).filter((root) => rows[0]?.[root]);
      if (roots.length > 0) return roots;
    } catch (error) {
      console.warn(`Unable to read the data model of ${deviceId}: ${error.message}`);
    }
    return ['InternetGatewayDevice'];
  }

  /**
   * Asks the device to re-report each object, and reports which it accepted.
   *
   * Best effort even after the model check: an ONT can carry the root and
   * still not implement the object. That is one branch of a tree not
   * existing, not a summon that failed, and it must not cost the operator
   * the inform they actually asked for.
   */
  static async refreshSummonObjects(deviceId) {
    const roots = await this.detectSummonRoots(deviceId);
    const objects = roots.flatMap((root) => this.SUMMON_REFRESH_OBJECTS[root] ?? []);

    const refreshed = [];
    for (const objectName of objects) {
      try {
        const result = await this.postTask(deviceId, { name: 'refreshObject', objectName });
        if (result?.fault?.faultString) {
          console.warn(`${deviceId} refused to refresh ${objectName}: ${result.fault.faultString}`);
          continue;
        }
        refreshed.push(objectName);
      } catch (error) {
        console.warn(`Unable to refresh ${objectName} on ${deviceId}: ${error.message}`);
      }
    }
    return refreshed;
  }

  /**
   * Keeps every listing looking for the optical path for a while.
   *
   * A summon is the operator asking for a value the panel does not have yet,
   * and the refresh it queues only lands when the ONT next informs — after
   * the page they are looking at has loaded. Without this, a probe that ran
   * one second too early would record "this fleet reports no optical" and sit
   * on that answer for half an hour, hiding the very reading the summon was
   * for.
   */
  static async expectFreshRxPower() {
    const state = await this.readRxPowerState();
    if (state?.paths.length) return;
    await this.writeRxPowerState([], { eagerUntil: Date.now() + this.RX_POWER_EAGER_MS });
  }

  static async summonDevice(deviceId, parameters = []) {
    if (!Array.isArray(parameters) || parameters.length > 100) {
      throw new Error('Parameters must be an array with at most 100 entries');
    }
    if (parameters.some((parameter) => typeof parameter !== 'string' || parameter.length > 512)) {
      throw new Error('Every parameter path must be a string of at most 512 characters');
    }

    const refreshed = await this.refreshSummonObjects(deviceId);

    const data = await this.postTask(deviceId, {
      name: 'getParameterValues',
      parameterNames: [
        'InternetGatewayDevice.DeviceInfo.SerialNumber',
        ...parameters
      ]
    });

    if (data && data.fault && data.fault.faultString) {
      throw new Error(data.fault.faultString);
    }

    if (refreshed.length > 0) await this.expectFreshRxPower();

    return { ...(data && typeof data === 'object' ? data : {}), refreshed };
  }

  /**
   * `options.item` lets a caller that already holds the full device document
   * reuse it, so one provisioning run does not fetch the same document once
   * per step. `options.dryRun` returns the parameter list without queueing a
   * task, which is what lets the preview and the real run share one path.
   */
  static async updateWanConfig(deviceId, wanIndex, formData, options = {}) {
    const item = options.item ?? await this.fetchDeviceDocument(deviceId);
    const manufacturer = item._deviceId?._Manufacturer || null;
    const productClass = item._deviceId?._ProductClass || null;
    const vendorObj = await VendorService.detectVendor(manufacturer, productClass, item);
    
    if (!/^\d+\.\d+(?:\.ppp\.\d+)?$/.test(String(wanIndex))) {
      throw new Error('Invalid WAN connection index.');
    }
    const [devKey, connKey, indexType, instanceKey] = wanIndex.split('.');
    const connDev = item.InternetGatewayDevice?.WANDevice?.[devKey]?.WANConnectionDevice?.[connKey];
    
    if (!connDev) throw new Error('WAN Connection path not found in raw data.');

    let basePath = null;

    if (indexType === 'ppp' && connDev.WANPPPConnection?.[instanceKey]) {
      basePath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANPPPConnection.${instanceKey}`;
    } else if (!indexType && connDev.WANPPPConnection) {
      for (const pppKey in connDev.WANPPPConnection) {
        if (pppKey.startsWith('_')) continue;
        basePath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANPPPConnection.${pppKey}`;
        break;
      }
    }

    if (!basePath) {
      throw new Error('Only PPPoE connections are editable for now.');
    }
    const parameterValues = [];
    const {
      name,
      vlanEnabled,
      vlanId,
      username,
      password,
      serviceList,
      connectionType,
      natEnabled,
      bindings = {}
    } = formData;
    const nameParameter = this.findWanParameter(item, basePath, 'Name');
    const usernameParameter = this.findWanParameter(item, basePath, 'Username');
    const passwordParameter = this.findWanParameter(item, basePath, 'Password');
    const vlanParameter = this.findWanParameter(
      item,
      basePath,
      vendorObj?.vlan_id_path,
      WAN_PARAMETER_CANDIDATES.vlan
    );
    const serviceParameter = this.findWanParameter(
      item,
      basePath,
      vendorObj?.service_list_path,
      WAN_PARAMETER_CANDIDATES.serviceList
    );
    const connectionTypeParameter = this.findWanParameter(item, basePath, 'ConnectionType');
    const natParameter = this.findWanParameter(item, basePath, 'NATEnabled');
    const bindingParameter = this.findWanParameter(
      item,
      basePath,
      vendorObj?.lan_binding_path,
      WAN_PARAMETER_CANDIDATES.bindings
    );

    if (nameParameter?.writable && name !== undefined && name !== nameParameter.value) {
      if (typeof name !== 'string' || name.trim().length < 1 || name.length > 256) {
        throw new Error('WAN name must contain 1 to 256 characters.');
      }
      parameterValues.push([nameParameter.path, name.trim(), 'xsd:string']);
    }
    if (vlanParameter?.writable) {
      const parsedVlanId = Number(vlanId);
      if (vlanEnabled && (!Number.isInteger(parsedVlanId) || parsedVlanId < 1 || parsedVlanId > 4094)) {
        throw new Error('VLAN ID must be an integer between 1 and 4094.');
      }
      const nextVlan = vlanEnabled ? parsedVlanId : 0;
      if (String(nextVlan) !== String(vlanParameter.value ?? '')) {
        parameterValues.push([vlanParameter.path, nextVlan, 'xsd:unsignedInt']);
      }
    }

    if (usernameParameter?.writable && username !== undefined && username !== usernameParameter.value) {
      if (typeof username !== 'string' || username.length > 256) {
        throw new Error('PPP username must be a string of at most 256 characters.');
      }
      parameterValues.push([usernameParameter.path, username, 'xsd:string']);
    }
    if (passwordParameter?.writable && password) {
      if (typeof password !== 'string' || password.length > 256) {
        throw new Error('PPP password must be a string of at most 256 characters.');
      }
      parameterValues.push([passwordParameter.path, password, 'xsd:string']);
    }
    if (
      serviceParameter?.writable &&
      serviceList !== undefined &&
      serviceList !== serviceParameter.value
    ) {
      if (typeof serviceList !== 'string' || serviceList.length > 128) {
        throw new Error('WAN service list must be a string of at most 128 characters.');
      }
      parameterValues.push([serviceParameter.path, serviceList, 'xsd:string']);
    }
    if (
      connectionTypeParameter?.writable &&
      connectionType !== undefined &&
      connectionType !== connectionTypeParameter.value
    ) {
      if (!['IP_Routed', 'PPPoE_Bridged'].includes(connectionType)) {
        throw new Error('Invalid WAN connection type.');
      }
      parameterValues.push([connectionTypeParameter.path, connectionType, 'xsd:string']);
    }
    if (
      natParameter?.writable &&
      typeof natEnabled === 'boolean' &&
      natEnabled !== this.isEnabledValue(natParameter.value)
    ) {
      parameterValues.push([natParameter.path, natEnabled, 'xsd:boolean']);
    }
    
    if (bindingParameter) {
      for (let i = 1; i <= 4; i++) {
        const parameter = this.findWanParameter(item, bindingParameter.path, `Lan${i}Enable`);
        if (parameter?.writable) {
          const next = Boolean(bindings[`LAN${i}`]);
          if (next !== this.isEnabledValue(parameter.value)) {
            parameterValues.push([parameter.path, next, 'xsd:boolean']);
          }
        }
      }
      for (let i = 1; i <= 8; i++) {
        const parameter = this.findWanParameter(item, bindingParameter.path, `SSID${i}Enable`);
        if (parameter?.writable) {
          const next = Boolean(bindings[`SSID${i}`]);
          if (next !== this.isEnabledValue(parameter.value)) {
            parameterValues.push([parameter.path, next, 'xsd:boolean']);
          }
        }
      }
    }

    if (parameterValues.length === 0) {
      return { success: true, messageKey: 'device.service.wanNoChanges', parameterCount: 0 };
    }

    if (options.dryRun) {
      return { success: true, dryRun: true, parameterValues, parameterCount: parameterValues.length };
    }

    await this.postTask(deviceId, {
      name: 'setParameterValues',
      parameterValues
    });

    return {
      success: true,
      messageKey: 'device.service.wanUpdateQueued',
      parameterCount: parameterValues.length,
      parameterValues
    };
  }

  static async updateCredentials(deviceId, type, password, options = {}) {
    if (typeof password !== 'string' || password.length < 1 || password.length > 256) {
      throw new Error('Password must be between 1 and 256 characters.');
    }
    const settings = await Setting.getAll();
    let passPath;

    if (type === 'super') {
      passPath = settings.vpSuperPassword;
    } else if (type === 'user') {
      passPath = settings.vpUserPassword;
    } else {
      throw new Error('Invalid credential type specified.');
    }

    if (!passPath) {
      throw new Error(`VirtualParameter path for ${type} password is not set in settings.`);
    }

    const parameterValues = [[passPath, password, 'xsd:string']];
    if (options.dryRun) {
      return { success: true, dryRun: true, parameterValues, parameterCount: parameterValues.length };
    }

    await this.postTask(deviceId, {
      name: 'setParameterValues',
      parameterValues
    });

    return { success: true, messageKey: 'device.service.credentialQueued', messageVars: { type } };
  }

  static resolveWifiConfiguredPath(basePath, configuredPath, index) {
    if (!configuredPath) return null;
    const expanded = String(configuredPath)
      .replaceAll('{index}', String(index))
      .replaceAll('{i}', String(index))
      .replace('*', String(index));
    return this.resolveParameterPath(basePath, expanded);
  }

  static async updateWifiConfig(deviceId, index, formData, options = {}) {
    const wifiIndex = Number(index);
    if (!Number.isInteger(wifiIndex) || wifiIndex < 1 || wifiIndex > 8) {
      throw new TranslatableError('device.service.wifiIndexInvalid', null, { status: 400 });
    }
    const ssid = String(formData?.ssid ?? '').trim();
    const password = formData?.password === undefined ? '' : String(formData.password);
    const security = String(formData?.security ?? '').trim();
    const channelRaw = formData?.channel;
    if (!ssid || ssid.length > 32) {
      throw new TranslatableError('device.service.wifiSsidInvalid', null, { status: 400 });
    }
    if (password && (password.length < 8 || password.length > 63)) {
      throw new TranslatableError('device.service.wifiPasswordInvalid', null, { status: 400 });
    }
    if (security.length > 128) {
      throw new TranslatableError('device.service.wifiSecurityTooLong', null, { status: 400 });
    }
    if (
      channelRaw !== '' && channelRaw !== null && channelRaw !== undefined &&
      (!Number.isInteger(Number(channelRaw)) || Number(channelRaw) < 0 || Number(channelRaw) > 196)
    ) {
      throw new TranslatableError('device.service.wifiChannelInvalid', null, { status: 400 });
    }

    const item = options.item ?? await this.fetchDeviceDocument(deviceId);
    const basePath = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${wifiIndex}`;
    const virtualPrefix = wifiIndex === 1 ? 'SSID1' : wifiIndex === 5 ? 'SSID5' : null;
    const virtualNamePath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Name` : null;
    const useVirtual = Boolean(virtualNamePath && this.getParameterNode(item, virtualNamePath));
    const productClass = this.normalizeParameterValue(item._deviceId?._ProductClass);
    const manufacturer = this.normalizeParameterValue(item._deviceId?._Manufacturer);
    const [productConfig, vendor] = await Promise.all([
      productClass ? WifiSecurityConfig.getByProductClass(productClass) : null,
      VendorService.detectVendor(manufacturer, productClass, item)
    ]);

    const parameterValues = [];
    const enablePath = `${basePath}.Enable`;
    if (typeof formData?.enable === 'boolean' && this.getParameterNode(item, enablePath)) {
      parameterValues.push([enablePath, formData.enable, 'xsd:boolean']);
    }
    parameterValues.push([
      useVirtual ? `VirtualParameters.${virtualPrefix}-Name` : `${basePath}.SSID`,
      ssid,
      'xsd:string'
    ]);
    if (password) {
      let passwordPath = useVirtual ? `VirtualParameters.${virtualPrefix}-Password` : null;
      if (!passwordPath) {
        passwordPath = this.resolveWifiConfiguredPath(
          basePath,
          productConfig?.password_param_path || vendor?.wifi_password_path,
          wifiIndex
        );
      }
      if (!passwordPath) {
        const candidates = [
          `${basePath}.PreSharedKey.1.KeyPassphrase`,
          `${basePath}.KeyPassphrase`,
          `${basePath}.PreSharedKey.1.PreSharedKey`
        ];
        passwordPath = candidates.find((path) => this.getParameterNode(item, path)) || candidates[0];
      }
      parameterValues.push([passwordPath, password, 'xsd:string']);
    }
    if (security) {
      parameterValues.push([
        useVirtual ? `VirtualParameters.${virtualPrefix}-Security` : `${basePath}.BeaconType`,
        security,
        'xsd:string'
      ]);
    }
    if (channelRaw !== '' && channelRaw !== null && channelRaw !== undefined) {
      const channelPath = `${basePath}.Channel`;
      if (this.getParameterNode(item, channelPath)) {
        parameterValues.push([channelPath, Number(channelRaw), 'xsd:unsignedInt']);
      }
    }

    if (options.dryRun) {
      return { success: true, dryRun: true, parameterValues, parameterCount: parameterValues.length };
    }

    await this.postTask(deviceId, {
      name: 'setParameterValues',
      parameterValues
    });
    return {
      success: true,
      parameterValues,
      messageKey: 'device.service.wifiQueued',
      messageVars: { index: wifiIndex },
      parameterCount: parameterValues.length
    };
  }

  static normalizeFault(fault) {
    if (!fault || typeof fault !== 'object') return null;
    const scalar = (value) => {
      const direct = this.normalizeParameterValue(value);
      if (direct !== null) return direct;
      if (!value || typeof value !== 'object') return null;
      for (const key of ['$oid', '$date', '_value', 'value', 'id']) {
        if (value[key] !== undefined && value[key] !== value) {
          const nested = scalar(value[key]);
          if (nested !== null) return nested;
        }
      }
      return null;
    };
    const id = scalar(fault._id);
    if (!id) return null;
    const detail = fault.detail && typeof fault.detail === 'object' ? fault.detail : {};
    const deviceId = scalar(fault.device) || String(id).split(':')[0] || null;
    const timestamp = scalar(fault.timestamp) ||
      scalar(fault.retryTimestamp) ||
      scalar(fault._timestamp) ||
      null;
    return {
      id: String(id),
      deviceId: deviceId ? String(deviceId) : null,
      channel: String(scalar(fault.channel) || String(id).split(':').slice(1).join(':') || 'default'),
      code: String(
        scalar(fault.code) ||
        scalar(detail.faultCode) ||
        scalar(detail.code) ||
        'FAULT'
      ),
      message: String(
        scalar(fault.message) ||
        scalar(detail.faultString) ||
        scalar(detail.message) ||
        scalar(fault.faultString) ||
        'GenieACS reported a provisioning fault'
      ),
      timestamp: timestamp ? String(timestamp) : null,
      retries: Number(scalar(fault.retries) || scalar(fault.retryCount) || 0)
    };
  }

  static async getFaults(limit = 50, timeoutMs = 15_000) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const data = await this.fetchGenieAcsCollection(
      'faults',
      {
        limit: safeLimit
      },
      'GET',
      null,
      timeoutMs
    );
    if (!Array.isArray(data)) {
      throw new Error('Invalid faults API response');
    }
    return data
      .map((fault) => this.normalizeFault(fault))
      .filter(Boolean)
      .sort((left, right) => {
        const a = left.timestamp ? new Date(left.timestamp).getTime() : 0;
        const b = right.timestamp ? new Date(right.timestamp).getTime() : 0;
        return (Number.isFinite(b) ? b : 0) - (Number.isFinite(a) ? a : 0);
      });
  }

  static async deleteFault(faultId) {
    if (!faultId || String(faultId).length > 512) {
      throw new Error('Invalid fault ID');
    }
    const root = await this.getGenieAcsRootUrl();
    const url = `${root}/faults/${encodeURIComponent(String(faultId))}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await GenieAcsEgress.fetch(url, {
        method: 'DELETE',
        headers: await GenieAcsAuthService.nbiHeaders(),
        signal: controller.signal,
        redirect: 'manual'
      });
      if (!response.ok && response.status !== 404) {
        throw await this.genieAcsError('GenieACS fault API', response);
      }
      return true;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  static buildDashboardSummary(devices, faults = [], faultsError = null) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const stats = { total: devices.length, online: 0, offline: 0, new24h: 0 };
    const rxDistribution = { Excellent: 0, Good: 0, Poor: 0, Danger: 0, Unknown: 0 };
    const informFreshness = { 'Under 10m': 0, '10–60m': 0, '1–24h': 0, 'Over 24h': 0 };
    const temperatureDistribution = { Normal: 0, Warm: 0, Hot: 0, Unknown: 0 };
    const clientDistribution = { '0': 0, '1–5': 0, '6–15': 0, '16+': 0, Unknown: 0 };
    const productClasses = new Map();
    const manufacturers = new Map();
    const registrationDays = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(now - (6 - offset) * dayMs);
      return {
        key: date.toISOString().slice(0, 10),
        name: date.toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit' }),
        value: 0
      };
    });
    const registrationByKey = new Map(registrationDays.map((entry) => [entry.key, entry]));

    for (const device of devices) {
      const lastInformMs = device._lastInform ? new Date(device._lastInform).getTime() : Number.NaN;
      const informAge = now - lastInformMs;
      if (Number.isFinite(informAge) && informAge >= 0 && informAge < 10 * 60 * 1000) {
        stats.online += 1;
        informFreshness['Under 10m'] += 1;
      } else {
        stats.offline += 1;
        if (Number.isFinite(informAge) && informAge >= 0 && informAge < 60 * 60 * 1000) {
          informFreshness['10–60m'] += 1;
        } else if (Number.isFinite(informAge) && informAge >= 0 && informAge < dayMs) {
          informFreshness['1–24h'] += 1;
        } else {
          informFreshness['Over 24h'] += 1;
        }
      }

      const registeredMs = device._registered ? new Date(device._registered).getTime() : Number.NaN;
      if (Number.isFinite(registeredMs) && now - registeredMs >= 0 && now - registeredMs < dayMs) {
        stats.new24h += 1;
      }
      if (Number.isFinite(registeredMs)) {
        const registrationKey = new Date(registeredMs).toISOString().slice(0, 10);
        const registrationEntry = registrationByKey.get(registrationKey);
        if (registrationEntry) registrationEntry.value += 1;
      }

      const productClass = String(device.productclass || 'Unknown');
      const manufacturer = String(device.manufacturer || 'Unknown');
      productClasses.set(productClass, (productClasses.get(productClass) || 0) + 1);
      manufacturers.set(manufacturer, (manufacturers.get(manufacturer) || 0) + 1);

      const rxPower = Number(device.rxpower);
      if (device.rxpower === null || device.rxpower === undefined || !Number.isFinite(rxPower)) {
        rxDistribution.Unknown += 1;
      } else if (rxPower >= -21.99) {
        rxDistribution.Excellent += 1;
      } else if (rxPower >= -24.99) {
        rxDistribution.Good += 1;
      } else if (rxPower >= -26.99) {
        rxDistribution.Poor += 1;
      } else {
        rxDistribution.Danger += 1;
      }

      const temperature = Number(device.temperature);
      if (device.temperature === null || device.temperature === undefined || !Number.isFinite(temperature)) {
        temperatureDistribution.Unknown += 1;
      } else if (temperature < 50) {
        temperatureDistribution.Normal += 1;
      } else if (temperature < 70) {
        temperatureDistribution.Warm += 1;
      } else {
        temperatureDistribution.Hot += 1;
      }

      const clients = Number(device.activedevices);
      if (
        device.activedevices === null ||
        device.activedevices === undefined ||
        device.activedevices === '' ||
        !Number.isFinite(clients)
      ) clientDistribution.Unknown += 1;
      else if (clients <= 0) clientDistribution['0'] += 1;
      else if (clients <= 5) clientDistribution['1–5'] += 1;
      else if (clients <= 15) clientDistribution['6–15'] += 1;
      else clientDistribution['16+'] += 1;
    }

    const topEntries = (map, limit) => Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
      .slice(0, limit);

    return {
      generatedAt: new Date(now).toISOString(),
      stats,
      rxDistribution,
      informFreshness,
      temperatureDistribution,
      clientDistribution,
      productClasses: topEntries(productClasses, 10),
      manufacturers: topEntries(manufacturers, 8),
      registrations: registrationDays,
      faults,
      faultsError
    };
  }

  static async hydrateDashboardCache() {
    const cache = this.dashboardCacheFor();
    if (cache.hydrated) return;
    cache.hydrated = true;
    try {
      const stored = await AppState.get('dashboard_snapshot');
      if (!stored) return;
      const snapshot = JSON.parse(stored);
      if (!snapshot?.data?.stats || !snapshot?.data?.generatedAt) return;
      cache.data = snapshot.data;
      cache.expiresAt = Number(snapshot.expiresAt) || 0;
    } catch (error) {
      console.warn('Ignoring invalid dashboard snapshot:', error.message);
    }
  }

  static async persistDashboardCache() {
    const cache = this.dashboardCacheFor();
    if (!cache.data) return;
    try {
      await AppState.upsert('dashboard_snapshot', JSON.stringify({
        data: cache.data,
        expiresAt: cache.expiresAt
      }));
    } catch (error) {
      console.warn('Unable to persist dashboard snapshot:', error.message);
    }
  }

  static async refreshDashboardData() {
    const cache = this.dashboardCacheFor();
    const devices = await this.getDashboardDevices();
    const previousFaults = Array.isArray(cache.data?.faults) ? cache.data.faults : [];
    const data = this.buildDashboardSummary(devices, previousFaults, cache.data?.faultsError || null);
    cache.data = data;
    cache.expiresAt = Date.now() + this.dashboardCacheTtlMs;
    await this.persistDashboardCache();
    return data;
  }

  static async mergeDashboardFaults(faults, faultsError = null) {
    const cache = this.dashboardCacheFor();
    await this.hydrateDashboardCache();
    if (!cache.data) return;
    cache.data = { ...cache.data, faults, faultsError };
    await this.persistDashboardCache();
  }

  static async getDashboardData(force = false) {
    const cache = this.dashboardCacheFor();
    await this.hydrateDashboardCache();

    const startRefresh = () => {
      if (cache.promise) return cache.promise;
      const work = this.refreshDashboardData();
      cache.promise = work;
      work.catch((error) => {
        console.error('Dashboard background refresh failed:', error.message);
      }).finally(() => {
        if (cache.promise === work) cache.promise = null;
      });
      return work;
    };

    if (!force && cache.data) {
      if (cache.expiresAt <= Date.now()) startRefresh();
      return cache.data;
    }
    if (cache.promise) return cache.promise;

    const work = startRefresh();
    cache.promise = work;
    try {
      return await work;
    } finally {
      if (cache.promise === work) cache.promise = null;
    }
  }
}

export default DeviceService;
