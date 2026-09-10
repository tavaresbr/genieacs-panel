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
