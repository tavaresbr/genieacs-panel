import { getDb } from '../config/database.js';
import { runInTenant } from '../config/tenantContext.js';
import { IS_SAAS } from '../config/edition.js';

/**
 * Puts a provider into scope before anything under `/api` runs.
 *
 * This is the scope for work done WITHOUT a session — login, setup, refresh,
 * the customer portal — and nothing more. It is provisional: an authenticated
 * request is re-scoped by `authenticateToken` to the provider its token names,
 * once that membership has been read back from `tenant_users`, and that scope
 * covers the whole route chain underneath.
 *
 * The order matters and reads backwards at first glance. This is `app.use`'d
 * ahead of the routes while `authenticateToken` runs inside each of them, so
 * the host is what a request has until its token has been verified — which is
 * exactly right, because until then the only thing naming a provider is the
 * caller.
 */

/**
 * The suffix under which a provider's subdomain lives, if this deployment
 * gives providers subdomains at all.
 *
 * Two variables rather than one because the panel and the subscriber portal
 * are two listeners with two names: `alfa.painel.exemplo.com` and
 * `alfa.portal.exemplo.com`. A deployment that sets neither — every
 * self-hosted install — never takes the subdomain path at all.
 */
const PANEL_BASE_DOMAIN = normalizeDomain(process.env.TENANT_BASE_DOMAIN);
const PORTAL_BASE_DOMAIN = normalizeDomain(process.env.PORTAL_BASE_DOMAIN);

function normalizeDomain(value) {
  const domain = String(value ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  return domain || null;
}

/** The host without its port, lowercased. `Host` carries the port; DNS does not. */
function hostOf(req) {
  const raw = String(req.headers.host ?? '').trim().toLowerCase();
  if (!raw) return '';
  // An IPv6 literal is bracketed, and the colon inside it is not a port.
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1);
  const colon = raw.lastIndexOf(':');
  return colon === -1 ? raw : raw.slice(0, colon);
}

/**
 * The provider slug a host names, or null when the host names none.
 *
 * Only the label immediately left of the configured base counts:
 * `alfa.painel.exemplo.com` is provider `alfa`, and `painel.exemplo.com` on its
 * own is not a provider at all — it is the deployment's own name, and a
 * request arriving there has not said which provider it wants. Anything deeper
 * (`a.b.painel.exemplo.com`) is refused rather than guessed, because guessing
 * would mean picking one of two labels to believe.
 */
export function tenantSlugFromHost(host, bases = [PANEL_BASE_DOMAIN, PORTAL_BASE_DOMAIN]) {
  if (!host) return null;
  for (const base of bases) {
    if (!base || !host.endsWith(`.${base}`)) continue;
    const label = host.slice(0, -(base.length + 1));
    if (!label || label.includes('.')) continue;
    return label;
  }
  return null;
}

// Both caches exist because a provider cannot change identity under a running
// process: one arrives by migration or by the platform console, and both mean a
// restart or an explicit invalidation.
let cachedDefaultId = null;
const cachedBySlug = new Map();

export function forgetResolvedTenant() {
  cachedDefaultId = null;
  cachedBySlug.clear();
}

/**
 * The installation's own provider: the first row.
 *
 * This is what a request gets when no host named a provider, and it is what
 * keeps every self-hosted install working unchanged — there is one row there
 * and it is the answer.
 *
 * It is only reached when this deployment configures no base domain at all.
 * Where subdomains ARE configured, naming the provider is how the deployment
 * works, and a host that names none is refused instead: falling back to the
 * first row there would answer with one provider's data for a request that
 * asked for nobody, which is the failure the whole mechanism exists to
 * prevent. That distinction is made by the caller, not here.
 */
export async function resolveDefaultTenantId() {
  if (cachedDefaultId !== null) return cachedDefaultId;
  const row = await getDb()('tenants').orderBy('id', 'asc').first();
  if (!row) return null;
  cachedDefaultId = row.id;
  return cachedDefaultId;
}

/**
 * The panel's base domain, for whoever has to build a provider's address —
 * the public profile (so the screen can offer signup) and signup itself (so
 * it can tell the new ISP where their panel is). Null on a deployment without
 * subdomains, where there is no such address to build.
 */
export function panelBaseDomain() {
  return PANEL_BASE_DOMAIN;
}

/** Whether this deployment reaches providers by subdomain at all. */
export function usesTenantSubdomains() {
  return Boolean(PANEL_BASE_DOMAIN || PORTAL_BASE_DOMAIN);
}

/**
 * Whether the host this request arrived at may act for `tenantId`.
 *
 * `req.hostTenantId` is set only when the host NAMED a provider, which is the
 * only case where the two can disagree in the first place. Where the host names
 * nobody — every deployment without subdomains — there is a single door, and
 * this is always true: what names the provider there is the credential, not the
 * address.
 *
 * Exported, and the only copy, because there are two callers and they were
 * drifting. `tokenMatchesHost` had it right; the impersonation redeem compared
 * against `req.tenantId`, which on a deployment without subdomains is the FIRST
 * provider (see `resolveDefaultTenantId`) — so a ticket for any other provider
 * was refused as if it were forged. A rule implemented twice is a rule that is
 * wrong in one of the two places.
 */
export function hostMatchesTenant(req, tenantId) {
  if (!req.hostTenantId) return true;
  return Number(req.hostTenantId) === Number(tenantId);
}

