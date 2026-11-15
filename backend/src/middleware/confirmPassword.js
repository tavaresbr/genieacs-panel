import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import AccountLockout from '../models/AccountLockout.js';
import { createErrorResponse } from '../utils/helpers.js';

/**
 * Whether `password` is the signed-in person's own password.
 *
 * Counts on the SAME per-account lockout as the login and `changePassword`:
 * a password prompt behind a session is an oracle in the hands of whoever
 * holds only the token (a stolen session, an unlocked computer), and the
 * routes that ask for it each have their own limiter — together they would
 * let someone guess the password well past the login's ten tries. While the
 * account is locked the answer is `false` without looking at the password,
 * at the cost of one bcrypt, so the lock can't be used to test guesses. A
 * right password clears the count, so an admin who confirms often is not
 * locked out of their own login.
 */
export async function ownPasswordMatches(req, password, { via = 'confirm_password' } = {}) {
  if (typeof password !== 'string' || !password) return false;
  const user = await User.findById(req.user?.userId);
  if (!user?.password) return false;
  const tentativa = await AccountLockout.attempt(AccountLockout.forUser(user.id));
  if (!tentativa.allowed) {
    await AccountLockout.refuseQuietly(req, tentativa, password, { user, via });
    return false;
  }
  const ok = await bcrypt.compare(password.slice(0, 128), user.password);
  if (ok) await AccountLockout.clear(tentativa.subject);
  else await AccountLockout.failed(req, tentativa, { user, via });
  return ok;
}

/**
 * The person asks again with their own password before an action that costs
 * money or changes what the TeiaH integration does (the same check the factory
 * reset makes). `password` comes in the body; it is never logged or echoed.
 * 400 `password_required` without one, 403 `password_incorrect` when wrong.
 */
export function confirmOwnPassword(req, res, next) {
  const password = req.body?.password;
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ ...createErrorResponse(req.t('auth.confirmPasswordRequired')), code: 'password_required' });
  }
  return ownPasswordMatches(req, password).then((ok) => {
    if (!ok) {
      return res.status(403).json({ ...createErrorResponse(req.t('auth.confirmPasswordIncorrect')), code: 'password_incorrect' });
    }
    return next();
  }).catch(next);
}
