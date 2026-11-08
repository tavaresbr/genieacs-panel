import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sem `JWT_SECRET`, o painel só sobe se disseram que é desenvolvimento ou teste.
 * Antes, sem `APP_ENV`/`NODE_ENV=production` ele caía num segredo constante de um
 * repositório público e assinava sessões de administrador com ele.
 */
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function boot(env) {
  return spawnSync(process.execPath, ['-e', "import('./src/middleware/auth.js').then(() => console.log('BOOT_OK'))"], {
    cwd: backend,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: 'utf8'
  });
}

describe('JWT_SECRET obrigatório fora de desenvolvimento declarado', () => {
  it('recusa subir sem JWT_SECRET e sem nenhuma variável de ambiente', () => {
    const r = boot({});
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /JWT_SECRET must be set/);
  });

  it('recusa em produção e em ambiente com nome qualquer', () => {
    assert.match(boot({ APP_ENV: 'production' }).stderr, /JWT_SECRET must be set/);
    assert.match(boot({ APP_ENV: 'staging' }).stderr, /JWT_SECRET must be set/);
  });

  it('sobe com APP_ENV=development ou test (segredo de desenvolvimento)', () => {
    assert.match(boot({ APP_ENV: 'development' }).stdout, /BOOT_OK/);
    assert.match(boot({ NODE_ENV: 'test' }).stdout, /BOOT_OK/);
  });

  it('sobe em qualquer ambiente quando o JWT_SECRET existe', () => {
    const segredo = 'x'.repeat(48);
    assert.match(boot({ JWT_SECRET: segredo, APP_ENV: 'staging' }).stdout, /BOOT_OK/);
  });
});
