import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import TenantUser from '../models/TenantUser.js';
import PlatformAdmin from '../models/PlatformAdmin.js';
import { IS_SAAS } from '../config/edition.js';
import { generateTokens, resolveMembership, verifyToken } from '../middleware/auth.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('skygenpanel-invalid-login-placeholder', 12);

/**
 * Which provider this sign-in is for.
 *
 * `users` is the identity table and `username` is still global, so the password
 * answers "who is this"; `tenant_users` answers "and working for whom". A
 * consultant or a reseller with one login across several ISPs is the ordinary
 * arrangement in this market, so this can return more than one candidate and
 * has to choose — but never at random, and never invisibly:
 *
 *  - the caller may name the provider outright, in `tenantId`. That is the
 *    honest answer to ambiguity, and it is what a provider picker on the login
 *    screen will send. A `tenantId` for a provider the person does not work for
 *    resolves to nothing rather than falling back to another one, so a wrong
 *    guess never quietly signs somebody into the wrong ISP.
 *  - with nothing named, one membership is that membership.
 *  - with nothing named and several, it is the OLDEST membership — the provider
 *    they have worked for longest, which for a reseller is the one that is
 *    theirs and for everybody else is their only real employer. It is chosen by
 *    a rule rather than by whatever the database felt like returning first, it
 *    is stable across engines and restarts, and the response says which
 *    provider was picked so the choice is on screen rather than buried in a
 *    token. Switching provider is signing in again naming the other one.
 *
 * No membership returns null, and the caller must refuse the sign-in.
 */
