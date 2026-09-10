import { getDb, insertReturningId, tinsert } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';
import { IS_SAAS } from '../config/edition.js';

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
   * The person only. Their membership is the caller's to write.
   *
   * A person with no membership cannot sign in, so this is half of an act
   * rather than a whole one — but the other half belongs to `/api/users`, which
   * creates the membership straight after and deletes the person again if that
   * fails. Doing it here as well would insert the same row twice.
   */
  /**
   * `trx` opcional porque o aceite de convite cria a pessoa, consome o convite
   * e grava o vínculo como um ato só: se o convite já tiver sido usado entre um
   * passo e outro, a pessoa criada não pode sobrar no deploy com o nome tomado
   * e nenhum provedor a que pertencer.
   */
  static async create(userData, trx = null) {
    const { username, password, role = 'viewer' } = userData;
    const id = await insertReturningId('users', { username, password, role }, trx);
    return id;
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
   * The person's deployment-wide role, and a revocation so a change bites now.
   *
   * Not the role anything authorises with any more — that is the membership's,
   * and `/api/users` writes it through `TenantUser.setRole` before calling
   * here. This column is what the migration's backfill reads and what an
   * install rolled back to the previous code still authorises from, so it is
   * kept in step where keeping it in step is meaningful; the caller decides
   * when that is, because with two memberships one column cannot hold both.
   */
  static async updateRole(id, role) {
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

      // On the hosted edition the first administrator also gets the control
      // plane, because otherwise a SaaS deployment comes up with nobody able to
      // create the SECOND provider — the whole install would be one ISP with a
      // control plane no key opens. It is written in this transaction with the
      // other two rows for the reason they are: a first admin without it is the
      // failure nobody notices until the day they need a second provider.
      //
      // Never on self-hosted. There is one provider there and no control plane,
      // so the grant would be a role that should not exist on that install, and
      // an upgrade path that quietly promoted the local administrator to it is
      // exactly what the migration refuses to do. The edition is read from the
      // environment at import, so this is decided by how the install is
      // configured and not by anything the request can say.
      if (IS_SAAS) {
        await trx('platform_admins').insert({ user_id: id });
      }

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
