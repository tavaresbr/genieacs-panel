import rateLimit from 'express-rate-limit';

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
  message: { success: false, message: 'Too many requests, please slow down' }
});

export const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: ipKey,
  message: { success: false, message: 'Too many attempts, please try again later' }
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
  message: {
    success: false,
    code: 'rate_limited_login',
    message: 'Terlalu banyak percobaan login. Tunggu 15 menit lalu coba lagi.'
  }
});

/** Coarse per-address guard for the whole portal surface. */
export const portalIpLimiter = limiter({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: ipKey,
  message: {
    success: false,
    code: 'rate_limited',
    message: 'Terlalu banyak permintaan. Coba lagi sebentar.'
  }
});

export const portalAccountLimiter = limiter({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: accountKey,
  message: {
    success: false,
    code: 'rate_limited',
    message: 'Terlalu banyak permintaan. Coba lagi sebentar.'
  }
});

export const portalMutationLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: accountKey,
  message: {
    success: false,
    code: 'rate_limited_wifi',
    message: 'Terlalu banyak perubahan WiFi. Tunggu 15 menit lalu coba lagi.'
  }
});

export const portalRevealLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: accountKey,
  message: {
    success: false,
    code: 'rate_limited_reveal',
    message: 'Terlalu banyak permintaan password. Tunggu 15 menit lalu coba lagi.'
  }
});

export const portalBillingLimiter = limiter({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: accountKey,
  message: {
    success: false,
    code: 'rate_limited_billing',
    message: 'Muitas consultas de faturas. Aguarde um instante e tente novamente.'
  }
});

/**
 * Every trust unlock reaches the provider's billing system, so the portal
 * allows only a handful of attempts per account.
 */
export const portalUnlockLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: accountKey,
  message: {
    success: false,
    code: 'rate_limited_unlock',
    message: 'Limite de solicitações de liberação atingido. Tente novamente mais tarde.'
  }
});

/**
 * Operator SGP calls reach the provider's billing system on every request, so
 * they get a tighter budget than the generic API limiter allows.
 */
export const sgpAdminLimiter = limiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: {
    success: false,
    code: 'rate_limited_sgp',
    message: 'Too many SGP requests, please slow down'
  }
});

/** Operator-side reveal/reset of a customer portal password. */
export const portalPasswordAdminLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: { success: false, message: 'Too many portal password requests, please slow down' }
});