async function membershipForLogin(userId, requestedTenantId) {
  if (requestedTenantId !== undefined && requestedTenantId !== null && requestedTenantId !== '') {
    const id = Number(requestedTenantId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return TenantUser.find(id, userId);
  }
  const memberships = await TenantUser.listForUser(userId);
  return memberships[0] || null;
}

/**
 * Whether this session also holds the control plane.
 *
 * Reported to the panel so it can decide whether to show the providers screen
 * at all. It has to be its own field because there is no role that implies it:
 * a provider's own administrator is `admin` too, so gating the screen on the
 * role would put a link in front of most of the panel's administrators pointing
 * at routes that answer them as if they did not exist.
 *
 * Read from `platform_admins` at request time, exactly as `requirePlatformAdmin`
 * reads it, and deliberately NOT carried in the token. It is a claim of record
 * — what to draw — and never authority: the guard re-reads the table anyway, so
 * a stale `true` here shows somebody a menu entry whose routes then refuse
 * them, which is a wrong screen rather than a breach. Putting it in the token
 * would make it look like the answer, and a claim nobody trusts is one somebody
 * eventually trusts by mistake.
 *
 * Always false on self-hosted, where there is no control plane to hold. That
 * lets the panel hide the screen without knowing which edition it is talking
 * to, and it means a stray roster row — an install that ran the grant script
 * and later moved to the self-hosted edition — cannot light up a menu whose
 * routes are not mounted.
 */
async function holdsControlPlane(userId) {
  if (!IS_SAAS) return false;
  return PlatformAdmin.has(userId);
}

class AuthController {
  static async login(req, res) {
    try {
      const { username, password, tenantId } = req.body;

      if (!username || !password) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.credentialsRequired'))
        );
      }
      const normalizedUsername = String(username).trim();
      if (
        normalizedUsername.length < 1 ||
        normalizedUsername.length > 64 ||
        String(password).length > 128
      ) {
        await bcrypt.compare(String(password).slice(0, 128), DUMMY_PASSWORD_HASH);
        return res.status(401).json(
          createErrorResponse(req.t('auth.invalidCredentials'))
        );
      }
      
      const user = await User.findByUsername(normalizedUsername);
      
      if (!user) {
        await bcrypt.compare(String(password), DUMMY_PASSWORD_HASH);
        return res.status(401).json(
          createErrorResponse(req.t('auth.invalidCredentials'))
        );
      }
      
      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        return res.status(401).json(
          createErrorResponse(req.t('auth.invalidCredentials'))
        );
      }

      // The host wins over the body. Where providers have subdomains, the
      // address the person typed is the provider they mean, and letting a
      // `tenantId` in the payload override it would mean the login screen of
      // one ISP mints a session for another — refused a moment later by the
      // host check in `authenticateToken`, but only after confirming to the
      // caller that the credentials are good for SOMEBODY.
      const membership = await membershipForLogin(
        user.id,
        req.hostTenantId ?? tenantId
      );

      // Somebody who works for nobody cannot sign in — there is no provider to
      // put the session in, and a session with no provider is the unscoped read
      // this whole mechanism exists to prevent. The refusal is the same status
      // and the same message as a wrong password, deliberately: telling the two
      // apart would confirm a valid username to whoever is trying them, and on
      // a deployment with several ISPs it would confirm which staff belong to
      // which one.
      if (!membership) {
        return res.status(401).json(
          createErrorResponse(req.t('auth.invalidCredentials'))
        );
      }

      const { accessToken, refreshToken } = generateTokens(user, membership);

      return res.json(
        createResponse(req.t('auth.loginSuccess'), {
          user: {
            id: user.id,
            username: user.username,
            // The membership's role, not `users.role`: it is what the token
            // carries and what the panel is about to gate its screens on, so
            // the two disagreeing would show an operator the buttons of an
            // administrator they are not, here.
            role: membership.role,
            tenantId: Number(membership.tenant_id),
            isPlatformAdmin: await holdsControlPlane(user.id),
            createdAt: user.created_at,
            updatedAt: user.updated_at
          },
          token: accessToken,
          refreshToken
        })
      );
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  static async getSetupStatus(req, res) {
    try {
      const count = await User.count();
      return res.json(
        createResponse(req.t('auth.setupStatusRetrieved'), { needsSetup: count === 0 })
      );
    } catch (error) {
      console.error('Setup status error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('auth.setupStatusFailed'), error.message)
      );
    }
  }

  static async setupAdmin(req, res) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.credentialsRequired'))
        );
      }

      const normalizedUsername = String(username).trim();
      if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.usernameLength'))
        );
      }

      if (String(password).length < 8 || String(password).length > 128) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.passwordLength'))
        );
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      // The person AND their membership, in one transaction. A first admin
      // without a membership would be a fresh install nobody can sign in to:
      // the account exists, the password is right, and the login refuses
      // because there is no provider to put the session in.
      const { id: userId, tenantId, role } = await User.createInitialAdmin({
        username: normalizedUsername,
        password: hashedPassword
      });
      const user = { id: userId, username: normalizedUsername };

      const { accessToken, refreshToken } = generateTokens(user, { tenant_id: tenantId, role });

      return res.status(201).json(
        createResponse(req.t('auth.adminCreated'), {
          user: {
            id: userId,
            username: normalizedUsername,
            role,
            tenantId,
            // Read back rather than assumed from the edition: setup is the one
            // place that WRITES the roster row, and the panel walks straight
            // into the session from here without asking again.
            isPlatformAdmin: await holdsControlPlane(userId)
          },
          token: accessToken,
          refreshToken
        })
      );
    } catch (error) {
      console.error('Setup admin error:', error);
      if (error.code === 'SETUP_COMPLETED') {
        return res.status(409).json(
          createErrorResponse(req.t('auth.setupAlreadyCompleted'))
        );
      }
      return res.status(500).json(
        createErrorResponse(req.t('auth.adminCreateFailed'), error.message)
      );
    }
  }

  static async getCurrentUser(req, res) {
    try {
      const userId = req.user.userId;
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse(req.t('auth.userNotFound'))
        );
      }
      
      return res.json(
        createResponse(req.t('auth.userRetrieved'), {
          id: user.id,
          username: user.username,
          // From the session rather than from the row, for the same reason the
          // login response reports it that way: this is the answer the panel
          // rebuilds its menus from after a page reload, and `users.role` is
          // not what this session is authorised with.
          role: req.user.role,
          tenantId: req.user.tenantId,
          isPlatformAdmin: await holdsControlPlane(user.id),
          createdAt: user.created_at,
          updatedAt: user.updated_at
        })
      );
    } catch (error) {
      console.error('Get current user error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  static async logout(req, res) {
    await User.revokeSessions(req.user.userId);
    return res.json(
      createResponse(req.t('auth.logoutSuccess'))
    );
  }

  static async refreshToken(req, res) {
    try {
      const { refreshToken } = req.body;
      
      if (!refreshToken) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.refreshTokenRequired'))
        );
      }
      if (typeof refreshToken !== 'string' || refreshToken.length > 4096) {
        return res.status(403).json(createErrorResponse(req.t('auth.invalidRefreshToken')));
      }
      
      const decoded = verifyToken(refreshToken);
      
      if (!decoded) {
        return res.status(403).json(
          createErrorResponse(req.t('auth.invalidRefreshToken'))
        );
      }
      
      if (!decoded.tokenType || decoded.tokenType !== 'refresh') {
        return res.status(403).json(
          createErrorResponse(req.t('auth.invalidTokenType'))
        );
      }
      
      const user = await User.findById(decoded.userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse(req.t('auth.userNotFound'))
        );
      }

      if (Number(user.token_version || 0) !== Number(decoded.tokenVersion || 0)) {
        return res.status(403).json(
          createErrorResponse(req.t('auth.refreshSessionInvalid'))
        );
      }

      // The same provider the session was already running in, re-read from the
      // table so a membership ended since the refresh token was minted ends the
      // session at its next hour rather than at its next week. A refresh token
      // from before this change names no provider and is resolved the same way
      // an old access token is: through the sole membership, or refused.
      const membership = await resolveMembership(user.id, decoded.tenantId);
      if (!membership) {
        return res.status(403).json(
          createErrorResponse(req.t('auth.refreshSessionInvalid'))
        );
      }

      const { accessToken, refreshToken: newRefreshToken } = generateTokens(user, membership);

      return res.json(
        createResponse(req.t('auth.tokenRefreshed'), {
          token: accessToken,
          refreshToken: newRefreshToken
        })
      );
    } catch (error) {
      console.error('Refresh token error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  static async changePassword(req, res) {
    try {
      const userId = req.user.userId;
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.passwordChangeRequired'))
        );
      }

      if (String(newPassword).length < 8 || String(newPassword).length > 128) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.newPasswordLength'))
        );
      }
      
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse(req.t('auth.userNotFound'))
        );
      }
      
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      
      if (!isMatch) {
        return res.status(401).json(
          createErrorResponse(req.t('auth.currentPasswordIncorrect'))
        );
      }
      
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await User.updatePassword(userId, hashedPassword);
      
      return res.json(
        createResponse(req.t('auth.passwordUpdated'))
      );
    } catch (error) {
      console.error('Change password error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  static async changeUsername(req, res) {
    try {
      const userId = req.user.userId;
      const { currentUsername, newUsername } = req.body;
      
      if (!currentUsername || !newUsername) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.usernameChangeRequired'))
        );
      }

      const normalizedUsername = String(newUsername).trim();
      if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.newUsernameLength'))
        );
      }
      
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse(req.t('auth.userNotFound'))
        );
      }
      
      if (user.username !== currentUsername) {
        return res.status(401).json(
          createErrorResponse(req.t('auth.currentUsernameIncorrect'))
        );
      }
      
      const existingUser = await User.findByUsername(normalizedUsername);
      
      if (existingUser) {
        return res.status(409).json(
          createErrorResponse(req.t('auth.usernameTaken'))
        );
      }
      
      await User.updateUsername(userId, normalizedUsername);
      
      return res.json(
        createResponse(req.t('auth.usernameUpdated'))
      );
    } catch (error) {
      console.error('Change username error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }
}

export default AuthController;
