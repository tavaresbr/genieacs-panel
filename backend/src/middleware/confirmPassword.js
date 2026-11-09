import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { createErrorResponse } from '../utils/helpers.js';

/** Whether `password` is the signed-in person's own password. */
export async function ownPasswordMatches(req, password) {
  if (typeof password !== 'string' || !password) return false;
  const user = await User.findById(req.user?.userId);
  return Boolean(user?.password) && await bcrypt.compare(password.slice(0, 128), user.password);
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
