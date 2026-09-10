import { getDb, closePool } from '../src/config/database.js';
import PlatformAdmin from '../src/models/PlatformAdmin.js';

/**
 * Hands the control plane to somebody on an install that already has users.
 *
 * The other bootstrap path is `setup`, which only exists for an install with no
 * users at all, so an existing deployment upgrading into the control plane has
 * no way in — and the migration deliberately promotes nobody. This is that way
 * in, and it is a shell script rather than a route on purpose: the person who
 * can run it is the person who holds the server, which is exactly who should be
 * deciding who may mint providers.
 *
 * It takes a username rather than an id because that is what the operator
 * knows, and it is read straight off `users` — outside any provider scope,
 * since a platform administrator is not a member of one. `--revoke` is here
 * because the same person who can grant this has to be able to take it back
 * without opening a SQL client.
 */
async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const revoke = args.includes('--revoke');
  const username = args.find((arg) => !arg.startsWith('--'));

  if (!username) {
    console.error('Usage: node scripts/grant-platform-admin.js <username> [--revoke]');
    process.exitCode = 1;
    return;
  }

  try {
    const db = getDb();
    const user = await db('users').where({ username }).first('id');
    if (!user) {
      console.error(`User "${username}" not found`);
      process.exitCode = 1;
      return;
    }

    if (revoke) {
      const removed = await PlatformAdmin.remove(user.id);
      console.log(removed
        ? `Platform administrator revoked from "${username}"`
        : `"${username}" was not a platform administrator`);
      return;
    }

    // Running it twice is not a mistake to punish: whoever holds the server
    // will run it again to check that it took. Saying which of the two
    // happened is the useful part, and neither is a failure.
    const added = await PlatformAdmin.add(user.id);
    console.log(added
      ? `Platform administrator granted to "${username}"`
      : `"${username}" is already a platform administrator`);
  } catch (error) {
    console.error('Platform administrator grant failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
