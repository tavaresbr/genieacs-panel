import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { TenantScopeError, runInTenant } = await import('../src/config/tenantContext.js');
const { tdb, tinsert, tinsertReturningId } = await import('../src/config/database.js');
const { SCOPED_TABLES } = await import('../src/config/tenantScope.js');

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Puts a table under scoping for the duration of one test.
 *
 * The real list is still empty, so without this there would be nothing to
 * exercise — and a mechanism nobody has run is not a mechanism. `customer_accounts`
 * is used because it already carries the column and the per-provider constraints.
 */
async function scoped(table, fn) {
  SCOPED_TABLES.add(table);
  try {
    return await fn();
  } finally {
    SCOPED_TABLES.delete(table);
  }
}

let alfa;
let beta;

before(async () => {
  await startTestServers();
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
});

after(async () => {
  await stopTestServers();
});

describe('a scoped table', () => {
  const account = (suffix) => ({
    customer_id: `CSG-SCOPE${suffix}-00000${suffix}`,
    device_id: `scope-dev-${suffix}`,
    identity_hash: String(suffix).repeat(64).slice(0, 64),
    software_id: 'V1',
    pppoe_username: `scope-${suffix}`,
    active: true
  });

  it('reads only the provider in scope', async () => {
    await scoped('customer_accounts', async () => {
      await runInTenant(alfa, () => tinsert('customer_accounts', account(1)));
      await runInTenant(beta, () => tinsert('customer_accounts', account(2)));

      const mine = await runInTenant(alfa, () => tdb('customer_accounts').select('device_id'));
      assert.deepEqual(mine.map((r) => r.device_id), ['scope-dev-1']);

      const theirs = await runInTenant(beta, () => tdb('customer_accounts').select('device_id'));
      assert.deepEqual(theirs.map((r) => r.device_id), ['scope-dev-2']);
    });
  });

  it('cannot be read at all without a provider in scope', async () => {
    await scoped('customer_accounts', async () => {
      assert.throws(() => tdb('customer_accounts'), TenantScopeError);
      assert.throws(() => tinsert('customer_accounts', account(3)), TenantScopeError);
    });
  });

  // knex ignores a where clause on an insert, so this would otherwise be an
  // unscoped write that looks entirely reasonable.
  it('refuses an insert through the query builder, pointing at tinsert', async () => {
    await scoped('customer_accounts', async () => {
      await runInTenant(alfa, () => {
        assert.throws(
          () => tdb('customer_accounts').insert(account(4)),
          /must go through tinsert/
        );
      });
    });
  });

  it('stamps the provider on every row written', async () => {
    await scoped('customer_accounts', async () => {
      const id = await runInTenant(beta, () => tinsertReturningId('customer_accounts', account(5)));
      const row = await getDb()('customer_accounts').where({ id }).first();
      assert.equal(Number(row.tenant_id), Number(beta));
    });
  });

  it('will not update or delete across providers', async () => {
    await scoped('customer_accounts', async () => {
      // Its own row rather than one left behind by an earlier test: a shared
      // fixture makes a failure here depend on what ran before it.
      const target = { ...account(6), device_id: 'scope-dev-target' };
      await runInTenant(alfa, () => tinsert('customer_accounts', target));

      const changed = await runInTenant(beta, () => tdb('customer_accounts')
        .where({ device_id: target.device_id })
        .update({ pppoe_username: 'stolen' }));
      assert.equal(changed, 0);

      const removed = await runInTenant(beta, () => tdb('customer_accounts')
        .where({ device_id: target.device_id })
        .del());
      assert.equal(removed, 0);

      const survivor = await getDb()('customer_accounts')
        .where({ device_id: target.device_id })
        .first();
      assert.ok(survivor, 'the row must still be there');
      assert.equal(survivor.pppoe_username, target.pppoe_username);
    });
  });
});

describe('the scoping guard', () => {
  function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }

  // The mechanism is only worth having if bypassing it is caught. Once a table
  // is converted, reaching it through the raw handle is how the filter gets
  // quietly lost again.
  it('finds no converted table reached through the raw database handle', () => {
    const allowed = new Set([
      // Copies the whole panel between databases; every row is its business.
      path.join(SRC, 'services', 'dbManagementService.js'),
      // The migration runner and the seed run before any provider exists.
      path.join(SRC, 'config', 'schema.js'),
      path.join(SRC, 'config', 'seed.js'),
      path.join(SRC, 'config', 'database.js')
    ]);

    const offences = [];
    for (const file of sourceFiles(SRC)) {
      if (allowed.has(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const table of SCOPED_TABLES) {
        const direct = new RegExp(`(getDb\\(\\)|\\bdb|\\btrx)\\(\\s*['"\`]${table}['"\`]`);
        if (direct.test(source)) {
          offences.push(`${path.relative(SRC, file)} reaches "${table}" directly`);
        }
      }
    }
    assert.deepEqual(offences, []);
  });
});
