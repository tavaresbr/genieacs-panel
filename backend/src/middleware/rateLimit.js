import rateLimit from 'express-rate-limit';
import { tenantSlugFromHost } from './tenantResolver.js';

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
 * The provider a request is addressed to, folded into the bucket key.
 *
 * The comment below on `accountKey` names the deployment this exists for: every
 * client arrives through one reverse proxy or tunnel, so one address is every
 * caller. On a deployment serving several ISPs that means ONE bucket for all of
 * them, and a single provider's traffic switches off everybody's panel.
 *
 * The slug is read from the host rather than from `req.tenantId`, because the
 * shared limiters are mounted ahead of the resolver — deliberately, so that a
 * flood is refused before it can cost a database read. A deployment without
 * subdomains yields the same empty discriminator for every request and keeps
 * exactly the buckets it has today.
 *
 * The cost is real and worth stating: somebody hitting N providers' hosts from
 * one address now gets N times the budget. That is the price of one provider
 * not being able to exhaust another's, and on a deployment where every request
 * shares a source address it is the cheaper of the two failures.
 */
function tenantScopeKey(req) {
  return tenantSlugFromHost(String(req.headers.host ?? '').split(':')[0].toLowerCase()) || '-';
}

/** Per source address, but never shared between providers. */
export function tenantIpKey(req) {
  return `${tenantScopeKey(req)}|${ipKey(req)}`;
}

/**
 * Portal limits must be per customer, not per source address: the recommended
 * deployment puts every client behind one reverse proxy or Cloudflare Tunnel,
 * where a shared bucket lets a single visitor exhaust the quota for everyone.
 */
function accountKey(req) {
  return req.customer?.id
    ? `account:${req.customer.id}`
    : `ip:${tenantIpKey(req)}`;
}

function limiter(options) {
  return rateLimit({ ...JSON_HEADERS, ...options });
}

export const apiLimiter = limiter({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

export const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: tenantIpKey,
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
    return `${tenantIpKey(req)}|${customerId || 'unknown'}`;
  },
  message: limitMessage('rateLimit.portalLogin', 'rate_limited_login')
});

/**
 * O convite, aberto sem sessão.
 *
 * Adivinhar não é a ameaça: são 32 bytes de `randomBytes`. O que este balde
 * segura é o custo — duas rotas sem autenticação que consultam o banco a cada
 * chamada, e a de aceitar ainda roda um bcrypt quando o nome existe. Chaveado
 * por provedor e endereço como o resto, para que um ISP barulhento não feche a
 * porta dos outros.
 */
/**
 * `POST /api/auth/email`: o cadastro do próprio endereço de login.
 *
 * A ação é rara — cada pessoa faz uma vez — e a resposta 409 é um oráculo: a
 * tabela `users` é uma só para a plataforma inteira, então "esse e-mail já está
 * em uso" responde se um endereço tem conta em ALGUM provedor, e quem tem
 * sessão em qualquer um deles pode perguntar. O oráculo é inerente à unicidade
 * global, que é o que faz o e-mail servir de identificador de login; o que se
 * tira dele é a escala. Dez por quarto de hora cobrem qualquer uso legítimo
 * com folga e transformam uma enumeração num gotejo.
 */
export const emailChangeLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * `POST /api/users`: criar um operador. O mesmo oráculo do limitador acima, na
 * mão de um administrador de provedor — e o mesmo remédio. Sessenta por quarto
 * de hora é uma equipe inteira cadastrada numa sentada, e não é uma varredura.
 */
export const operatorCreateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

export const inviteAcceptLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * O resgate do bilhete de personificação.
 *
 * Apertado porque é uma rota sem sessão que consulta o banco, e frouxo o
 * bastante para o caso real: uma pessoa do plantão da plataforma atende alguns
 * ISPs por hora, não alguns por segundo. O bilhete são 32 bytes e vale um
 * minuto, então adivinhar não é o risco — o balde existe para a rota não virar
 * bomba de tráfego.
 */
export const impersonationRedeemLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/** Coarse per-address guard for the whole portal surface. */
export const portalIpLimiter = limiter({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: tenantIpKey,
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

/**
 * The signed media route the Evolution server fetches an attachment from.
 *
 * Its own bucket for the same reason as the webhook's — no session to key on —
 * and lower, because one fetch per outbound attachment is a far quieter shape
 * than one delivery receipt per recipient per state. It also reads a file off
 * the disk, which the webhook does not.
 */
export const waMediaLimiter = limiter({
  windowMs: 60 * 1000,
  max: 240,
  keyGenerator: ipKey,
  message: { success: false, error: 'too many media fetches' }
});

/**
 * The operator's attachment upload, limited BEFORE its body is read.
 *
 * This one is not about the route's own cost — it is about the 16 MB the raw
 * parser is willing to hold. That parser is reserved on the path early, ahead
 * of the shared `apiLimiter`, because the global JSON parser would otherwise
 * claim the body first; the effect was that an anonymous caller could make the
 * panel buffer 16 MB before anything had the chance to refuse the request.
 *
 * The key is the source address rather than the session, deliberately: it has
 * to count a caller that has NO session, which is exactly the case worth
 * refusing. The ceiling is sized for a human attaching files, not for a
 * campaign — outbound campaign attachments are uploaded once and reused.
 */
export const attachmentUploadLimiter = limiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});
