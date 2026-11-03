import { isRequestSecure } from '../config/proxy.js';
import { REFRESH_TTL_MS } from '../models/RefreshToken.js';

/**
 * O cookie do refresh do painel e o do console (0129).
 *
 * Os dois `HttpOnly; SameSite=Strict`, com `Path` restrito: o do painel só
 * viaja para `/api/auth/*`, o do console só para `/api/auth/console/*`. Nomes
 * diferentes E caminhos diferentes, de propósito: num deploy de host único o
 * console e o painel dividem a origem, e um não pode renovar como o outro.
 *
 * O prefixo é `__Secure-` em HTTPS e nenhum em HTTP (o deploy por
 * `http://IP:porta`). O desenho do §5 falava em `__Host-`, mas o navegador só
 * aceita `__Host-` com `Path=/` — e o `Path` restrito é a metade da proteção que
 * importa (o cookie não acompanha cada chamada da API). `__Secure-` sem
 * `Domain` mantém o cookie preso ao host e exige HTTPS.
 *
 * Em HTTPS só o nome com prefixo é lido: um cookie sem prefixo plantado por uma
 * resposta HTTP no mesmo host não serve de credencial.
 */
export const REFRESH_COOKIES = Object.freeze({
  panel: Object.freeze({ secure: '__Secure-skg_rt', plain: 'skg_rt', path: '/api/auth' }),
  console: Object.freeze({ secure: '__Secure-skg_crt', plain: 'skg_crt', path: '/api/auth/console' })
});

/** O cabeçalho que um formulário de outro site não consegue mandar. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'skygenpanel';

/**
 * Um cookie pelo nome, no modelo do `readCookie` de `affiliateAuth.js`: um laço
 * sobre o cabeçalho, sem montar objeto — `__proto__` no cabeçalho não vira
 * nada. Copiado e não importado para não puxar o serviço de afiliados para
 * dentro da autenticação do painel.
 */
function readCookie(header, name) {
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

function cookieSpec(kind) {
  const spec = REFRESH_COOKIES[kind];
  if (!spec) throw new Error(`unknown refresh cookie: ${kind}`);
  return spec;
}

export function refreshCookieName(req, kind) {
  const spec = cookieSpec(kind);
  return isRequestSecure(req) ? spec.secure : spec.plain;
}

export function readRefreshCookie(req, kind) {
  const value = readCookie(req.headers?.cookie, refreshCookieName(req, kind));
  if (typeof value !== 'string' || !value || value.length > 512) return null;
  return value;
}

function cookieOptions(req, kind) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isRequestSecure(req),
    path: cookieSpec(kind).path
  };
}

export function setRefreshCookie(req, res, kind, raw) {
  res.cookie(refreshCookieName(req, kind), raw, { ...cookieOptions(req, kind), maxAge: REFRESH_TTL_MS });
}

export function clearRefreshCookie(req, res, kind) {
  res.clearCookie(refreshCookieName(req, kind), cookieOptions(req, kind));
}

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5890')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o && o !== '*');

/**
 * A guarda de CSRF das rotas que o cookie autentica (refresh, logout e a lista
 * de sessões), no modelo do `portalOriginGuard`:
 *
 * - `Origin`, quando vem, tem que ser este host (ou uma origem que o deploy
 *   declarou em `CORS_ORIGINS`, como o servidor do Vite em desenvolvimento);
 * - `Sec-Fetch-Site`, quando vem, tem que ser `same-origin` ou `none` — um
 *   subdomínio vizinho é `same-site` e é recusado;
 * - `X-Requested-With: skygenpanel` é obrigatório. Um `<form>` de fora não
 *   manda cabeçalho nenhum, e um `fetch` de fora que o mande dispara o
 *   preflight, que o CORS daqui não libera para cookie.
 *
 * O `SameSite=Strict` já segura o cookie; estas três são a segunda e a
 * terceira parede, para o navegador que não o respeitar.
 */
export function sessionCsrfGuard(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === req.get('host');
    } catch {
      sameHost = false;
    }
    if (!sameHost && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ success: false, code: 'origin_not_allowed', message: req.t('common.originNotAllowed') });
    }
  }
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return res.status(403).json({ success: false, code: 'cross_site_blocked', message: req.t('common.crossSiteBlocked') });
  }
  if (req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    return res.status(403).json({ success: false, code: 'csrf_header_required', message: req.t('auth.csrfHeaderRequired') });
  }
  return next();
}
