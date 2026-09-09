import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import TenantUser from '../models/TenantUser.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

export const ROLES = Object.freeze(['admin', 'viewer']);

const BCRYPT_ROUNDS = 12;

/**
 * This screen is a provider's team, not the deployment's user list.
 *
 * Everything below reads and writes `tenant_users` for the provider the request
 * resolved to. A person (`users`) is global and may work for more than one
 * provider; what this controller may see and change is the MEMBERSHIP here.
 *
 * The scope comes from `req.tenantId`, which `resolveTenant` puts on every
 * `/api` request. When the access token starts carrying `tenantId`, the scope
 * arrives from the token instead and this line is the only thing that moves:
 * nothing below asks how the provider was decided.
 */
function tenantOf(req) {
  return req.tenantId;
}

function normalizeUsername(value) {
  return String(value ?? '').trim();
}

/**
 * Rows written before roles were manageable used the old default, and anything
 * that is not an administrator has read-only access. The backfilled memberships
 * carry that same old default, so the mapping applies to a membership role too.
 */
function presentRole(role) {
  return role === 'admin' ? 'admin' : 'viewer';
}

/**
 * The person, wearing the role they hold HERE.
 *
 * `users.role` is deliberately not read: somebody can own the ISP they founded
 * and be an ordinary operator at the one they consult for, and this endpoint
 * answers for one provider at a time.
 */
function present(member) {
  return {
    id: member.id,
    username: member.username,
    role: presentRole(member.role),
    createdAt: member.created_at,
    updatedAt: member.updated_at
  };
}

/**
 * Keeps the person's deployment-wide role usable while it is still what the
 * route guard reads, and drops their open sessions so a role change bites now.
 *
 * `users.role` is not the truth any more — the membership is — but until the
 * token carries the membership role, `requireRole` still reads the column, and
 * leaving it behind would let somebody demoted here keep administrator routes.
 * Mirroring is only honest while the person works for this provider alone: with
 * several memberships one column cannot hold both roles, and writing it would
 * let this provider change what that person may do at another one. So then the
 * column is left as it stands and only the sessions are revoked.
 */
async function applyRoleSideEffects(userId, role) {
  const memberships = await TenantUser.listForUser(userId);
  if (memberships.length <= 1) {
    await User.updateRole(userId, role);
    return;
  }
  await User.revokeSessions(userId);
}

