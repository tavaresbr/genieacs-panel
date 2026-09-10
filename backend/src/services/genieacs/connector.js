import GenieAcsConnection, { IMPLEMENTED_MODES } from '../../models/GenieAcsConnection.js';
import Setting from '../../models/Setting.js';
import GenieAcsEgress from '../genieacsEgress.js';
import { withAcsSlot } from './concurrency.js';

/**
 * A refusal that names the panel's own configuration rather than the upstream.
 * Distinct from `EGRESS_REFUSED` (the destination is not allowed) and from an
 * upstream failure (the ACS answered badly): this one means we never had enough
 * to make the request at all.
 */
export const CONNECTOR_UNCONFIGURED = 'GENIEACS_NOT_CONFIGURED';

function unconfigured(message) {
  const error = new Error(message);
  error.code = CONNECTOR_UNCONFIGURED;
  return error;
}

/**
 * The base URL, as one rule with one answer.
 *
 * Two places can hold it during the transition: `tenant_genieacs_connections`,
 * which is where it belongs, and `settings.genieAcsUrl`, which is what the
 * settings screen still edits and what every install upgrading into this
 * release already has. The row wins when it has a value; saving the setting
 * writes through to the row, so the fallback is only ever reached by a provider
 * that has never saved one. Phase 6 retires the setting and this collapses to
 * a single read.
 */
async function resolveBaseUrl(connection) {
  if (connection.base_url) return connection.base_url;
  const settings = await Setting.getAll();
  return settings.genieAcsUrl || null;
}

