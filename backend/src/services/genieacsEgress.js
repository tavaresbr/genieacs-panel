import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { IS_SAAS } from '../config/edition.js';

/**
 * The ports a GenieACS NBI is allowed to be reached on.
 *
 * A base URL that is provider-supplied data is also a port scanner: the panel
 * reports "connected" or "refused" for whatever it is pointed at, so without a
 * list the customer gets to sweep every service our network happens to run.
 * 7557 is the NBI's own default; 80 and 443 are what it looks like behind a
 * reverse proxy, and 8080 is the one every such proxy is actually put on.
 */
const ALLOWED_PORTS = new Set([80, 443, 7557, 8080]);

function ipv4Bytes(text) {
  return text.split('.').map((part) => Number.parseInt(part, 10));
}

/**
 * The 16 bytes of an IPv6 address, or null when the text is not one.
 *
 * Written out rather than pattern-matched because the classes below are ranges
 * of leading bits, and a textual address hides them: `fc00::1`, `FC00:0:0::1`
 * and `::ffff:10.0.0.1` are the same address written three ways, and a regex
 * that catches one of the three is a guard with a hole in it.
 */
function ipv6Bytes(text) {
  if (!net.isIPv6(text)) return null;

  let value = text.split('%')[0];

  // A trailing dotted quad — the `::ffff:10.0.0.1` family — is folded into two
  // ordinary hextets first, so that everything below deals with one notation.
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null;
    const [a, b, c, d] = ipv4Bytes(tail);
    value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...rest];
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const word = Number.parseInt(group, 16);
    bytes.push(word >> 8, word & 0xff);
  }
  return bytes;
}

/** Why this v4 address is not somewhere the panel may be sent, or null. */
function blockedIpv4Reason([a, b]) {
  if (a === 0) return 'the unspecified "this network" block';
  if (a === 127) return 'loopback';
  if (a === 10) return 'a private network (10/8)';
  if (a === 172 && b >= 16 && b <= 31) return 'a private network (172.16/12)';
  if (a === 192 && b === 168) return 'a private network (192.168/16)';
  if (a === 169 && b === 254) return 'link-local, where the cloud metadata service lives (169.254/16)';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64/10)';
  if (a >= 224) return 'multicast or reserved space';
  return null;
}

/** Why this v6 address is not somewhere the panel may be sent, or null. */
function blockedIpv6Reason(bytes) {
  const allZero = bytes.every((byte) => byte === 0);
  if (allZero) return 'the unspecified address (::)';
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return 'IPv6 loopback (::1)';

  // ::ffff:0:0/96 is what a dual-stack resolver hands back for an A record, and
  // ::/96 and 64:ff9b::/96 reach the same v4 host by other spellings. All three
  // are answered by the v4 rules, or the entire v4 blocklist is bypassed by
  // asking for the address in v6 notation.
  const zeroThrough9 = bytes.slice(0, 10).every((byte) => byte === 0);
  const isMapped = zeroThrough9 && bytes[10] === 0xff && bytes[11] === 0xff;
  const isCompatible = zeroThrough9 && bytes[10] === 0 && bytes[11] === 0;
  const isNat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes.slice(4, 12).every((byte) => byte === 0);
  if (isMapped || isCompatible || isNat64) {
    const reason = blockedIpv4Reason(bytes.slice(12));
    return reason ? `${reason}, reached through an IPv4-mapped IPv6 address` : null;
  }

  if ((bytes[0] & 0xfe) === 0xfc) return 'a unique local address (fc00::/7)';
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'IPv6 link-local (fe80::/10)';
  if (bytes[0] === 0xff) return 'IPv6 multicast';
  return null;
}

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

/** Why this address is off limits, or null when it is fair game. */
export function blockedAddressReason(address) {
  if (net.isIPv4(address)) return blockedIpv4Reason(ipv4Bytes(address));
  const bytes = ipv6Bytes(address);
  if (bytes) return blockedIpv6Reason(bytes);
  return 'not a usable IP address';
}

function headersToObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return { ...headers };
}

/**
 * Rebuilds the upstream answer as a real `Response`, so that every call site
 * keeps reading `.ok`, `.status`, `.text()` and `.headers.get()` exactly as it
 * did when this went through `fetch`.
 */
