import 'dotenv/config';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import CustomerAccount from '../models/CustomerAccount.js';
import { isRequestSecure } from '../config/proxy.js';

export const PORTAL_COOKIE_NAME = 'skygp_portal_session';
const PORTAL_SESSION_TTL_SECONDS = 30 * 60;

const baseSecret = process.env.PORTAL_JWT_SECRET || process.env.JWT_SECRET;
if (!baseSecret && process.env.APP_ENV === 'production') {
  throw new Error('PORTAL_JWT_SECRET or JWT_SECRET must be set in production');
}
const portalSecret = process.env.PORTAL_JWT_SECRET || crypto
  .createHmac('sha256', baseSecret || 'insecure-development-secret')
  .update('skygenpanel-customer-portal-v1')
  .digest('hex');

function parseCookies(header) {
  const cookies = {};
  for (const item of String(header || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

/**
 * The provider travels in the payload, and that is belt as well as braces.
 *
 * The braces already hold: `CustomerAccount.getById` below reads through `tdb`,
 * so a cookie minted on one provider's portal finds no account under the host
 * it is replayed at and is refused. But that refusal lives in the SHAPE of a
 * query rather than in the session, and a future reader that forgets the
 * filter would turn a replayed cookie into a working one. Signing the provider
 * makes the refusal a fact about the cookie instead.
 */
export function signPortalSession(account) {
  return jwt.sign(
    {
      accountId: account.id,
      customerId: account.customer_id,
      tenantId: Number(account.tenant_id),
      tokenType: 'customer'
    },
    portalSecret,
    {
      expiresIn: PORTAL_SESSION_TTL_SECONDS,
      issuer: 'skygenpanel',
      audience: 'skygenpanel-customer-portal'
    }
  );
}

export function portalCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isRequestSecure(req),
    maxAge: PORTAL_SESSION_TTL_SECONDS * 1000,
    path: '/'
  };
}

export function portalClearCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isRequestSecure(req),
    path: '/'
  };
}

export async function authenticatePortalCustomer(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[PORTAL_COOKIE_NAME];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: req.t('portal.sessionRequired'),
        code: 'customer_session_required'
      });
    }
    const decoded = jwt.verify(token, portalSecret, {
      issuer: 'skygenpanel',
      audience: 'skygenpanel-customer-portal'
    });
    if (decoded.tokenType !== 'customer' || !decoded.accountId) {
      return res.status(401).json({
        success: false,
        message: req.t('portal.sessionInvalid'),
        code: 'customer_session_invalid'
      });
    }
    // A cookie that names a provider other than the host's is refused before
    // the account is even read. Cookies minted before this field existed carry
    // no `tenantId` and are left to the scoped read below, which is what kept
    // them safe until now — a session in flight during an upgrade should not
    // be thrown away.
    if (decoded.tenantId !== undefined && Number(decoded.tenantId) !== Number(req.tenantId)) {
      return res.status(401).json({
        success: false,
        message: req.t('portal.sessionInvalid'),
        code: 'customer_session_invalid'
      });
    }
    const account = await CustomerAccount.getById(decoded.accountId);
    if (!account || !account.active || account.customer_id !== decoded.customerId) {
      return res.status(401).json({
        success: false,
        message: req.t('portal.sessionStale'),
        code: 'customer_session_invalid'
      });
    }
    req.customer = account;
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: req.t('portal.sessionExpired'),
      code: 'customer_session_expired'
    });
  }
}
