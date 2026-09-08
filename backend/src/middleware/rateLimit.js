import rateLimit from 'express-rate-limit';

/**
 * Renders the limiter body in the language negotiated for the request. The
 * `code` travels alongside it because it is stable across languages, which is
 * what a client needs to branch on.
 */
function limitMessage(key, code) {
  return (req) => ({ success: false, code, message: req.t(key) });
}

const JSON_HEADERS = {
  standardHeaders: true,
  legacyHeaders: false
};

/**
 * A single IPv6 host owns a whole prefix, so limiting per address is trivially
 * bypassable. Collapse IPv6 clients to their /64 and leave IPv4 untouched.
 */
export function ipKey(req) {
  const address = req.ip || req.socket?.remoteAddress || 'unknown';
  const normalized = String(address).replace(/^::ffff:/, '');
  if (!normalized.includes(':')) return normalized;
  const [withoutZone] = normalized.split('%');
  const groups = withoutZone.split(':');
  if (withoutZone.includes('::')) return withoutZone;
  return groups.slice(0, 4).join(':');
}

/**
 * Portal limits must be per customer, not per source address: the recommended
 * deployment puts every client behind one reverse proxy or Cloudflare Tunnel,
 * where a shared bucket lets a single visitor exhaust the quota for everyone.
 */
function accountKey(req) {
  return req.customer?.id ? `account:${req.customer.id}` : `ip:${ipKey(req)}`;
}

function limiter(options) {
  return rateLimit({ ...JSON_HEADERS, ...options });
}

export const apiLimiter = limiter({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

export const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.attempts', 'rate_limited_login')
});

/**
 * Login is unauthenticated, so the customer ID from the request body is the
 * only per-customer signal available. Pairing it with the source address keeps
 * one visitor's failures from locking out the rest of the customer base.
 */
export const portalLoginLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const customerId = String(req.body?.customerId ?? '').trim().toUpperCase().slice(0, 32);
    return `${ipKey(req)}|${customerId || 'unknown'}`;
  },
  message: limitMessage('rateLimit.portalLogin', 'rate_limited_login')
});

/** Coarse per-address guard for the whole portal surface. */
export const portalIpLimiter = limiter({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.portalRequests', 'rate_limited')
});

export const portalAccountLimiter = limiter({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalRequests', 'rate_limited')
});

export const portalMutationLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalWifi', 'rate_limited_wifi')
});

export const portalRevealLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalPassword', 'rate_limited_reveal')
});

export const portalBillingLimiter = limiter({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalBilling', 'rate_limited_billing')
});

/**
 * Every trust unlock reaches the provider's billing system, so the portal
 * allows only a handful of attempts per account.
 */
export const portalUnlockLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalUnlock', 'rate_limited_unlock')
});

/**
 * Operator SGP calls reach the provider's billing system on every request, so
 * they get a tighter budget than the generic API limiter allows.
 */
export const sgpAdminLimiter = limiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.sgpAdmin', 'rate_limited_sgp')
});

/** A fleet sync calls the provider once per ONT, so it is rarer still. */
export const sgpSyncLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.sgpSync', 'rate_limited_sgp')
});

/** Operator-side reveal/reset of a customer portal password. */
export const portalPasswordAdminLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.portalPasswordAdmin', 'rate_limited')
});

/**
 * The Evolution webhook is a public endpoint, so it needs its own bucket — but
 * a generous one. A busy number legitimately produces a burst: every QR
 * rotation (~20 s), every message, and one receipt per recipient per delivery
 * state. Sizing this like a login form would drop real traffic, and a dropped
 * event is a message that never appears in the inbox.
 *
 * The key is the source address because all events come from one server; the
 * ceiling is what protects against that server, or something pretending to be
 * it, hammering the panel.
 */
export const waWebhookLimiter = limiter({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: ipKey,
  message: { success: false, error: 'too many webhook deliveries' }
});
