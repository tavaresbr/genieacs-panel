import 'dotenv/config';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import TenantUser from '../models/TenantUser.js';
import PlatformAdmin from '../models/PlatformAdmin.js';
import { runInTenant } from '../config/tenantContext.js';

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';

const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (secret) {
    if (process.env.APP_ENV === 'production' && secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters in production');
    }
    return secret;
  }
  if (process.env.APP_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  console.warn('JWT_SECRET not set; using insecure development fallback');
  return 'insecure-development-secret';
})();

/**
 * Mints the pair a session runs on.
 *
 * `membership` is required rather than optional, and deliberately so. Every
 * caller — login, setup, refresh — has already worked out which provider the
 * session is for, and a token minted without one would come back to whatever
 * `resolveTenant` answers by default: a session for whichever provider happens
 * to hold the lowest id. Making the argument mandatory turns that mistake into
 * a crash on the first call instead of a quiet cross-provider read in
 * production.
 *
 * The role written into the token is the MEMBERSHIP's, never `users.role`. The
 * same person can be an administrator at the ISP they own and an ordinary
 * operator at one they consult for, and `requireRole` reads what is here.
 *
 * The refresh token carries `tenantId` as well, because it has to be able to
 * mint the same thing again: without it a refresh would have to guess the
 * provider back, which is the guess this whole change exists to remove.
 */
function generateTokens(user, membership) {
  const tenantId = Number(membership?.tenant_id ?? membership?.tenantId);
  const role = membership?.role;
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !role) {
    throw new Error('generateTokens needs the membership the session is for');
  }

  const commonOptions = {
    issuer: 'skygenpanel',
    audience: 'skygenpanel-admin'
  };
  const accessToken = jwt.sign(
    {
      userId: user.id,
      username: user.username,
      tenantId,
      role,
      tokenVersion: Number(user.token_version || 0)
    },
    JWT_SECRET,
    { ...commonOptions, expiresIn: JWT_EXPIRES_IN }
  );

  const refreshToken = jwt.sign(
    {
      userId: user.id,
      tenantId,
      tokenType: 'refresh',
      tokenVersion: Number(user.token_version || 0)
    },
    JWT_SECRET,
    { ...commonOptions, expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );

  return { accessToken, refreshToken };
}

function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: 'skygenpanel',
      audience: 'skygenpanel-admin'
    });
    return decoded;
  } catch {
    return null;
  }
}

/**
 * The membership a token stands for, or null.
 *
 * Two rules, and the second is the transition.
 *
 * When the token names a provider, the membership is read back from the table
 * on every request rather than believed from the token. The claims record what
 * the person's access was when they signed in; access withdrawn since has to
 * stop working before the hour the token is good for runs out, and a token
 * naming a provider the person no longer works for has to answer the same way
 * as a token naming one they never worked for. The role comes from the row for
 * the same reason — a demotion applies at the next request, not at the next
 * sign-in — which leaves the role in the token as a record of what it was, and
 * the row as the thing that decides.
 *
 * A token minted before this change carries no `tenantId` at all. It keeps
 * working, resolved through the person's sole membership — dropping every open
 * session on an upgrade would put the whole night shift back at the login
 * screen for nothing. With more than one membership and no `tenantId` there is
 * no honest answer, so it refuses: picking one would mean handing somebody
 * another ISP's fleet on a coin toss, and the person can simply sign in again
 * to say which provider they mean.
 */
async function resolveMembership(userId, tenantId) {
  if (tenantId === undefined || tenantId === null) {
    const memberships = await TenantUser.listForUser(userId);
    return memberships.length === 1 ? memberships[0] : null;
  }
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return TenantUser.find(id, userId);
}

/**
 * Who is asking and where they are asking from, or null for "not a session".
 *
 * Every refusal collapses to the same null on purpose: an expired revocation,
 * a deleted person and a membership that ended are three different facts, and
 * the caller holding a token has no business learning which of them applies.
 */
async function hydrateAuthenticatedUser(decoded) {
  if (!decoded || decoded.tokenType || !Number.isInteger(Number(decoded.userId))) {
    return null;
  }
  const user = await User.findById(decoded.userId);
  if (!user || Number(user.token_version || 0) !== Number(decoded.tokenVersion || 0)) {
    return null;
  }
  const membership = await resolveMembership(user.id, decoded.tenantId);
  if (!membership) return null;

  return {
    userId: user.id,
    username: user.username,
    role: membership.role,
    tenantId: Number(membership.tenant_id),
    tokenVersion: Number(user.token_version || 0)
  };
}