function toResponse(res, body) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, single);
      } catch {
        // A header the upstream should not have sent is not a reason to fail
        // the request; the ones the panel reads are well-formed or absent.
      }
    }
  }

  // 204/205/304 may not carry a body at all, and the `Response` constructor
  // enforces that — handing it the empty buffer anyway would throw here and
  // surface as a panel bug rather than as the upstream answer it is.
  const empty = body.length === 0 || [204, 205, 304].includes(res.statusCode);
  const statusText = /^[\t\x20-\x7e]*$/.test(res.statusMessage || '') ? res.statusMessage : undefined;

  return new Response(empty ? null : body, {
    status: res.statusCode,
    ...(statusText ? { statusText } : {}),
    headers
  });
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
 * The second is subtler and is the reason this does not use `fetch`. Checking
 * that a hostname resolves somewhere acceptable and then letting the HTTP
 * client resolve it a second time closes nothing: the two answers need not
 * agree, and an attacker who controls the zone makes sure they do not. So the
 * address vetted here is the address connected to — pinned through the
 * `lookup` hook, with the original hostname still in the `Host` header and in
 * the TLS SNI so the certificate check stays honest. Node's global `fetch`
 * cannot express that: it takes no resolver, and `Host` is a forbidden header
 * there, so pointing it at the vetted IP would silently send the wrong name.
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

  /**
   * Name resolution, as one overridable slot. A test drives a rebinding-shaped
   * answer through it — a public address on the first look, a private one on
   * the second — without reaching the network for a name it would have to own.
   */
  static lookup(hostname) {
    return dns.promises.lookup(hostname, { all: true });
  }

  /**
   * Everything decided before the socket opens: which port, which addresses,
   * and whether any of them disqualifies the request.
   */
  static async resolveTarget(url) {
    const parsed = url instanceof URL ? url : new URL(String(url));

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw refuse(`GenieACS URL must use HTTP or HTTPS; received "${parsed.protocol}"`);
    }

    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    if (IS_SAAS && !ALLOWED_PORTS.has(port)) {
      throw refuse(
        `GenieACS port ${port} is not allowed; use one of ${[...ALLOWED_PORTS].join(', ')}`
      );
    }

    // Brackets are the URL notation for a v6 literal, not part of the address.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

    let addresses;
    if (net.isIP(hostname)) {
      // A literal has nothing to re-resolve, so there is nothing to pin; it is
      // still checked, because naming 127.0.0.1 outright is the easy attempt.
      addresses = [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }];
    } else {
      const answer = await this.lookup(hostname);
      addresses = (Array.isArray(answer) ? answer : [answer])
        .filter((entry) => entry && entry.address)
        .map((entry) => ({
          address: entry.address,
          family: entry.family ?? (net.isIPv6(entry.address) ? 6 : 4)
        }));
      if (addresses.length === 0) {
        throw new Error(`GenieACS host ${hostname} did not resolve to any address`);
      }
    }

    if (IS_SAAS) {
      // Every answer, not the first: a name that resolves to one public address
      // and one loopback address is a rebinding attempt that does not even need
      // a second lookup — the client would simply fail over to the other entry.
      for (const { address } of addresses) {
        const reason = blockedAddressReason(address);
        if (reason) {
          throw refuse(
            `GenieACS host ${hostname} resolves to ${address}, which is ${reason} and cannot be reached from here`
          );
        }
      }
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
    const { parsed, hostname, port, addresses } = await this.resolveTarget(url);

    const transport = parsed.protocol === 'https:' ? https : http;
    const headers = headersToObject(options.headers);
    const body = options.body === undefined || options.body === null
      ? null
      : Buffer.from(typeof options.body === 'string' ? options.body : String(options.body));

    if (body && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(body.length);
    }

    return new Promise((resolve, reject) => {
      const request = transport.request({
        protocol: parsed.protocol,
        hostname,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'GET',
        headers,
        signal: options.signal,
        // The whole point. `hostname` above still drives the `Host` header and
        // the TLS server name; only the address the socket goes to is replaced,
        // with the one already vetted, so no second resolution can happen.
        lookup: (_name, lookupOptions, done) => {
          if (lookupOptions?.all) done(null, addresses);
          else done(null, addresses[0].address, addresses[0].family);
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve(toResponse(res, Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on('error', reject);
      if (body) request.write(body);
      request.end();
    });
  }
}

export default GenieAcsEgress;
