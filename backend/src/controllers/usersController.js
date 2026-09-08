import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

export const ROLES = Object.freeze(['admin', 'viewer']);

const BCRYPT_ROUNDS = 12;

function normalizeUsername(value) {
  return String(value ?? '').trim();
}

/**
 * Rows written before roles were manageable used the old default, and anything
 * that is not an administrator has read-only access.
 */
function presentRole(role) {
  return role === 'admin' ? 'admin' : 'viewer';
}

function present(user) {
  return {
    id: user.id,
    username: user.username,
    role: presentRole(user.role),
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

class UsersController {
  static async list(req, res) {
    try {
      const users = await User.list();
      return res.json(createResponse('Users retrieved successfully', {
        users: users.map(present)
      }));
    } catch (error) {
      console.error('List users error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to list operators', error.message)
      );
    }
  }

  static async create(req, res) {
    try {
      const username = normalizeUsername(req.body?.username);
      const password = String(req.body?.password ?? '');
      const role = presentRole(req.body?.role);

      if (username.length < 3 || username.length > 64) {
        return res.status(400).json(
          createErrorResponse('Username must be between 3 and 64 characters')
        );
      }
      if (password.length < 8 || password.length > 128) {
        return res.status(400).json(
          createErrorResponse('Password must be between 8 and 128 characters')
        );
      }
      if (!ROLES.includes(req.body?.role)) {
        return res.status(400).json(
          createErrorResponse(`Role must be one of: ${ROLES.join(', ')}`)
        );
      }
      if (await User.findByUsername(username)) {
        return res.status(409).json(createErrorResponse('Username already taken'));
      }

      const id = await User.create({
        username,
        password: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role
      });
      const created = await User.findById(id);
      return res.status(201).json(
        createResponse('Operator created successfully', { user: present(created) })
      );
    } catch (error) {
      console.error('Create user error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to create the operator', error.message)
      );
    }
  }

  static async update(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json(createErrorResponse('Invalid operator id'));
      }
      const user = await User.findById(id);
      if (!user) {
        return res.status(404).json(createErrorResponse('Operator not found'));
      }

      const nextRole = req.body?.role;
      const nextPassword = req.body?.password;
      if (nextRole === undefined && nextPassword === undefined) {
        return res.status(400).json(
          createErrorResponse('Provide a role, a password, or both')
        );
      }

      if (nextRole !== undefined) {
        if (!ROLES.includes(nextRole)) {
          return res.status(400).json(
            createErrorResponse(`Role must be one of: ${ROLES.join(', ')}`)
          );
        }
        if (id === req.user.userId && nextRole !== 'admin') {
          return res.status(409).json(
            createErrorResponse('You cannot remove your own administrator role')
          );
        }
        // Losing the last administrator would leave the panel unmanageable.
        if (presentRole(user.role) === 'admin' && nextRole !== 'admin'
          && await User.countByRole('admin') <= 1) {
          return res.status(409).json(
            createErrorResponse('The panel must keep at least one administrator')
          );
        }
        await User.updateRole(id, nextRole);
      }

      if (nextPassword !== undefined) {
        const password = String(nextPassword);
        if (password.length < 8 || password.length > 128) {
          return res.status(400).json(
            createErrorResponse('Password must be between 8 and 128 characters')
          );
        }
        // updatePassword also revokes the operator's existing sessions.
        await User.updatePassword(id, await bcrypt.hash(password, BCRYPT_ROUNDS));
      }

      return res.json(createResponse('Operator updated successfully', {
        user: present(await User.findById(id))
      }));
    } catch (error) {
      console.error('Update user error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update the operator', error.message)
      );
    }
  }

  static async remove(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json(createErrorResponse('Invalid operator id'));
      }
      if (id === req.user.userId) {
        return res.status(409).json(
          createErrorResponse('You cannot delete the account you are signed in with')
        );
      }
      const user = await User.findById(id);
      if (!user) {
        return res.status(404).json(createErrorResponse('Operator not found'));
      }
      if (presentRole(user.role) === 'admin' && await User.countByRole('admin') <= 1) {
        return res.status(409).json(
          createErrorResponse('The panel must keep at least one administrator')
        );
      }

      await User.remove(id);
      return res.json(createResponse('Operator deleted successfully', { id }));
    } catch (error) {
      console.error('Delete user error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to delete the operator', error.message)
      );
    }
  }
}

export default UsersController;