/**
 * Puts the request in the provider its token names, then lets it through.
 *
 * `resolveTenant` runs first, as `app.use('/api', …)`, and opens the
 * installation's own provider so that everything reachable WITHOUT a session —
 * login, setup, refresh — has a scope to work in. That scope is provisional.
 * The moment a token has been verified against the table we know which provider
 * this request is actually for, and re-entering `runInTenant` around `next()`
 * replaces it for the whole rest of the chain: the route's own middleware, the
 * controller, the models, and every asynchronous continuation underneath them,
 * since that is what an AsyncLocalStorage scope covers.
 *
 * Doing it here rather than in `resolveTenant` is the point. The resolver sees
 * only what the caller sent; this runs after the membership has been read back
 * from `tenant_users`, so the scope a request runs in is one the person
 * demonstrably still holds, not one they claimed.
 *
 * What that leaves: a future route mounted under `/api` that reads scoped data
 * WITHOUT `authenticateToken` would silently read the installation's own
 * provider. Every panel route today requires it — the exceptions (health, the
 * Evolution webhook, the signed media fetch) either run before the resolver or
 * open their own scope explicitly.
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: req.t('auth.tokenRequired') });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({
      message: req.t('auth.invalidToken'),
      code: 'invalid_token'
    });
  }

  if (decoded.tokenType) {
    return res.status(403).json({
      message: req.t('auth.invalidTokenType'),
      code: 'invalid_token'
    });
  }

  let session;
  try {
    session = await hydrateAuthenticatedUser(decoded);
  } catch (error) {
    return next(error);
  }

  if (!session) {
    return res.status(403).json({
      message: req.t('auth.sessionInvalid'),
      code: 'invalid_token'
    });
  }

  req.user = session;
  req.tenantId = session.tenantId;
  return runInTenant(session.tenantId, () => next());
}

async function authenticateTokenOptional(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  const decoded = verifyToken(token);
  let session;
  try {
    session = decoded ? await hydrateAuthenticatedUser(decoded) : null;
  } catch (error) {
    return next(error);
  }

  req.user = session;
  // A token that did not resolve leaves the provisional scope in place: the
  // request carries on as an anonymous one, which is what this middleware is
  // for. A token that did resolve re-scopes exactly as the mandatory form does.
  if (!session) return next();
  req.tenantId = session.tenantId;
  return runInTenant(session.tenantId, () => next());
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: req.t('auth.required') });
    }

    if (roles && !roles.includes(req.user.role)) {
      return res.status(403).json({ message: req.t('auth.insufficientPermissions') });
    }

    next();
  };
}

/**
 * Lets through only the people who hold the control plane.
 *
 * Runs after `authenticateToken`, so `req.user` is a session that has already
 * been checked against the tables. What this adds is a different KIND of
 * authority: `requireRole` asks what somebody is at the provider their token
 * names, and the answer is never "may create providers" — an administrator at
 * an ISP administers that ISP. Being admin at a provider must not reach the
 * control plane, which is the whole point of a second roster.
 *
 * The roster is read from `platform_admins` on EVERY request, exactly as wave
 * 12 re-reads the membership. The token is a claim about who signed in; it is
 * never the authority. A grant withdrawn at 09:00 has to stop working at 09:00
 * and not whenever the hour the token is good for happens to run out — and at
 * this level, where the withdrawn grant may be the reason somebody was taken
 * off it, waiting out an expiry is not a compromise worth making. There is no
 * platform claim in the token for the same reason: a claim nobody trusts is
 * one somebody eventually trusts by mistake.
 *
 * A caller who is not on the roster is answered 404, not 403, in the exact body
 * `app.js` gives an unrouted `/api` path. The contract froze that reasoning one
 * level up: the platform routes are mounted under `IS_SAAS`, and on a
 * self-hosted install they do not answer 403 — they do not exist, because a 403
 * tells whoever asked that the control plane is there. The same sentence
 * decides this one. A 403 here would tell a provider's own administrator that
 * the control plane exists on this deployment and that they are merely not on
 * it, which is exactly the fact worth not confirming: it turns a shrug into a
 * target and names the shape of account worth phishing for. With a 404, their
 * token cannot tell a hosted deployment's control plane from a self-hosted
 * install's not having one. It is also the answer wave 12 already settled on
 * for the neighbouring question — an id with no membership at this provider is
 * answered as nonexistent, never as forbidden.
 *
 * What this does NOT hide, and cannot: `authenticateToken` runs first, so an
 * anonymous request to a mounted platform route still answers 401 where an
 * unrouted path answers 404. Closing that is the mounting's business — the
 * lanes that build these routes decide it — not the guard's.
 */
async function requirePlatformAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: req.t('auth.required') });
  }

  let holdsIt;
  try {
    holdsIt = await PlatformAdmin.has(req.user.userId);
  } catch (error) {
    return next(error);
  }

  if (!holdsIt) {
    return res.status(404).json({
      success: false,
      message: req.t('common.routeNotFound')
    });
  }

  return next();
}

export {
  generateTokens,
  verifyToken,
  resolveMembership,
  authenticateToken,
  authenticateTokenOptional,
  requireRole,
  requirePlatformAdmin
};
