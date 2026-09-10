import { getDb } from '../config/database.js';

/**
 * Who holds the control plane.
 *
 * Read OUTSIDE `tdb`, like `tenant_users` and for a sharper version of the same
 * reason. A platform administrator stands ABOVE providers: he is the one who
 * mints them, so filtering the roster by the provider a request happens to be
 * scoped to would be asking "is he a platform administrator *at* this ISP",
 * which is not a question this level has an answer to. There is no `tenant_id`
 * on the table for the same reason.
 *
 * The surface is deliberately four methods wide — is this person one, add one,
 * remove one, list them. The roster is an authority, not a resource; anything
 * richer would be the control-plane API, which belongs to the routes built on
 * top of this rather than here.
 */
class PlatformAdmin {
  /**
   * Whether this person holds the control plane, right now.
   *
   * The guard calls this on every request rather than trusting a claim minted
   * at sign-in, so it is a single indexed lookup on a unique column and returns
   * a boolean instead of the row: nothing above it needs anything but the
   * answer, and handing back a row invites somebody to authorise off a stale
   * copy of it.
   */
  static async has(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const row = await getDb()('platform_admins').where({ user_id: id }).first('id');
    return Boolean(row);
  }

  /**
   * Puts a person on the roster, and says whether that changed anything.
   *
   * Idempotent, because both callers want it to be: `setup` runs inside the
   * transaction that creates the first administrator, and the grant script is
   * run by hand by whoever holds the server — who will run it twice, on the
   * same install, to check that it took. Granting a grant already held is not
   * an error, so it answers false rather than throwing, and the caller can
   * still tell "added" from "already there" when it has something to print.
   *
   * The check-then-insert is not the guarantee; `user_id` is unique and that
   * is. Two greeters racing would have one of them land on the constraint, so
   * the duplicate is caught and reported the same way as the row already being
   * there — which is what it is.
   */
  static async add(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('PlatformAdmin.add needs the id of an existing person');
    }
    if (await PlatformAdmin.has(id)) return false;

    try {
      await getDb()('platform_admins').insert({ user_id: id });
      return true;
    } catch (error) {
      if (
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        error.code === 'ER_DUP_ENTRY' ||
        // Postgres names neither code above, so it is recognised by message —
        // the same fallback `User.createInitialAdmin` uses for the same reason.
        /duplicate key|unique/i.test(error.message)
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Takes a person off the roster, and says whether that changed anything.
   *
   * Not a delete of the person: the control plane is a hat somebody wears, and
   * taking it off has to leave them the operator account they still work with
   * at their own provider. Their sessions are deliberately NOT revoked — the
   * guard re-reads this table on every request, so the withdrawal bites at the
   * next one, and revoking would sign them out of the panel of the ISP they
   * work for over a change that has nothing to do with it.
   */
  static async remove(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const changed = await getDb()('platform_admins').where({ user_id: id }).del();
    return changed > 0;
  }

  /**
   * Everyone on the roster, with the person's name joined on.
   *
   * An unfiltered read of a whole table, which everywhere else in this codebase
   * is the shape of query that leaks one provider's rows to another. It is safe
   * here precisely because the table has no provider: the roster is one list for
   * the whole deployment, and the only caller allowed to ask has already passed
   * the guard.
   */
  static async list() {
    return getDb()('platform_admins')
      .join('users', 'users.id', 'platform_admins.user_id')
      .orderBy('users.username', 'asc')
      .select(
        'users.id',
        'users.username',
        'platform_admins.created_at'
      );
  }
}

export default PlatformAdmin;