/**
 * The platform's own front door: the panel's base domain with no provider in
 * front of it, and `www.` of the same.
 *
 * Until now a request there was refused, on the reasoning that a host naming
 * nobody is a request that did not say who it is for. That is still the rule
 * for anything that reads a provider's data. But an ISP that does not exist
 * yet has no subdomain to arrive at, and making it sign up from SOME OTHER
 * provider's host — which is what the first cut did — means the platform's
 * front door is one of its customers' doors. So the apex serves what a
 * stranger needs — the public profile, which says this is a SaaS and where
 * providers live, and the sign-up — plus what the platform's own console
 * needs, and nothing else. Only what is listed here, and only where
 * subdomains are configured at all.
 *
 * Two lists because the two shapes of path are different in kind:
 *
 * - **exact**, for the handful of named endpoints. A path either is one of
 *   them or is not, and the list reads as the surface it describes.
 * - **by prefix**, for `/api/platform/`, which is some twenty paths with an
 *   `:id` in the middle. Spelled out one by one it would be a second copy of
 *   the route table, drifting from the first the day someone adds a route.
 *
 * A prefix is the wider claim, so it is only ever a whole namespace that
 * belongs to the platform by construction — never `/api/auth/` (where
 * password reset and e-mail verification write to a provider's audit trail
 * and would fail unscoped here) and never anything reading provider data.
 */
const CONSOLE_HOST_PATHS = [
  // O que a sessão do console precisa. Cada um foi conferido por não tocar em
  // `tdb`: no ápice não há provedor em escopo, e uma leitura escopada aqui
  // estoura. É a conferência que qualquer caminho novo nesta lista precisa
  // passar.
  '/api/auth/setup-status',
  '/api/auth/login',
  '/api/auth/user',
  '/api/auth/logout',
  '/api/auth/refresh',
  // Sem esta, quem opera a plataforma e não trabalha em provedor nenhum não
  // troca a própria senha em lugar nenhum.
  '/api/auth/change-password'
];

const PLATFORM_HOST_PATHS = new Set([
  // O que um estranho precisa.
  '/api/tenant/public',
  '/api/auth/signup',
  // E o console, só onde ele existe: num install self-hosted as rotas dele não
  // são montadas, não há cadastro de plataforma, e o ápice não tem por que
  // servir a porta de uma coisa que não está lá. Assim a superfície do ápice
  // continua exatamente tão estreita quanto era para quem não é SaaS.
  ...(IS_SAAS ? CONSOLE_HOST_PATHS : [])
]);

/**
 * The control plane's own namespace. It names the provider in the path and
 * opens the scope it needs with an explicit `runInTenant`, so it is the one
 * family of routes that has no business being resolved by host.
 */
const PLATFORM_HOST_PREFIXES = IS_SAAS ? ['/api/platform/'] : [];

export function isPlatformHost(host) {
  if (!PANEL_BASE_DOMAIN || !host) return false;
  return host === PANEL_BASE_DOMAIN || host === `www.${PANEL_BASE_DOMAIN}`;
}

function servedOnPlatformHost(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (PLATFORM_HOST_PATHS.has(path)) return true;
  return PLATFORM_HOST_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** The provider a slug names, or null. Inactive providers do not resolve. */
export async function resolveTenantIdBySlug(slug) {
  if (!slug) return null;
  if (cachedBySlug.has(slug)) return cachedBySlug.get(slug);
  const row = await getDb()('tenants').where({ slug }).first();
  const id = row && row.status === 'active' ? row.id : null;
  // Only an answer worth keeping is kept. Caching the misses too would mean
  // anyone able to reach the panel can grow this Map without bound by asking
  // for `a.painel`, `b.painel`, `c.painel` — a slug nobody has costs one query
  // and is meant to cost nothing more. Providers are few and the hits are what
  // this cache exists for.
  if (id !== null) cachedBySlug.set(slug, id);
  return id;
}

/**
 * Express middleware. A request that cannot be attributed to a provider is
 * refused rather than served unscoped: an unattributed read is the failure this
 * whole mechanism exists to prevent.
 *
 * A host that names a provider nobody has is 404, never 403 — a 403 would
 * confirm which slugs exist, and the slug list is the customer list.
 */
export function resolveTenant(req, res, next) {
  const host = hostOf(req);
  const slug = tenantSlugFromHost(host);

  // The front door. No provider is put in scope — there is none — so any
  // scoped query reached from here fails loudly, which is the sentinel doing
  // what it is for. The two routes served here touch only shared tables.
  // Checked before the slug: `www.painel…` parses as provider `www`, which is
  // a reserved slug precisely so that this branch is the one that answers.
  if (isPlatformHost(host) && servedOnPlatformHost(req)) {
    req.tenantId = null;
    req.hostTenantId = null;
    req.platformHost = true;
    return next();
  }

  // A deployment with subdomains has no default to fall back to: the host is
  // how a provider is named there, so a host that names none is a request that
  // did not say who it is for.
  const resolved = slug
    ? resolveTenantIdBySlug(slug).then((id) => ({ id, named: true }))
    : usesTenantSubdomains()
      ? Promise.resolve({ id: null, named: true })
      : resolveDefaultTenantId().then((id) => ({ id, named: false }));

  resolved
    .then(({ id, named }) => {
      if (!id) {
        return res.status(named ? 404 : 503).json({
          success: false,
          message: named
            ? (req.t ? req.t('common.notFound') : 'Provider not found')
            : (req.t ? req.t('common.internalError') : 'No provider configured')
        });
      }
      req.tenantId = id;
      // Kept apart from `req.tenantId`, which `authenticateToken` overwrites
      // with whatever the token names. The check that the two agree is what
      // stops a token being replayed on another provider's host, and it needs
      // the host's answer to still be here after that overwrite.
      req.hostTenantId = named ? id : null;
      return runInTenant(id, () => next());
    })
    .catch(next);
}