/** Validates the base URL and reduces it to a scheme, host and port. */
export function normalizeRootUrl(baseUrl) {
  if (!baseUrl) throw unconfigured('GenieACS URL not configured');

  let url;
  try {
    url = new URL(String(baseUrl));
  } catch {
    throw unconfigured('GenieACS URL is not a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw unconfigured('GenieACS URL must use HTTP or HTTPS');
  }
  // Credentials belong in `auth_type`/`username`/the encrypted secret, not in a
  // URL that is logged, shown on screen and echoed back by the settings API.
  if (url.username || url.password) {
    throw unconfigured('Credentials in the GenieACS URL are not supported');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * The `Authorization` header for a connection, or nothing.
 *
 * The panel has never sent one. That was defensible while the NBI sat on the
 * operator's own loopback; hosted, an unauthenticated NBI reachable from our
 * egress is the provider's entire fleet available to whoever else finds it, so
 * this is the header the mode exists to carry.
 */
export function authorizationHeader(connection, secret) {
  if (connection.auth_type === 'basic') {
    if (!connection.username && !secret) return null;
    const pair = `${connection.username ?? ''}:${secret ?? ''}`;
    return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
  }
  if (connection.auth_type === 'bearer') {
    return secret ? `Bearer ${secret}` : null;
  }
  return null;
}

/**
 * How this provider's GenieACS is reached, resolved once per call.
 *
 * `DeviceService` used to build every URL itself from a setting and hand it
 * straight to the egress guard. It asks this instead, so that the credential,
 * the TLS decision, the private-range decision and the concurrency ceiling are
 * properties of the provider's connection rather than things each of seven call
 * sites has to remember.
 *
 * Only `direct` has a transport of its own. `tunnel` and `hosted` are the same
 * transport pointed somewhere else — a WireGuard peer, our own network — and
 * differ only in that they are normally allowed a private address, which is a
 * flag on the row and not a branch here. `agent` is the one that genuinely
 * needs another transport (the ISP dials out to us and we multiplex over that
 * socket), and it is refused by name until it exists, because a mode silently
 * treated as `direct` would try to reach an ACS that is not exposed at all and
 * report it as an outage.
 */
export class GenieAcsConnector {
  constructor(connection, secret, rootUrl) {
    this.connection = connection;
    this.rootUrl = rootUrl;
    this.authorization = authorizationHeader(connection, secret);
  }

  static async forCurrentTenant() {
    const connection = await GenieAcsConnection.current();

    if (!IMPLEMENTED_MODES.has(connection.mode)) {
      throw unconfigured(
        `GenieACS connection mode "${connection.mode}" is not available yet`
      );
    }

    const rootUrl = normalizeRootUrl(await resolveBaseUrl(connection));
    const secret = connection.auth_type === 'none' ? '' : await GenieAcsConnection.secret();
    return new this(connection, secret, rootUrl);
  }

  /** `${root}/devices`, the base the device call sites are built from. */
  get devicesUrl() {
    return `${this.rootUrl}/devices`;
  }

  /**
   * One request to this provider's ACS.
   *
   * Everything a call site used to pass to `GenieAcsEgress.fetch` still goes
   * through — `method`, `headers`, `body`, `signal` — and the connection adds
   * the credential and the two egress decisions on top. `redirect: 'manual'`
   * stays the default it already was at every call site: the guard never
   * follows a redirect, and a 3xx has to arrive as a refusable response rather
   * than as a hop to somewhere nobody vetted.
   */
  async request(url, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    // A call site that set its own wins, so that a future per-request
    // credential is possible without this silently overwriting it.
    if (this.authorization && !Object.keys(headers).some((n) => n.toLowerCase() === 'authorization')) {
      headers.Authorization = this.authorization;
    }

    return withAcsSlot(() => GenieAcsEgress.fetch(url, {
      redirect: 'manual',
      ...options,
      headers,
      allowPrivateAddresses: this.connection.allow_private_ranges,
      rejectUnauthorized: this.connection.verify_tls
    }));
  }

  /** The URL for one of the NBI's collections, with the query applied. */
  collectionUrl(collection, query = {}) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(collection))) {
      throw new Error('Invalid GenieACS collection name');
    }
    const url = new URL(`${this.rootUrl}/${collection}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url;
  }
}

/**
 * Keeps `base_url` in step with the setting the screen still edits.
 *
 * Two writable places for one fact is how configuration drifts, and the drift
 * here would be silent and confusing: the screen would show one ACS and the
 * panel would talk to another. Until phase 6 moves the field, saving the
 * setting is the only way the URL changes, so this is where the two are joined.
 */
export async function syncBaseUrlFromSetting(key, value) {
  if (key !== 'genieAcsUrl') return;
  await GenieAcsConnection.save({ base_url: value ? String(value) : null });
}

/**
 * The credentials to use when testing a URL, and the reason they are sometimes
 * withheld.
 *
 * The "test connection" button posts the URL to try, which is the point of it —
 * an operator checks an address before saving it. That makes it the one place
 * where the destination is named by the caller, and sending the stored NBI
 * password to a caller-named host would turn the button into a way to read the
 * credential back out in plaintext: point it at a server you control and read
 * the `Authorization` header off the wire.
 *
 * So the credential travels only when the URL under test is the same origin as
 * the one it belongs to. Testing a NEW address tests reachability only, which
 * is what it can honestly tell you before the address is saved.
 */
export async function connectorForTestUrl(testUrl) {
  const connection = await GenieAcsConnection.current();
  const stored = await resolveBaseUrl(connection);

  let sameOrigin = false;
  if (stored) {
    try {
      sameOrigin = new URL(stored).origin === new URL(testUrl).origin;
    } catch {
      sameOrigin = false;
    }
  }

  const secret = sameOrigin && connection.auth_type !== 'none'
    ? await GenieAcsConnection.secret()
    : '';
  const forTest = sameOrigin ? connection : { ...connection, auth_type: 'none', username: null };
  return {
    connector: new GenieAcsConnector(forTest, secret, normalizeRootUrl(new URL(testUrl).origin)),
    credentialsSent: sameOrigin && connection.auth_type !== 'none',
    // Whether the outcome says anything about the STORED connection. Filing the
    // result of trying a candidate URL against the configured one would mark a
    // working ACS as unreachable because a URL the operator was still typing is
    // not — and the screen would then be reporting an outage that is not there.
    describesStoredConnection: sameOrigin
  };
}

export default GenieAcsConnector;
