import 'dotenv/config';

/**
 * The secret a process falls back to when none is configured. It is a constant
 * in a public repository, so anything it protects is protected from nobody:
 * every guard below exists to make sure a real deployment never reaches it.
 */
export const DEVELOPMENT_FALLBACK = 'insecure-development-secret';

/**
 * Whether this process is serving real data.
 *
 * Both variables are honoured, and the second is the point. Every supported
 * install path sets `APP_ENV` — `install.sh` and the Dockerfile both do — but
 * an install started outside them with only `NODE_ENV=production` used to fall
 * through to `DEVELOPMENT_FALLBACK`, and a guard that depends on which of two
 * conventional variables an operator happened to use is a guard that fails
 * open on the unlucky one.
 *
 * This lives on its own so the answer is one answer. It used to be written out
 * at each of the four places that needed it, and they drifted: `secretBox`
 * honoured both variables while the session secrets honoured only `APP_ENV`,
 * which meant a `NODE_ENV=production` install encrypted its stored secrets
 * correctly and then signed its admin sessions with the constant above.
 */
export function isProduction() {
  return process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production';
}

/**
 * Refuses, in production, a secret copied from `.env.example` or equal to the
 * development fallback.
 *
 * `JWT_SECRET=change_me_to_a_long_random_string` is 33 characters and passed
 * the length rule, so a manual install that followed `cp .env.example .env`
 * signed administrator sessions — and derived the stored-secret keys — from a
 * value published in this repository. `install.sh` generates random secrets
 * and never gets here; this is for the path around it.
 *
 * Only the placeholder is refused, not a short value: `PORTAL_JWT_SECRET` and
 * `SECRET_BOX_KEY` never had a length rule, and adding one now would stop
 * existing installs from booting over a value nobody can guess anyway.
 */
export function assertNotPlaceholderSecret(name, value) {
  if (!value || !isProduction()) return;
  const text = String(value).trim();
  if (/change_?me/i.test(text) || text === DEVELOPMENT_FALLBACK) {
    throw new Error(`${name} still holds the example value; generate a random one for production`);
  }
}

/**
 * Recusa, em produção, `CORS_ORIGINS` com `*`.
 *
 * O `*` desliga a checagem de origem inteira (`isAllowedOrigin` em `app.js`):
 * qualquer site aberto no navegador de um operador passa a poder chamar a API
 * do painel com as credenciais que o próprio navegador anexa. Em
 * desenvolvimento isso é conveniência e continua valendo; em produção é uma
 * porta que ninguém abre de propósito, então o processo nem sobe e diz o que
 * pôr no lugar. A origem igual ao `Host` continua aceita sem estar na lista,
 * então quem só usa o painel pelo próprio endereço não precisa listar nada.
 */
export function assertCorsOriginsSafe(origins, production = isProduction()) {
  if (!production) return;
  if ((origins || []).some((o) => String(o).trim() === '*')) {
    throw new Error(
      "CORS_ORIGINS='*' is not allowed in production: list the panel's browser origins "
      + '(e.g. CORS_ORIGINS=https://<panel host>); same-host requests are already accepted'
    );
  }
}

/**
 * `CSP_UPGRADE_INSECURE_REQUESTS=true` liga o `upgrade-insecure-requests` da
 * CSP. Desligado por padrão porque o servidor embutido fala HTTP: num deploy
 * acessado por `http://IP:porta` a diretiva faria o navegador pedir os assets
 * em HTTPS numa porta sem TLS, e o painel abriria em branco. Quem está atrás
 * de um proxy com TLS (o caso do SaaS e do `install.sh` com domínio) liga.
 */
export function wantsUpgradeInsecureRequests(env = process.env) {
  return String(env.CSP_UPGRADE_INSECURE_REQUESTS || '').trim().toLowerCase() === 'true';
}
