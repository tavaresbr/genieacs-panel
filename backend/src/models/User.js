import { getDb, insertReturningId, tinsert } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';

class User {
  static async findByUsername(username) {
    return (await getDb()('users').where({ username }).first()) || null;
  }

  static async findById(id) {
    return (
      (await getDb()('users')
        .select('id', 'username', 'role', 'password', 'token_version', 'created_at', 'updated_at')
        .where({ id })
        .first()) || null
    );
  }

  static async count() {
    const row = await getDb()('users').count({ n: '*' }).first();
    return Number(row?.n || 0);
  }

  /**
   * A person and their membership at the provider doing the creating.
   *
   * The two go together because an operator created without one could not sign
   * in: the login resolves a membership and refuses when there is none. The
   * provider comes from the request's scope rather than from an argument —
   * whoever is adding staff is adding them to their own ISP, and there is no
   * call site that means anything else.
   *
   * `users.role` keeps the same value as the membership's, which is what the
   * migration's backfill reads and what an install still running the previous
   * code authorises with. The membership row is the one that counts from here.
   *
   * (Wave 12 lane B owns `/api/users` and may well move this into the
   * controller with the rest of the membership handling. It is here for now
   * because a person with no membership is not a half-created user, it is an
   * account nobody can use.)
   */
  static async create(userData) {
    const { username, password, role = 'viewer' } = userData;
    const tenantId = currentTenantId();

    return getDb().transaction(async (trx) => {
      const id = await insertReturningId('users', { username, password, role }, trx);
      await trx('tenant_users').insert({ tenant_id: tenantId, user_id: id, role });
      return id;
    });
  }

  static async list() {
    return getDb()('users')
      .select('id', 'username', 'role', 'created_at', 'updated_at')
      .orderBy('id', 'asc');
  }

  static async countByRole(role) {
    const row = await getDb()('users').where({ role }).count({ n: '*' }).first();
    return Number(row?.n || 0);
  }

  /**
   * Role changes revoke the user's sessions so the new role applies at once.
   *
   * Both rows move together. Authorisation reads the MEMBERSHIP's role now, so
   * writing only `users.role` would make a demotion look like it worked and
   * leave the person an administrator here — the one shape of bug where the
   * screen says the panel is safe and it is not. `users.role` is still written
   * for the reason it still exists: an install rolled back to the previous code
   * authorises from it.
   *
   * Only the membership at the provider in scope moves: demoting a consultant
   * here must not demote them at the ISP that is theirs.
   */
  static async updateRole(id, role) {
    const tenantId = currentTenantId();
    await getDb()('tenant_users')
      .where({ tenant_id: tenantId, user_id: id })
      .update({ role, updated_at: new Date() });
    await getDb()('users')
      .where({ id })
      .update({
        role,
        token_version: getDb().raw('token_version + 1'),
        updated_at: new Date()
      });
  }

  static async remove(id) {
    return getDb()('users').where({ id }).del();
  }

  /**
   * The first administrator of a provider, and their membership at it.
   *
   * Returns the membership as well as the id because the caller has to mint a
   * token for it, and because the two are one fact: an admin row without a
   * membership is a fresh install nobody can sign in to — right password,
   * refused login, no explanation on screen. It is the case that breaks first
   * if the two ever come apart, so they are written in the same transaction as
   * the setup latch: either this provider has a first admin who can sign in, or
   * it still needs setup.
   *
   * The provider is the request's, the same one `tinsert` files the latch
   * under. Setup is per provider since 0014, which is the semantics we want.
   */
  static async createInitialAdmin(userData) {
    const { username, password } = userData;
    const db = getDb();
    const tenantId = currentTenantId();

    return db.transaction(async (trx) => {
      const existing = await trx('users').count({ n: '*' }).first();
      if (Number(existing?.n || 0) > 0) {
        const error = new Error('Setup already completed');
        error.code = 'SETUP_COMPLETED';
        throw error;
      }

      try {
        // The collision IS the lock: two setups racing, only one row lands.
        // Per provider since 0014, which is the semantics we want — each
        // provider does its own first admin.
        await tinsert('app_state', { key: 'setup_completed', value: '1' }, trx);
      } catch (error) {
        if (
          error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
          error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          error.code === 'ER_DUP_ENTRY' ||
          // Postgres names neither code above. Without this the race answered a
          // raw 500 instead of "setup already completed" on the one dialect
          // added last — the same message fallback the rest of the codebase
          // uses for exactly this reason.
          /duplicate key|unique/i.test(error.message)
        ) {
          const setupError = new Error('Setup already completed');
          setupError.code = 'SETUP_COMPLETED';
          throw setupError;
        }
        throw error;
      }

      const id = await insertReturningId('users', {
        username,
        password,
        role: 'admin'
      }, trx);

      await trx('tenant_users').insert({ tenant_id: tenantId, user_id: id, role: 'admin' });

      return { id, tenantId, role: 'admin' };
    });
  }

  static async updatePassword(id, hashedPassword) {
    await getDb()('users')
      .where({ id })
      .update({
        password: hashedPassword,
        token_version: getDb().raw('token_version + 1'),
        updated_at: new Date()
      });
  }

  static async updateUsername(id, newUsername) {
    await getDb()('users')
      .where({ id })
      .update({ username: newUsername, updated_at: new Date() });
  }

  static async revokeSessions(id) {
    await getDb()('users')
      .where({ id })
      .update({
        token_version: getDb().raw('token_version + 1'),
        updated_at: new Date()
      });
  }
}

export default User;
