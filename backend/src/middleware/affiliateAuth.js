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
 * O afiliado é relido a cada requisição: suspenso, com a senha trocada (a
 * impressão do hash no cookie, como no portal do assinante) ou com o e-mail
 * trocado pelo console (a impressão do e-mail, idem), está fora — a senha é
 * da pessoa daquele endereço. O algoritmo é fixo em HS256 na verificação.
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
 * A impressão da sessão: um HMAC com o segredo desta sessão sobre um dado já
 * guardado no banco, cortado. Não é hash de senha — a senha em claro nunca
 * passa por aqui; o que entra é o hash bcrypt já gravado (ou o e-mail), e o
 * resultado só serve para notar que ele mudou desde que o cookie foi emitido.
 * Com chave, a impressão no cookie (que o cliente lê, é um JWT) não deixa
 * conferir palpites contra o hash guardado.
 */
function sessionBinding(label, storedValue, size) {
  return crypto.createHmac('sha256', affiliateSecret)
    .update(`${label}\0${storedValue}`)
    .digest('base64url')
    .slice(0, size);
}

/** A impressão do hash bcrypt guardado: trocar a senha encerra as sessões abertas. */
function storedHashBinding(affiliate) {
  const storedBcryptHash = affiliate?.password_hash;
  if (!storedBcryptHash) return null;
  return sessionBinding('pwd-hash', String(storedBcryptHash), 22);
}

/** A impressão do e-mail: trocá-lo no console encerra as sessões abertas. */
function emailBinding(affiliate) {
  const email = String(affiliate?.email ?? '').trim().toLowerCase();
  if (!email) return null;
  return sessionBinding('email', email, 16);
}

export function signAffiliateSession(affiliate) {
  return jwt.sign(
    {
      affiliateId: Number(affiliate.id),
      pwd: storedHashBinding(affiliate),
      em: emailBinding(affiliate),
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
    const atual = storedHashBinding(affiliate);
    if (!affiliate || affiliate.status !== 'active' || !atual || decoded.pwd !== atual
      || decoded.em !== emailBinding(affiliate)) {
      return recusar(req, res, 'affiliate_session_invalid');
    }
    req.affiliate = affiliate;
    return next();
  } catch (error) {
    console.error('Affiliate session check failed:', error.message);
    return res.status(500).json({ success: false, code: 'affiliate_session_failed' });
  }
}
