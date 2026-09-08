import rateLimit from 'express-rate-limit';

/** Renders the limiter body in the language negotiated for the request. */
function limitMessage(key) {
  return (req) => ({ success: false, message: req.t(key) });
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
  message: limitMessage('rateLimit.requests')
});

export const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.attempts')
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
  message: limitMessage('rateLimit.portalLogin')
});

/** Coarse per-address guard for the whole portal surface. */
export const portalIpLimiter = limiter({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.portalRequests')
});

export const portalAccountLimiter = limiter({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalRequests')
});

export const portalMutationLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalWifi')
});

export const portalRevealLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalPassword')
});

export const portalBillingLimiter = limiter({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalBilling')
});

/**
 * Every trust unlock reaches the provider's billing system, so the portal
 * allows only a handful of attempts per account.
 */
export const portalUnlockLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalUnlock')
});

/** Operator-side reveal/reset of a customer portal password. */
/**
 * The webhook is public, so it gets its own bucket rather than sharing the
 * one the panel's own UI draws from.
 */
export const sgpWebhookLimiter = limiter({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.requests')
});

/**
 * Provisioning actions write to a subscriber's CPE and each one waits on a
 * connection request, so they are limited per operator on top of the shared
 * API limit rather than by source address.
 */
export const provisioningActionLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.provisioningAction')
});

export const portalPasswordAdminLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.portalPasswordAdmin')
});
