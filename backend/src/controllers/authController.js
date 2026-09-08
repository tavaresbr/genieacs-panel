import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { generateTokens, verifyToken } from '../middleware/auth.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('skygenpanel-invalid-login-placeholder', 12);

class AuthController {
  static async login(req, res) {
    try {
      const { username, password } = req.body;
      
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
      
      const { accessToken, refreshToken } = generateTokens(user);
      
      return res.json(
        createResponse(req.t('auth.loginSuccess'), {
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
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
      const userId = await User.createInitialAdmin({
        username: normalizedUsername,
        password: hashedPassword
      });
      const user = { id: userId, username: normalizedUsername, role: 'admin' };

      const { accessToken, refreshToken } = generateTokens(user);

      return res.status(201).json(
        createResponse(req.t('auth.adminCreated'), {
          user: { id: userId, username: normalizedUsername, role: 'admin' },
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
          role: user.role,
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
      
      const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);
      
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