class UsersController {
  static async list(req, res) {
    try {
      const members = await TenantUser.listForTenant(tenantOf(req));
      return res.json(createResponse('Users retrieved successfully', {
        users: members.map(present)
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
      const tenantId = tenantOf(req);
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

      // A username that is already taken is refused, whether the person works
      // here or for another provider entirely — and with the same words either
      // way, so the answer never says which.
      //
      // The tempting alternative is to attach the existing person to this
      // provider. It is wrong from this endpoint: the request carries a
      // PASSWORD, and there is exactly one password per person, so "create
      // maria" typed by this provider's admin would reset the password of a
      // stranger who works for somebody else, log her out everywhere
      // (`updatePassword` bumps `token_version`), and hand this admin working
      // credentials for another ISP's panel. Joining an existing person to a
      // second provider is a real act that needs that person's consent; it is
      // not the accidental outcome of guessing a username here.
      if (await User.findByUsername(username)) {
        return res.status(409).json(createErrorResponse('Username already taken'));
      }

      const id = await User.create({
        username,
        password: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role
      });
      try {
        await TenantUser.create({ tenantId, userId: id, role });
      } catch (error) {
        // The person was created only to be given this membership. Without it
        // they belong to nobody and no screen can reach them again, while their
        // username stays taken forever. Undoing is safe precisely here: the row
        // is seconds old and nothing points at it yet.
        await User.remove(id);
        throw error;
      }

      const created = await User.findById(id);
      return res.status(201).json(
        createResponse('Operator created successfully', {
          user: present({ ...created, role })
        })
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
      const tenantId = tenantOf(req);
      const id = Number(req.params?.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json(createErrorResponse('Invalid operator id'));
      }

      // Somebody who does not work here answers as nonexistent, never as
      // forbidden: "you may not touch this operator" would confirm to whoever
      // asked that the id belongs to a real person at another provider.
      const membership = await TenantUser.find(tenantId, id);
      const user = membership ? await User.findById(id) : null;
      if (!membership || !user) {
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
        // Losing the last administrator would leave THIS provider unmanageable.
        // Counted over the whole deployment, as it was before memberships
        // existed, this guard was wrong in both directions at once: another
        // ISP's administrators kept this one from demoting its last, and this
        // one's last could go while the count stayed positive on somebody
        // else's staff.
        //
        // Unreachable through this route as it stands, and kept on purpose:
        // `requireRole(['admin'])` means the caller is an administrator HERE,
        // so a target who is a different administrator makes the count two.
        // It is the invariant that matters, not the branch — the day a role
        // short of administrator may manage the team, this is what stops the
        // provider from being locked out, and nothing else would.
        if (presentRole(membership.role) === 'admin' && nextRole !== 'admin'
          && await TenantUser.countByRole(tenantId, 'admin') <= 1) {
          return res.status(409).json(
            createErrorResponse('The panel must keep at least one administrator')
          );
        }
        await TenantUser.setRole(tenantId, id, nextRole);
        await applyRoleSideEffects(id, nextRole);
      }

      if (nextPassword !== undefined) {
        const password = String(nextPassword);
        if (password.length < 8 || password.length > 128) {
          return res.status(400).json(
            createErrorResponse('Password must be between 8 and 128 characters')
          );
        }
        // A person has one password, for every provider they work for. Setting
        // it here for somebody who also works elsewhere would be this provider
        // handing itself a login at another one, so that is refused rather than
        // done quietly; the person changes their own password from their
        // profile, which reaches all of their providers at once and is theirs
        // to do.
        if ((await TenantUser.listForUser(id)).length > 1) {
          return res.status(409).json(
            createErrorResponse(
              'This operator also works for another provider; only they can change their password'
            )
          );
        }
        // updatePassword also revokes the operator's existing sessions.
        await User.updatePassword(id, await bcrypt.hash(password, BCRYPT_ROUNDS));
      }

      const updated = await User.findById(id);
      const current = await TenantUser.find(tenantId, id);
      return res.json(createResponse('Operator updated successfully', {
        user: present({ ...updated, role: current?.role })
      }));
    } catch (error) {
      console.error('Update user error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update the operator', error.message)
      );
    }
  }

  /**
   * Ends the membership. The person stays.
   *
   * They may work for another provider, and their name is on history that
   * points at `users.id` — who sent that message, who revoked that opt-out, who
   * created that campaign. Deleting the row would blank all of it (the foreign
   * keys are ON DELETE SET NULL) at another provider as well as here.
   */
  static async remove(req, res) {
    try {
      const tenantId = tenantOf(req);
      const id = Number(req.params?.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json(createErrorResponse('Invalid operator id'));
      }
      if (id === req.user.userId) {
        return res.status(409).json(
          createErrorResponse('You cannot delete the account you are signed in with')
        );
      }
      const membership = await TenantUser.find(tenantId, id);
      if (!membership) {
        return res.status(404).json(createErrorResponse('Operator not found'));
      }
      // Same invariant as the demotion above, and unreachable for the same
      // reason: the caller is an administrator here, so removing a different
      // one leaves at least themselves.
      if (presentRole(membership.role) === 'admin'
        && await TenantUser.countByRole(tenantId, 'admin') <= 1) {
        return res.status(409).json(
          createErrorResponse('The panel must keep at least one administrator')
        );
      }

      await TenantUser.remove(tenantId, id);
      // Their open sessions were sessions here. Revocation lives on the person,
      // so this signs them out of their other providers too — the blunt end of
      // one `token_version` per person, and the safe direction of the two.
      await User.revokeSessions(id);
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
