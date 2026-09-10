import { IS_SAAS } from '../config/edition.js';
import { recordAcsRequest } from '../utils/metrics.js';
import { blockedAddressReason } from '../utils/net/blockedRanges.js';
import { PinnedTransport } from '../utils/net/pinnedFetch.js';

// Re-exported because this module has always been where the panel asks "is this
// address off limits". The table itself now lives in `utils/net/blockedRanges.js`
// so that the WhatsApp guard classifies through exactly the same rules; keeping
// the name here means no call site had to learn about the move.
export { blockedAddressReason };

/**
 * The ports a GenieACS NBI is allowed to be reached on.
 *
 * A base URL that is provider-supplied data is also a port scanner: the panel
 * reports "connected" or "refused" for whatever it is pointed at, so without a
 * list the customer gets to sweep every service our network happens to run.
 * 7557 is the NBI's own default; 80 and 443 are what it looks like behind a
 * reverse proxy, and 8080 is the one every such proxy is actually put on.
 *
 * `GENIEACS_ALLOWED_PORTS` widens it, because four ports is a guess about other
 * people's deployments and some ISP will have put its NBI behind a proxy on
 * 8443. It is deliberately an environment variable and not a column: it is the
 * DEPLOYMENT saying which ports its own network can tolerate being probed on,
 * which is not a decision the probing party gets to make about itself.
 */
const DEFAULT_ALLOWED_PORTS = [80, 443, 7557, 8080];

function configuredPorts() {
  const extra = String(process.env.GENIEACS_ALLOWED_PORTS || '')
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return new Set([...DEFAULT_ALLOWED_PORTS, ...extra]);
}

const ALLOWED_PORTS = configuredPorts();

/**
 * How much of an NBI answer this process will hold in memory.
 *
 * There was no ceiling at all, which means the ACS chose: a 200 MiB body took
 * RSS from 62 MB to 1133 MB. A ceiling has to be generous, though — a
 * free-text device search asks the NBI for the whole match set, and on a large
 * fleet with the listing projection that is tens of megabytes of legitimate
 * JSON. 128 MiB is far above any real listing and still a bound where there
 * was none; `GENIEACS_MAX_RESPONSE_BYTES` moves it either way for an install
 * that knows its own fleet.
 */
function configuredMaxBytes() {
  const stated = Number.parseInt(process.env.GENIEACS_MAX_RESPONSE_BYTES || '', 10);
  return Number.isInteger(stated) && stated > 0 ? stated : 128 * 1024 * 1024;
}

const MAX_RESPONSE_BYTES = configuredMaxBytes();

/**
 * A refusal by this guard, tagged so a caller can tell it from an upstream
 * failure. The two need different answers: an unreachable ACS is a 502 the
 * operator waits out, a refused address is a 400 they have to fix.
 */
export const EGRESS_REFUSED = 'GENIEACS_EGRESS_REFUSED';

function refuse(message) {
  const error = new Error(message);
  error.code = EGRESS_REFUSED;
  return error;
}

/**
 * The egress guard for every request the panel makes to a GenieACS.
 *
 * Phase 4 turns the ACS base URL into per-provider data, which means a customer
 * gets to name the host this process connects to. Two things follow, and this
 * class is both of them.
 *
 * The first is that the destination has to be checked before the socket opens:
 * a URL naming our own loopback, our VPC, or the cloud metadata service turns
 * the panel into a proxy into its own network.
 *
 * The second is subtler and is the reason this does not use `fetch`: the
 * address vetted here is the address connected to. Both halves — the range
 * table and the resolve-pin-and-cap transport — now live in `utils/net/`, so
 * the WhatsApp guard enforces the same list through the same code path.
 * `utils/net/pinnedFetch.js` explains why `fetch` cannot do this.
 *
 * Nothing here follows a redirect, which is what `redirect: 'manual'` at the
 * call sites asks for — a 3xx arrives as an ordinary not-ok response and is
 * refused by `DeviceService.genieAcsError`.
 *
 * On the self-hosted edition the address classes are not blocked. There the ACS
 * sits on the operator's own LAN and a private address is the normal case, and
 * there is no untrusted party to defend against — the person who wrote the URL
 * owns the install. The pinning stays on in both editions on purpose: one
 * transport that behaves the same everywhere is worth more than a saving, and a
 * path that only ever runs in production is a path nobody has tested.
 */
export class GenieAcsEgress {
  static ALLOWED_PORTS = ALLOWED_PORTS;

  static MAX_RESPONSE_BYTES = MAX_RESPONSE_BYTES;

  /**
   * Name resolution, as one overridable slot. A test drives a rebinding-shaped
   * answer through it — a public address on the first look, a private one on
   * the second — without reaching the network for a name it would have to own.
   */
  static lookup(hostname) {
    return PinnedTransport.lookup(hostname);
  }

  /**
   * Everything decided before the socket opens: which port, which addresses,
   * and whether any of them disqualifies the request.
   */
  static async resolveTarget(url, { allowPrivateAddresses = false } = {}) {
    const parsed = url instanceof URL ? url : new URL(String(url));

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw refuse(`GenieACS URL must use HTTP or HTTPS; received "${parsed.protocol}"`);
    }

    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    // Read through `this` rather than off the module constant, so that the list
    // the class advertises is the list it enforces.
    const allowed = this.ALLOWED_PORTS;
    if (IS_SAAS && !allowed.has(port)) {
      throw refuse(
        `GenieACS port ${port} is not allowed; use one of ${[...allowed].join(', ')}`
      );
    }

    // Brackets are the URL notation for a v6 literal, not part of the address.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

    // `allowPrivateAddresses` is the `tunnel` and `hosted` modes: the ACS really
    // is on a private address there, reached over a link we set up. It is set
    // by us per customer and is never reachable from the provider's own API,
    // because a guard the guarded party can switch off is not a guard. On the
    // self-hosted edition every address is allowed for the same reason.
    const addresses = await PinnedTransport.vetTarget(hostname, {
      lookup: (name) => this.lookup(name),
      allowPrivateAddresses: allowPrivateAddresses || !IS_SAAS,
      refuse: (message) => refuse(`GenieACS host ${message}`)
    });

    if (addresses.length === 0) {
      throw new Error(`GenieACS host ${hostname} did not resolve to any address`);
    }

    return { parsed, hostname, port, addresses };
  }

  /**
   * A `fetch`-shaped call that connects only to the vetted addresses.
   *
   * `options` carries the same `method`, `headers`, `body` and `signal` the
   * call sites already passed; the timeouts they arm around it work unchanged.
   */
  static async fetch(url, options = {}) {
    const { allowPrivateAddresses = false, rejectUnauthorized = true } = options;
    let target;
    try {
      target = await this.resolveTarget(url, { allowPrivateAddresses });
    } catch (error) {
      // Counted per provider, by what stopped it: a refusal is ours and a
      // resolution failure is the network's, and the two are different pages.
      recordAcsRequest({ outcome: error?.code === EGRESS_REFUSED ? 'refused' : 'error' });
      throw error;
    }
    const { parsed, hostname, port, addresses } = target;

    try {
      const response = await PinnedTransport.request({
        url: parsed,
        hostname,
        port,
        addresses,
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body,
        signal: options.signal,
        rejectUnauthorized,
        maxBytes: this.MAX_RESPONSE_BYTES
      });
      recordAcsRequest({ outcome: 'ok' });
      return response;
    } catch (error) {
      recordAcsRequest({ outcome: 'error' });
      throw error;
    }
  }
}

export default GenieAcsEgress;
