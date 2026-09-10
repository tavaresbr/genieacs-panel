import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A conexão vinda do ambiente, para a edição que roda de imagem contra um
 * Postgres gerenciado: `DATABASE_URL` vence o `db-config.json`.
 */
const { dbConfigFromEnv, buildKnexConfig } = await import('../src/config/dbConfig.js');

describe('DATABASE_URL', () => {
  it('is absent by default', () => {
    assert.equal(dbConfigFromEnv(''), null);
    assert.equal(dbConfigFromEnv(undefined), null);
  });

  it('reads a Postgres URL with schema, TLS and pool size', () => {
    const config = dbConfigFromEnv('postgres://sky%40gp:s%3Ecret@db.internal:6432/panel?schema=alfa&sslmode=require&pool=4');
    assert.deepEqual(config, {
      client: 'pg', host: 'db.internal', port: 6432, user: 'sky@gp', password: 's>cret',
      database: 'panel', schema: 'alfa', ssl: true, sslRejectUnauthorized: true, poolMax: 4
    });
    const knex = buildKnexConfig(config);
    assert.equal(knex.client, 'pg');
    assert.deepEqual(knex.searchPath, ['alfa']);
    assert.deepEqual(knex.connection.ssl, { rejectUnauthorized: true });
    assert.equal(knex.pool.max, 4);
  });

  it('keeps TLS on and drops verification only when told to', () => {
    assert.deepEqual(buildKnexConfig(dbConfigFromEnv('postgresql://u:p@h/d?sslmode=no-verify')).connection.ssl, { rejectUnauthorized: false });
    assert.equal(buildKnexConfig(dbConfigFromEnv('postgresql://u:p@h/d?sslmode=disable')).connection.ssl, false);
    assert.equal(buildKnexConfig(dbConfigFromEnv('postgresql://u:p@h/d')).connection.ssl, false);
  });

  it('reads a MySQL URL and ignores schema there', () => {
    const config = dbConfigFromEnv('mysql://root:pw@127.0.0.1/skygp?schema=ignored');
    assert.equal(config.client, 'mysql2');
    assert.equal(config.port, 3306);
    assert.equal(config.schema, undefined);
    assert.equal(buildKnexConfig(config).client, 'mysql2');
  });

  it('refuses what it cannot connect to, loudly', () => {
    assert.throws(() => dbConfigFromEnv('sqlite:///panel.db'), /postgres:\/\/ or mysql:\/\//);
    assert.throws(() => dbConfigFromEnv('postgres://u:p@h/'), /names no database/);
    assert.throws(() => dbConfigFromEnv('not a url'), /not a valid URL/);
  });
});
