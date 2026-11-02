import 'dotenv/config';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { isRequestSecure } from '../config/proxy.js';
import { DEVELOPMENT_FALLBACK, assertNotPlaceholderSecret, isProduction } from '../config/runtimeEnv.js';
import AffiliateService from '../services/affiliateService.js';

/**
 * A sessão do portal do afiliado (0126), no molde de `portalAuth.js`.
 *
 * Três coisas a separam de qualquer outra sessão do produto, e é de propósito:
 *
 * 1. **Segredo próprio**, derivado por HMAC do `JWT_SECRET` com um rótulo só
 *    dela (ou `AFFILIATE_JWT_SECRET`). Um token do painel, do console ou do
 *    portal do assinante não verifica aqui, nem o contrário.
 * 2. **Cookie próprio**, httpOnly e SameSite=strict: o portal nunca lê o
 *    `Authorization` — a sessão do console guardada no mesmo navegador não
 *    vale nada nestas rotas.
 * 3. **Audiência e tipo próprios** no payload, conferidos.
 *
 * O afiliado é relido a cada requisição: suspenso, com a senha trocada ou com
 * o e-mail trocado pelo console está fora — cada uma dessas mudanças sobe a
 * `session_version` dele, e o cookie que leva a versão antiga (`sv`) deixa de
 * valer. O algoritmo é fixo em HS256 na verificação.
 */
export const AFFILIATE_COOKIE_NAME = 'skygp_affiliate_session';
const AFFILIATE_SESSION_TTL_SECONDS = 60 * 60;
const AUDIENCE = 'skygenpanel-affiliate-portal';

const baseSecret = process.env.AFFILIATE_JWT_SECRET || process.env.JWT_SECRET;
if (!baseSecret && isProduction()) {
  throw new Error('AFFILIATE_JWT_SECRET or JWT_SECRET must be set in production');
}
assertNotPlaceholderSecret('AFFILIATE_JWT_SECRET', process.env.AFFILIATE_JWT_SECRET);
const affiliateSecret = process.env.AFFILIATE_JWT_SECRET || crypto
  .createHmac('sha256', baseSecret || DEVELOPMENT_FALLBACK)
  .update('skygenpanel-affiliate-portal-v1')
  .digest('hex');

/**
 * O valor de UM cookie, pelo nome — e só dele. Não monta um objeto com todos
 * os nomes que vieram no cabeçalho: o nome é do cliente, e um `__proto__=` ou
 * `constructor=` escrito como chave de um objeto comum mexeria no protótipo.
 * Aqui o nome do cabeçalho só é comparado com o nome fixo, nunca vira chave.
 */
export function readCookie(header, name) {
  for (const item of String(header || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    if (item.slice(0, separator).trim() !== name) continue;
    const value = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * A versão das sessões gravada no afiliado (`session_version`, 0126): sobe,
 * atômica, quando a senha é definida ou trocada, o e-mail muda ou o afiliado
 * é suspenso. O cookie leva a versão em que nasceu (`sv`) — nenhum dado da
 * senha nem do e-mail entra nele.
 */
function sessionVersion(affiliate) {
  const versao = Number(affiliate?.session_version ?? 0);
  return Number.isInteger(versao) ? versao : null;
}

export function signAffiliateSession(affiliate) {
  return jwt.sign(
    {
      affiliateId: Number(affiliate.id),
      sv: sessionVersion(affiliate),
      tokenType: 'affiliate'
    },
    affiliateSecret,
    { expiresIn: AFFILIATE_SESSION_TTL_SECONDS, issuer: 'skygenpanel', audience: AUDIENCE }
  );
}

export function affiliateCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isRequestSecure(req),
    maxAge: AFFILIATE_SESSION_TTL_SECONDS * 1000,
    path: '/'
  };
}

export function affiliateClearCookieOptions(req) {
  return {
    httpOnly: true, sameSite: 'strict', secure: isRequestSecure(req), path: '/'
  };
}

function recusar(req, res, code) {
  return res.status(401).json({
    success: false,
    message: req.t ? req.t(code === 'affiliate_session_required' ? 'affiliate.sessionRequired' : 'affiliate.sessionExpired') : 'Unauthorized',
    code
  });
}

export async function authenticateAffiliate(req, res, next) {
  const token = readCookie(req.headers.cookie, AFFILIATE_COOKIE_NAME);
  if (!token) return recusar(req, res, 'affiliate_session_required');
  let decoded;
  try {
    decoded = jwt.verify(token, affiliateSecret, { issuer: 'skygenpanel', audience: AUDIENCE, algorithms: ['HS256'] });
  } catch {
    return recusar(req, res, 'affiliate_session_expired');
  }
  try {
    if (decoded?.tokenType !== 'affiliate' || !Number.isInteger(decoded.affiliateId)) {
      return recusar(req, res, 'affiliate_session_invalid');
    }
    const affiliate = await AffiliateService.findById(decoded.affiliateId);
    if (!affiliate || affiliate.status !== 'active' || !affiliate.password_hash
      || !Number.isInteger(decoded.sv) || decoded.sv !== sessionVersion(affiliate)) {
      return recusar(req, res, 'affiliate_session_invalid');
    }
    req.affiliate = affiliate;
    return next();
  } catch (error) {
    console.error('Affiliate session check failed:', String(error?.message).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 300));
    return res.status(500).json({ success: false, code: 'affiliate_session_failed' });
  }
}
